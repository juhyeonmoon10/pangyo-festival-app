// In-memory PostgreSQL only: bulk booth status change and registering pre-registry NFC cards.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dep=path.join(process.env.PGLITE_DIR,'node_modules/@electric-sql/pglite/dist');
const {PGlite}=await import(pathToFileURL(path.join(dep,'index.js')));
const {pgcrypto}=await import(pathToFileURL(path.join(dep,'contrib/pgcrypto.js')));
const db=new PGlite({extensions:{pgcrypto}}),results=[];
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
async function rpc(a,sql,args=[],role='authenticated') {
  await db.exec('begin');
  try {
    await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:a.id,session_id:a.session,role})]);
    await db.exec(`set local role ${role}`);
    const row=(await db.query(sql,args)).rows[0];await db.exec('commit');return row?.value;
  } catch(e){await db.exec('rollback');throw e;}
}
const ops=(a,action,payload)=>rpc(a,'select public.festival_ops_write($1,$2,$3) value',[action,payload,randomUUID()]);
const bulk=(a,payload,id=randomUUID())=>rpc(a,'select public.festival_booth_status_bulk($1,$2) value',[payload,id]);
const tags=(a,action,payload={})=>rpc(a,'select public.festival_nfc_tag_admin($1,$2) value',[action,payload]);
async function account(admin=false){
  const a={id:randomUUID(),session:randomUUID()};
  await db.query(`insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data)
    values($1,$2,now(),'{"provider":"google"}','{"festival_name":"Synthetic","festival_student_number":"21001"}')`,[a.id,`${a.id}@example.invalid`]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[a.session,a.id]);
  a.uid=(await rpc(a,'select public.festival_nfc_profile() value')).id;
  if(admin) await db.query('update public.users set admin=true where id=$1',[a.uid]);return a;
}
async function test(name,fn){try{await fn();results.push({name,ok:true});console.log('PASS',name);}catch(e){results.push({name,ok:false,error:e.message});console.log('FAIL',name,e.message);}}
for(const f of ['nfc-server/isolated-test/shim.sql','nfc-server/install.sql','nfc-server/admin-issue.sql','nfc-server/updates/20260930-nonexpiring-tags.sql','nfc-server/reviews.sql','operations-server/install.sql','operations-server/review-identity.draft.sql','operations-server/reward-visits.sql','operations-server/reward-fixed-milestones.sql','operations-server/voucher-unlimited-and-reset.sql']) await db.exec(read(f));
const admin=await account(true),student=await account();
const event=(await ops(admin,'event_save',{name:'Synthetic bulk',state:'open',reviewPoints:10,version:0})).event;
const keys=(await db.query('select key from festival_ops.booths where event_id=$1 order by key collate "C"',[event.id])).rows.map(r=>r.key);
// Cards signed before the registry existed: none of them is listed yet.
const legacy=(await db.query("select festival_nfc_private.issue_tag('글빛누리',null) t")).rows[0].t;
for(const f of ['operations-server/nfc-tag-registry.sql','operations-server/claim-guard.sql']) await db.exec(read(f));
const statusOf=async list=>(await db.query('select key,status from festival_ops.booths where event_id=$1 and key=any($2) order by key collate "C"',[event.id,list])).rows.map(r=>r.status);

