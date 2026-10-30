// In-memory PostgreSQL only: issued NFC tag management and the safeupdate-compatible reset.
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
const one=async(sql,args=[])=>(await db.query(sql,args)).rows[0];
const ops=(a,action,payload,id=randomUUID())=>rpc(a,'select public.festival_ops_write($1,$2,$3) value',[action,payload,id]);
const tags=(a,action,payload={})=>rpc(a,'select public.festival_nfc_tag_admin($1,$2) value',[action,payload]);
const reset=(a,payload,id=randomUUID())=>rpc(a,'select public.festival_ops_reset($1,$2) value',[payload,id]);
const claim=(a,token)=>ops(a,'claim',{token});
const list=async(a=admin)=>(await tags(a,'list')).items;
async function account(admin=false,name='Synthetic'){
  const a={id:randomUUID(),session:randomUUID()};
  await db.query(`insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data)
    values($1,$2,now(),'{"provider":"google"}',$3)`,[a.id,`${a.id}@example.invalid`,JSON.stringify({festival_name:name,festival_student_number:'21001'})]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[a.session,a.id]);
  a.uid=(await rpc(a,'select public.festival_nfc_profile() value')).id;
  if(admin) await db.query('update public.users set admin=true where id=$1',[a.uid]);return a;
}
async function test(name,fn){try{await fn();results.push({name,ok:true});console.log('PASS',name);}catch(e){results.push({name,ok:false,error:e.message});console.log('FAIL',name,e.message);}}
// pg_safeupdate (loaded for the shared DB's API roles) rejects DELETE/UPDATE without WHERE even
// inside functions. PGlite cannot load it, so every festival function body is checked instead.
async function unguardedWrites(){
  const rows=(await db.query(`select n.nspname||'.'||p.proname fn,p.prosrc src from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('festival_ops','festival_nfc_private') or (n.nspname='public' and p.proname like 'festival%')`)).rows;
  const found=[];
  for(const {fn,src} of rows) for(const part of src.replace(/--[^\n]*/g,'').split(';')) {
    const m=part.match(/\bdelete\s+from\s+[\w."]+/i) || part.match(/(?<!\bdo\s+)\bupdate\s+[\w."]+(?:\s+(?:as\s+)?\w+)?\s+set\b/i);
    if(m && !/\bwhere\b/i.test(part.slice(m.index))) found.push(`${fn}: ${m[0]}`);
  }
  return found;
}
for(const f of ['nfc-server/isolated-test/shim.sql','nfc-server/install.sql','nfc-server/admin-issue.sql','nfc-server/updates/20260930-nonexpiring-tags.sql','nfc-server/reviews.sql','operations-server/install.sql','operations-server/review-identity.draft.sql','operations-server/reward-visits.sql','operations-server/reward-fixed-milestones.sql','operations-server/voucher-unlimited-and-reset.sql']) await db.exec(read(f));
const admin=await account(true,'운영자'),student=await account(),other=await account(),third=await account();
const event=(await ops(admin,'event_save',{name:'Synthetic tag test',state:'open',reviewPoints:10,version:0})).event;
await ops(admin,'booth_save',{booth:'글빛누리',name:'글빛누리',floor:1,status:'open',version:1});
// A tag signed before the registry existed (same signer, no registry row).
const legacy=(await one("select festival_nfc_private.issue_tag('글빛누리',null) t")).t;
const before=await unguardedWrites();
const migration=read('operations-server/nfc-tag-registry.sql');

