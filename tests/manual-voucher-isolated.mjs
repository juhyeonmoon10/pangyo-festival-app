// Synthetic, in-memory PostgreSQL only. Never connects to the shared project.
// manual-voucher-issue.sql: a voucher issued by hand reaches the student; stamp rewards are unchanged.
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
const sql=f=>db.exec(fs.readFileSync(path.join(root,f),'utf8'));
const one=async(q,args=[])=>(await db.query(q,args)).rows[0];
async function rpc(a,q,args=[]) {
  await db.exec('begin');
  try {
    await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:a.id,session_id:a.session,role:'authenticated'})]);
    await db.exec('set local role authenticated');
    const row=await one(q,args); await db.exec('commit'); return row?.value;
  } catch(e) {await db.exec('rollback'); throw e;}
}
const ops=(a,action,payload)=>rpc(a,'select public.festival_ops_write($1,$2,$3) value',[action,payload,randomUUID()]);
const me=a=>rpc(a,"select public.festival_ops_read('me','{}'::jsonb) value");
const rewards=a=>rpc(a,'select public.festival_reward_read() value');
const reward=(a,action,payload)=>rpc(a,'select public.festival_reward_write($1,$2,$3) value',[action,payload,randomUUID()]);
async function account(sid,admin=false) {
  const a={id:randomUUID(),session:randomUUID()};
  await db.query(`insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data) values($1,$2,now(),'{"provider":"google"}',$3)`,[a.id,`${a.id}@example.invalid`,{festival_name:'Synthetic',festival_student_number:sid}]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[a.session,a.id]);
  a.uid=(await rpc(a,'select public.festival_nfc_profile() value')).id;
  if(admin) await db.query('update public.users set admin=true where id=$1',[a.uid]);
  return a;
}
async function test(name,fn) {try {await fn();results.push({name,ok:true});console.log('PASS',name);}catch(e){results.push({name,ok:false,error:e.message});console.log('FAIL',name,e.message);}}
for(const f of ['nfc-server/isolated-test/shim.sql','nfc-server/install.sql','nfc-server/admin-issue.sql','nfc-server/reviews.sql','operations-server/install.sql']) await sql(f);
const admin=await account('29999',true);
const event=(await ops(admin,'event_save',{name:'Synthetic manual voucher event',state:'open',reviewPoints:10,version:0})).event;
for(const f of ['review-identity.draft','reward-visits','reward-fixed-milestones','voucher-unlimited-and-reset','review-identity-self','voucher-short-code','review-distribution-self-redeem','nfc-tag-registry','claim-guard','booth-bulk-and-tag-register','notices','operator-identity-and-scoped-reset','self-identity-and-own-club-stamps','student-number-display','student-number-only','operator-self-actions'])
  await sql(`operations-server/${f}.sql`);
const booths=(await db.query('select key from festival_ops.booths where event_id=$1 order by key collate "C" limit 6',[event.id])).rows.map(r=>r.key);
for(const booth of booths) await ops(admin,'booth_save',{booth,name:booth,status:'open',floor:1,version:1});
await reward(admin,'reward_config',{eventId:event.id,photoStock:null,foodStock:null,photoVersion:0,foodVersion:0,expiresAt:'infinity',enabled:true});
const rules=(await db.query('select id,reward_kind from festival_ops.rules where event_id=$1 and reward_kind is not null',[event.id])).rows;
const photo=rules.find(r=>r.reward_kind==='photo').id, food=rules.find(r=>r.reward_kind==='food').id;
const student=await account('21001'), walker=await account('21002');
const issue=(sid,ruleId)=>rpc(admin,'select public.festival_ops_write_student($1,$2,$3) value',['voucher_issue',{studentNumber:sid,ruleId,reason:'Synthetic manual voucher'},randomUUID()]);
const approve=(sid,booth)=>rpc(admin,'select public.festival_ops_write_student($1,$2,$3) value',['visit_approve',{studentNumber:sid,booth,reason:'Synthetic visit'},randomUUID()]);

await test('before: a manual photo voucher creates nothing (the reported bug)',async()=>{
  await issue('21001',photo);
  assert.deepEqual((await me(student)).vouchers,[]);
});
await sql('operations-server/manual-voucher-issue.sql');
await test('a manual voucher reaches the student wallet',async()=>{
  const issued=await issue('21001',photo);
  const list=(await me(student)).vouchers;
  assert.equal(list.length,1); assert.equal(list[0].id,issued.id); assert.equal(list[0].title,'포토부스 이용권'); assert.equal(list[0].state,'available');
  await issue('21001',food);
  assert.equal((await me(student)).vouchers.length,2);
});
await test('the same voucher twice is refused with a clear error',async()=>{
  await assert.rejects(issue('21001',photo),/VOUCHER_ALREADY_ISSUED/);
  assert.equal((await me(student)).vouchers.length,2);
});
await test('manual vouchers are not stamp benefits; milestones still work',async()=>{
  const s=await rewards(student);
  assert.equal(s.issuedCount,0); assert.equal(s.firstChoice,null);
  for(const booth of booths.slice(0,3)) await approve('21002',booth);
  // Approving visits never creates a voucher by hand.
  assert.deepEqual((await me(walker)).vouchers,[]);
  await reward(walker,'reward_choose',{eventId:event.id,kind:'food',firstTarget:3});
  for(const booth of booths.slice(3,6)) await approve('21002',booth);
  const w=await rewards(walker);
  assert.equal(w.issuedCount,2); assert.equal((await me(walker)).vouchers.length,2);
});
await test('students cannot issue vouchers to themselves',async()=>{
  await assert.rejects(rpc(student,'select public.festival_ops_write_student($1,$2,$3) value',['voucher_issue',{studentNumber:'21001',ruleId:photo,reason:'Synthetic'},randomUUID()]),/ADMIN_REQUIRED/);
});
await test('rollback restores the previous functions and keeps vouchers',async()=>{
  await sql('operations-server/manual-voucher-issue-rollback.sql');
  assert.equal((await me(student)).vouchers.length,2);
  const other=await account('21003');
  await issue('21003',photo);
  assert.deepEqual((await me(other)).vouchers,[]);
  await sql('operations-server/manual-voucher-issue.sql');
  await issue('21003',photo);
  assert.equal((await me(other)).vouchers.length,1);
});
console.log(JSON.stringify({passed:results.every(r=>r.ok),results}));
if(!results.every(r=>r.ok)) process.exitCode=1;
