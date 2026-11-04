// In-memory PostgreSQL only: operator notices and what participants can read.
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
const admin_=(a,action,payload={})=>rpc(a,'select public.festival_notice_admin($1,$2) value',[action,payload]);
const visible=a=>rpc(a,'select public.festival_notices() value').then(r=>r.items);
async function account(admin=false){
  const a={id:randomUUID(),session:randomUUID()};
  await db.query(`insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data)
    values($1,$2,now(),'{"provider":"google"}','{"festival_name":"운영자","festival_student_number":"21001"}')`,[a.id,`${a.id}@example.invalid`]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[a.session,a.id]);
  a.uid=(await rpc(a,'select public.festival_nfc_profile() value')).id;
  if(admin) await db.query('update public.users set admin=true where id=$1',[a.uid]);return a;
}
async function test(name,fn){try{await fn();results.push({name,ok:true});console.log('PASS',name);}catch(e){results.push({name,ok:false,error:e.message});console.log('FAIL',name,e.message);}}
for(const f of ['nfc-server/isolated-test/shim.sql','nfc-server/install.sql','nfc-server/admin-issue.sql','operations-server/install.sql']) await db.exec(read(f));
const admin=await account(true),student=await account();
await ops(admin,'event_save',{name:'Synthetic notices',state:'open',reviewPoints:10,version:0});
let first,second;
await test('an operator posts notices; participants see published ones, important first',async()=>{
  await db.exec(read('operations-server/notices.sql'));
  assert.deepEqual(await visible(student),[]);
  first=(await admin_(admin,'save',{title:' 개막 안내 ',body:'10시에 시작해요.',important:false,published:true})).id;
  second=(await admin_(admin,'save',{title:'우천 시 실내 진행',body:'',important:true,published:true})).id;
  await admin_(admin,'save',{title:'준비 중 초안',body:'',important:false,published:false});
  const items=await visible(student);
  assert.deepEqual(items.map(n=>[n.title,n.important]),[['우천 시 실내 진행',true],['개막 안내',false]]);
  assert.ok(items.every(n=>n.publishedAt && !('published' in n)));
  const list=(await admin_(admin,'list')).items;
  assert.equal(list.length,3);assert.equal(list.find(n=>n.title==='준비 중 초안').published,false);
  assert.equal(typeof list[0].author,'string');
});
await test('editing needs the current version; hiding removes it from participants',async()=>{
  await admin_(admin,'save',{id:first,title:'개막 안내 (변경)',body:'10시 30분에 시작해요.',important:false,published:true,version:1});
  await assert.rejects(admin_(admin,'save',{id:first,title:'x',body:'',important:false,published:true,version:1}),/VERSION_CONFLICT/);
  await admin_(admin,'save',{id:second,title:'우천 시 실내 진행',body:'',important:true,published:false,version:1});
  assert.deepEqual((await visible(student)).map(n=>n.title),['개막 안내 (변경)']);
});
await test('invalid notices are refused',async()=>{
  for(const bad of [{title:'',body:''},{title:'가'.repeat(81),body:''},{title:'x',body:'가'.repeat(1001)}])
    await assert.rejects(admin_(admin,'save',{...bad,important:false,published:true}),/INVALID_INPUT/);
  await assert.rejects(admin_(admin,'save',{title:'x',body:''}),/INVALID_INPUT/);
  await assert.rejects(admin_(admin,'save',{id:randomUUID(),title:'x',body:'',important:false,published:true,version:1}),/NOT_FOUND/);
});
await test('deleting needs the current version and is audited',async()=>{
  await assert.rejects(admin_(admin,'delete',{id:first,version:1}),/VERSION_CONFLICT/);
  await admin_(admin,'delete',{id:first,version:2});
  assert.deepEqual(await visible(student),[]);
  assert.equal((await admin_(admin,'list')).items.length,2);
  const actions=(await db.query("select action from festival_ops.audit where action like 'notice%' order by id")).rows.map(r=>r.action);
  assert.deepEqual(actions,['notice_create','notice_create','notice_create','notice_save','notice_save','notice_delete']);
});
await test('participants cannot manage notices; anonymous users cannot read them',async()=>{
  await assert.rejects(admin_(student,'list'),/ADMIN_REQUIRED/);
  await assert.rejects(admin_(student,'save',{title:'x',body:'',important:false,published:true}),/ADMIN_REQUIRED/);
  await assert.rejects(rpc(student,'select public.festival_notices() value',[],'anon'),/permission denied/);
  await assert.rejects(rpc(student,'select count(*) value from festival_ops.notices'),/permission denied/);
});
await test('rollback removes notices',async()=>{
  await db.exec(read('operations-server/notices-rollback.sql'));
  assert.equal((await db.query("select to_regclass('festival_ops.notices') t")).rows[0].t,null);
  await db.exec(read('operations-server/notices.sql'));
});
const failed=results.filter(r=>!r.ok);
console.log(`${results.length-failed.length}/${results.length} passed`);
if(failed.length) process.exitCode=1;