await test('bulk change sets one status on the selected booths only, in one step',async()=>{
  await db.exec(read('operations-server/booth-bulk-and-tag-register.sql'));
  const before=await statusOf(keys.slice(3));
  const r=await bulk(admin,{eventId:event.id,booths:keys.slice(0,3),status:'open'});
  assert.deepEqual(r,{status:'open',selected:3,changed:3});
  assert.deepEqual(await statusOf(keys.slice(0,3)),['open','open','open']);
  assert.deepEqual(await statusOf(keys.slice(3)),before,'unselected booths keep their status');
  assert.ok((await db.query('select bool_and(version>1) v from festival_ops.booths where key=any($1)',[keys.slice(0,3)])).rows[0].v,'versions advance');
});
await test('booths already in the status are counted but not changed; a retry replays',async()=>{
  const id=randomUUID();
  const r=await bulk(admin,{eventId:event.id,booths:keys.slice(0,5),status:'open'},id);
  assert.deepEqual(r,{status:'open',selected:5,changed:2});
  assert.deepEqual(await bulk(admin,{eventId:event.id,booths:keys.slice(0,5),status:'open'},id),r);
  await assert.rejects(bulk(admin,{eventId:event.id,booths:keys.slice(0,5),status:'closed'},id),/REQUEST_CONFLICT/);
  assert.equal((await db.query("select count(*)::int n from festival_ops.audit where action='booth_status_bulk'")).rows[0].n,2);
});
await test('invalid input changes nothing',async()=>{
  for(const bad of [{booths:[],status:'open'},{booths:keys.slice(0,1),status:'preparing'},{booths:'x',status:'open'},{status:'open'}])
    await assert.rejects(bulk(admin,{eventId:event.id,...bad}),/INVALID_INPUT/);
  await assert.rejects(bulk(admin,{eventId:event.id,booths:[keys[0],'없는부스'],status:'closed'}),/NOT_FOUND/);
  assert.equal((await statusOf([keys[0]]))[0],'open','a partly unknown list changes nothing');
  await assert.rejects(bulk(admin,{eventId:randomUUID(),booths:[keys[0]],status:'closed'}),/VERSION_CONFLICT/);
});
await test('only operators can change status in bulk',async()=>{
  await assert.rejects(bulk(student,{eventId:event.id,booths:[keys[0]],status:'closed'}),/ADMIN_REQUIRED/);
  await assert.rejects(rpc(admin,'select public.festival_booth_status_bulk($1,$2) value',[{},randomUUID()],'anon'),/permission denied/);
});
await test('an existing card is registered once with its memo and can then be managed',async()=>{
  assert.equal((await tags(admin,'list')).items.length,0);
  const r=await tags(admin,'register',{token:legacy,label:'정문 카드'});
  assert.equal(r.boothKey,'글빛누리');assert.equal(r.added,true);assert.match(r.id,/^[0-9a-f]{32}$/);
  assert.deepEqual(await tags(admin,'register',{token:legacy}),{...r,added:false});
  const [item]=(await tags(admin,'list')).items;
  assert.deepEqual([item.id,item.label,item.source,item.status,item.useCount],[r.id,'정문 카드','discovered','active',0]);
  assert.equal((await tags(admin,'url',{id:r.id})).token,legacy);
  await tags(admin,'revoke',{id:r.id});
  await assert.rejects(ops(student,'claim',{token:legacy}),/NFC_TAG_EXPIRED/);
  assert.equal((await db.query('select count(*)::int n from festival_ops.visits')).rows[0].n,0,'registering never earns a stamp');
  assert.equal((await db.query("select count(*)::int n from festival_ops.audit where action='nfc_tag_register'")).rows[0].n,1);
});
await test('forged, malformed or rotated cards are refused',async()=>{
  const [h,body,sig]=legacy.split('.');
  await assert.rejects(tags(admin,'register',{token:`${h}.${body}.${'0'.repeat(64)}`}),/NFC_TAG_INVALID/);
  await assert.rejects(tags(admin,'register',{token:'https://example.invalid'}),/NFC_TAG_INVALID/);
  await assert.rejects(tags(admin,'register',{}),/NFC_TAG_INVALID/);
  const fresh=(await db.query("select festival_nfc_private.issue_tag('매커니즘',null) t")).rows[0].t;
  await db.exec(`select vault.update_secret(id,(decrypted_secret::jsonb||jsonb_build_object('epoch',encode(extensions.gen_random_bytes(16),'hex')))::text) from vault.decrypted_secrets where name='pangyo_festival_nfc_v1'`);
  await assert.rejects(tags(admin,'register',{token:fresh}),/NFC_TAG_EXPIRED/);
  assert.equal(sig.length,64);
});
await test('students cannot register cards',async()=>{
  await assert.rejects(tags(student,'register',{token:legacy}),/ADMIN_REQUIRED/);
});
await test('rollback removes bulk change and registration, keeping registered cards',async()=>{
  await db.exec(read('operations-server/booth-bulk-and-tag-register-rollback.sql'));
  assert.equal((await db.query("select count(*)::int n from pg_proc where proname='festival_booth_status_bulk'")).rows[0].n,0);
  await assert.rejects(tags(admin,'register',{token:legacy}),/INVALID_INPUT/);
  assert.equal((await tags(admin,'list')).items.length,1);
  await db.exec(read('operations-server/booth-bulk-and-tag-register.sql'));
});
const failed=results.filter(r=>!r.ok);
console.log(`${results.length-failed.length}/${results.length} passed`);
if(failed.length) process.exitCode=1;
