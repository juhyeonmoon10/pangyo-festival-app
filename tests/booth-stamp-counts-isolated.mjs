// In-memory PostgreSQL only: per-booth stamp completion counts for the operator dashboard.
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
const counts=a=>rpc(a,'select public.festival_booth_stamp_counts() value');
async function account(admin=false){
  const a={id:randomUUID(),session:randomUUID()};
  await db.query(`insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data)
    values($1,$2,now(),'{"provider":"google"}','{"festival_name":"Synthetic","festival_student_number":"21001"}')`,[a.id,`${a.id}@example.invalid`]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[a.session,a.id]);
  a.uid=(await rpc(a,'select public.festival_nfc_profile() value')).id;
  if(admin) await db.query('update public.users set admin=true where id=$1',[a.uid]);return a;
}
async function test(name,fn){try{await fn();results.push({name,ok:true});console.log('PASS',name);}catch(e){results.push({name,ok:false,error:e.message});console.log('FAIL',name,e.message);}}
for(const f of ['nfc-server/isolated-test/shim.sql','nfc-server/install.sql','nfc-server/admin-issue.sql','nfc-server/updates/20260930-nonexpiring-tags.sql','operations-server/install.sql']) await db.exec(read(f));
const admin=await account(true),students=[await account(),await account(),await account()];
await test('before a festival exists the list is empty',async()=>{
  await db.exec(read('operations-server/booth-stamp-counts.sql'));
  assert.deepEqual(await counts(admin),{items:[]});
});
await ops(admin,'event_save',{name:'Synthetic counts',state:'open',reviewPoints:10,version:0});
for(const booth of ['글빛누리','매커니즘']) await ops(admin,'booth_save',{booth,name:booth,floor:1,status:'open',version:1});
await test('each booth counts distinct participants, split by NFC and manual approval',async()=>{
  const token=(await db.query("select festival_nfc_private.issue_tag('매커니즘',null) t")).rows[0].t;
  for(const s of students) await ops(s,'claim',{token});
  await ops(students[0],'claim',{token});
  await ops(admin,'visit_approve',{booth:'글빛누리',userId:students[0].uid,reason:'Synthetic visit check'});
  const {items}=await counts(admin);
  const total=(await db.query('select count(*)::int n from festival_ops.booths')).rows[0].n;
  assert.equal(items.length,total,'every booth is listed, including ones without stamps');
  assert.deepEqual(items.slice(0,2).map(x=>[x.booth,x.stamps,x.nfc,x.manual]),[['매커니즘',3,3,0],['글빛누리',1,0,1]]);
  assert.ok(items.slice(2).every(x=>x.stamps===0));
  assert.equal(items[0].status,'open');
});
await test('only operators can read the counts',async()=>{
  await assert.rejects(counts(students[0]),/ADMIN_REQUIRED/);
  await assert.rejects(rpc(admin,'select public.festival_booth_stamp_counts() value',[],'anon'),/permission denied/);
});
const failed=results.filter(r=>!r.ok);
console.log(`${results.length-failed.length}/${results.length} passed`);
if(failed.length) process.exitCode=1;