await test('the safeupdate check flags the old reset and passes after the migration',async()=>{
  assert.ok(before.some(x=>/festival_ops_reset: delete from public\.booth_ratings/.test(x)),before.join('\n'));
  assert.ok(before.some(x=>/festival_ops_reset: delete from festival_ops\.requests/.test(x)));
  await db.exec(migration);
  assert.deepEqual(await unguardedWrites(),[]);
});
let issued;
await test('an operator issues a tag with a memo and sees it in the list',async()=>{
  issued=await tags(admin,'issue',{booth:'글빛누리',label:' 정문 카드 '});
  assert.match(issued.token,/^nf1\./);assert.equal(issued.expiresAt,null);assert.equal(issued.validMinutes,null);assert.match(issued.tagId,/^[0-9a-f]{32}$/);
  const [item]=await list();
  assert.equal(item.id,issued.tagId);assert.equal(item.boothKey,'글빛누리');assert.equal(item.label,'정문 카드');
  assert.equal(item.status,'active');assert.equal(item.source,'issued');assert.equal(typeof item.issuerName,'string');assert.equal(item.useCount,0);
  assert.equal((await one("select count(*) n from festival_ops.audit where action='nfc_tag_issue' and reason='정문 카드'")).n,1);
});
await test('scans are counted and the address can be copied again',async()=>{
  assert.equal((await claim(student,issued.token)).result,'EARNED');
  assert.equal((await claim(student,issued.token)).result,'ALREADY_EARNED');
  const item=(await list()).find(x=>x.id===issued.tagId);
  assert.equal(item.useCount,2);assert.ok(item.lastUsedAt);
  assert.equal((await tags(admin,'url',{id:issued.tagId})).token,issued.token);
});
await test('a stopped tag cannot earn stamps or be copied; earned stamps stay',async()=>{
  await tags(admin,'revoke',{id:issued.tagId});
  await assert.rejects(claim(other,issued.token),/NFC_TAG_EXPIRED/);
  await assert.rejects(rpc(other,`select public.festival_nfc_claim('${issued.token}') value`),/NFC_TAG_EXPIRED/);
  await assert.rejects(tags(admin,'url',{id:issued.tagId}),/NFC_TAG_EXPIRED/);
  assert.equal((await list()).find(x=>x.id===issued.tagId).status,'revoked');
  assert.equal((await one('select count(*) n from festival_ops.visits where user_id=$1',[student.uid])).n,1);
  assert.equal((await one("select count(*) n from festival_ops.audit where action='nfc_tag_revoke'")).n,1);
});
await test('a restored tag works again and the memo can be changed',async()=>{
  await tags(admin,'restore',{id:issued.tagId});
  assert.equal((await claim(other,issued.token)).result,'EARNED');
  assert.equal((await tags(admin,'label',{id:issued.tagId,label:'후문 카드'})).label,'후문 카드');
  await assert.rejects(tags(admin,'label',{id:issued.tagId,label:'가'.repeat(41)}),/INVALID_INPUT/);
  await assert.rejects(tags(admin,'revoke',{id:'0'.repeat(32)}),/NOT_FOUND/);
});
await test('a tag issued before the registry appears on its first scan and can be stopped',async()=>{
  assert.equal((await claim(third,legacy)).result,'EARNED');
  const found=(await list()).find(x=>x.source==='discovered');
  assert.ok(found);assert.equal(found.useCount,1);assert.equal(found.issuedBy,null);assert.equal(found.status,'active');
  assert.equal((await tags(admin,'url',{id:found.id})).token,legacy);
  await tags(admin,'revoke',{id:found.id});
  await assert.rejects(claim(student,legacy),/NFC_TAG_EXPIRED/);
});
await test('the previous issue endpoint also registers its tags, finite ones with their expiry',async()=>{
  const finite=await rpc(admin,"select public.festival_nfc_admin_issue('글빛누리',60) value");
  const item=(await list()).find(x=>x.id===finite.tagId);
  assert.ok(item.expiresAt);assert.equal(item.status,'active');
  assert.equal((await list()).length,3);
  assert.equal((await tags(admin,'list',{booth:'없는부스'})).items.length,0);
});
await test('students and anonymous users cannot manage tags or read the registry',async()=>{
  await assert.rejects(tags(student,'list'),/ADMIN_REQUIRED/);
  await assert.rejects(tags(student,'url',{id:issued.tagId}),/ADMIN_REQUIRED/);
  await assert.rejects(rpc(student,"select public.festival_nfc_tag_admin('list','{}') value",[],'anon'),/permission denied/);
  await assert.rejects(rpc(student,'select count(*) value from festival_nfc_private.tags'),/permission denied/);
  await assert.rejects(rpc(student,"select festival_nfc_private.tag_register('x','{}','issued',1) value"),/permission denied/);
  await assert.rejects(tags(admin,'delete',{id:issued.tagId}),/INVALID_INPUT/);
});
await test('reset clears visits and scan counts, keeps tags and their stop state',async()=>{
  const r=await reset(admin,{eventId:event.id,confirm:'초기화',identities:true});
  assert.equal(r.reset,true);assert.ok(r.visits>=3);
  assert.equal((await one('select count(*) n from festival_ops.visits')).n,0);
  const items=await list();
  assert.equal(items.length,3);assert.ok(items.every(x=>x.useCount===0 && x.lastUsedAt===null));
  assert.equal(items.find(x=>x.source==='discovered').status,'revoked');
  assert.equal((await claim(student,issued.token)).result,'EARNED');
});
await test('epoch rotation expires every registered tag and blocks restore',async()=>{
  await db.exec(`select vault.update_secret(id,(decrypted_secret::jsonb||jsonb_build_object('epoch',encode(extensions.gen_random_bytes(16),'hex')))::text) from vault.decrypted_secrets where name='pangyo_festival_nfc_v1'`);
  const items=await list();
  assert.equal(items.find(x=>x.id===issued.tagId).status,'expired');
  await assert.rejects(tags(admin,'restore',{id:items.find(x=>x.source==='discovered').id}),/NFC_TAG_EXPIRED/);
  await assert.rejects(tags(admin,'url',{id:issued.tagId}),/NFC_TAG_EXPIRED/);
});
await test('rollback removes management, keeps a working reset and can be re-applied',async()=>{
  await db.exec(read('operations-server/nfc-tag-registry-rollback.sql'));
  assert.equal((await one("select to_regclass('festival_nfc_private.tags') t")).t,null);
  assert.equal((await one("select count(*) n from pg_proc where proname in ('festival_nfc_tag_admin','tag_register')")).n,0);
  assert.deepEqual(await unguardedWrites(),[]);
  const fresh=await rpc(admin,"select public.festival_nfc_admin_issue('글빛누리',null) value");
  assert.equal((await claim(other,fresh.token)).result,'EARNED');
  assert.equal((await reset(admin,{eventId:event.id,confirm:'초기화',identities:false})).reset,true);
  await db.exec(migration);
  assert.equal((await list()).length,0);
});
const out=path.join(root,'artifacts/nfc-tag-registry');fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,'isolated.json'),JSON.stringify(results,null,2));
const failed=results.filter(r=>!r.ok);
console.log(`${results.length-failed.length}/${results.length} passed`);
if(failed.length) process.exitCode=1;
