// Synthetic, in-memory PostgreSQL only. Never connects to the shared project.
// account-delete.sql: an operator deletes a student's festival account; shared and other records stay.
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
const event=(await ops(admin,'event_save',{name:'Synthetic account delete event',state:'open',reviewPoints:10,version:0})).event;
for(const f of ['review-identity.draft','reward-visits','reward-fixed-milestones','voucher-unlimited-and-reset','review-identity-self','voucher-short-code','review-distribution-self-redeem','nfc-tag-registry','claim-guard','booth-bulk-and-tag-register','notices','operator-identity-and-scoped-reset','self-identity-and-own-club-stamps','student-number-display','student-number-only','operator-self-actions','sun-nfc','booth-managers','manual-voucher-issue','voucher-managers','voucher-approval-and-manual-issue','account-delete'])
  await sql(`operations-server/${f}.sql`);
const booths=(await db.query('select key from festival_ops.booths where event_id=$1 order by key collate "C" limit 6',[event.id])).rows.map(r=>r.key);
for(const booth of booths) await ops(admin,'booth_save',{booth,name:booth,status:'open',floor:1,version:1});
await reward(admin,'reward_config',{eventId:event.id,photoStock:null,foodStock:null,photoVersion:0,foodVersion:0,expiresAt:'infinity',enabled:true});
const rules=(await db.query('select id,reward_kind from festival_ops.rules where event_id=$1 and reward_kind is not null',[event.id])).rows;
const photo=rules.find(r=>r.reward_kind==='photo').id, food=rules.find(r=>r.reward_kind==='food').id;
const student=await account('21001'), walker=await account('21002');

const write=(a,action,payload)=>rpc(a,'select public.festival_ops_write_student($1,$2,$3) value',[action,payload,randomUUID()]);
const remove=(a,payload,request=randomUUID())=>rpc(a,'select public.festival_account_delete($1,$2) value',[payload,request]);
const count=async(table,col,id)=>(await one('select count(*)::int n from festival_ops.'+table+' where '+col+'=$1',[id])).n;
const record=(studentNumber,realName)=>({studentNumber,realName,clubs:['Synthetic Club'],boothKeys:[booths[5]],status:'ready',issues:[],sourceCells:['Synthetic!A1']});
await db.query('select festival_ops.import_review_roster($1,$2,$3)',[event.id,{format:1,sourceSha256:'c'.repeat(64),catalogKeys:(await db.query('select key from festival_ops.booths where event_id=$1 order by key collate "C"',[event.id])).rows.map(r=>r.key),
  records:[record('21001','Delete Me'),record('21002','Keep Me'),record('29999','Synthetic Admin')]},admin.uid]);
// The student to delete: profile name, identity link, stamps, a review, points, vouchers and a role.
await db.query(`update auth.users set raw_user_meta_data=raw_user_meta_data||'{"full_name":"21001Delete"}' where id=$1`,[student.id]);
await rpc(student,'select public.festival_review_identity_self($1,$2) value',['confirm',{eventId:event.id,realName:'Delete Me'}]);
await rpc(walker,'select public.festival_review_identity_self($1,$2) value',['confirm',{eventId:event.id,realName:'Keep Me'}]);
for(const who of ['21001','21002']) for(const booth of booths.slice(0,3)) await write(admin,'visit_approve',{studentNumber:who,booth,reason:'Synthetic visit'});
await db.query(`update festival_ops.visits set method='nfc' where user_id=$1 and booth_key=$2`,[student.uid,booths[0]]);
const legacy=(await one('select legacy_key from festival_ops.booths where event_id=$1 and key=$2',[event.id,booths[0]])).legacy_key;
if(legacy) await db.query('update public.users set completed_booths=array[$2::public.booth_enum] where id=$1',[student.uid,legacy]);
// The review trigger reads the author from the session, so each review is written as its student.
async function review(who,rating,content) {
  await db.exec('begin');
  await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:who.id,session_id:who.session,role:'authenticated'})]);
  await db.query('insert into festival_ops.reviews(event_id,user_id,booth_key,rating,content) values($1,$2,$3,$4,$5)',[event.id,who.uid,booths[1],rating,content]);
  await db.exec('commit');
}
await review(student,5,'Synthetic review');
await review(walker,4,'Kept review');
await write(admin,'points_adjust',{studentNumber:'21001',delta:30,reason:'Synthetic points'});
await write(admin,'voucher_issue',{studentNumber:'21001',ruleId:food,reason:'Synthetic voucher'});
await write(admin,'voucher_issue',{studentNumber:'21002',ruleId:food,reason:'Synthetic voucher'});
await rpc(admin,'select public.festival_voucher_manager_admin($1,$2) value',['grant',{account:{studentNumber:'21001'},kind:'photo'}]);
const base={studentNumber:'21001',confirm:'삭제',reason:'Synthetic duplicate account'};

await test('only operators delete, after typing 삭제, never themselves or another operator',async()=>{
  await assert.rejects(remove(walker,base),/ADMIN_REQUIRED/);
  await assert.rejects(remove(admin,{...base,confirm:'delete'}),/ACCOUNT_DELETE_CONFIRM_REQUIRED/);
  await assert.rejects(remove(admin,{...base,reason:'x'}),/INVALID_INPUT/);
  await assert.rejects(remove(admin,{...base,userId:student.uid}),/INVALID_INPUT/);
  await assert.rejects(remove(admin,{...base,studentNumber:'29999'}),/ACCOUNT_DELETE_SELF/);
  await account('29998',true);
  await assert.rejects(remove(admin,{...base,studentNumber:'29998'}),/ACCOUNT_DELETE_OPERATOR/);
  assert.equal(await count('visits','user_id',student.uid),3);
});
await test('deleting removes the festival account and signs the student out',async()=>{
  const request=randomUUID();
  const done=await remove(admin,base,request);
  assert.equal(done.deleted,true); assert.equal(done.studentNumber,'21001');
  assert.deepEqual([done.visits,done.vouchers,done.reviews,done.points,done.identity,done.roles,done.signedOut],[3,1,1,1,true,1,true]);
  for(const [table,col] of [['visits','user_id'],['vouchers','user_id'],['reviews','user_id'],['ledger','user_id'],['review_identities','user_id'],['voucher_managers','user_id'],['requests','actor_id']])
    assert.equal(await count(table,col,student.uid),0,table);
  if(legacy) assert.equal((await one('select coalesce(cardinality(completed_booths),0) n from public.users where id=$1',[student.uid])).n,0);
  // The shared account row and unrelated Google metadata stay; the festival registration is gone.
  assert.equal((await one('select count(*)::int n from public.users where id=$1',[student.uid])).n,1);
  const meta=(await one('select raw_user_meta_data m from auth.users where id=$1',[student.id])).m;
  assert.equal(meta.festival_name,undefined); assert.equal(meta.festival_student_number,undefined); assert.equal(meta.full_name,'21001Delete');
  assert.equal((await one('select count(*)::int n from auth.sessions where user_id=$1',[student.id])).n,0);
  await assert.rejects(rpc(student,'select public.festival_nfc_profile() value'),/GOOGLE_AUTH_REQUIRED/);
  // Other students keep everything.
  assert.deepEqual([await count('visits','user_id',walker.uid),await count('vouchers','user_id',walker.uid),await count('reviews','user_id',walker.uid),await count('review_identities','user_id',walker.uid)],[3,1,1,1]);
  const audit=await one(`select actor_id,target,reason from festival_ops.audit where action='account_delete'`);
  assert.equal(audit.actor_id,admin.uid); assert.equal(audit.target,String(student.uid)); assert.match(audit.reason,/^21001 · Synthetic duplicate account/);
  // A retry of the same request answers the same result without deleting again.
  assert.deepEqual(await remove(admin,base,request),done);
});
await test('the student signs in again as a new participant',async()=>{
  student.session=randomUUID();
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[student.session,student.id]);
  const again=await rpc(student,'select public.festival_nfc_profile() value');
  assert.equal(again.needsProfile,true); assert.equal(again.studentNumber,''); assert.equal(again.id,student.uid);
  await assert.rejects(remove(admin,base),/STUDENT_NOT_FOUND/);
});
await test('accounts sharing a 학번 are told apart by Google email',async()=>{
  const a=await account('21005'), b=await account('21005');
  await assert.rejects(remove(admin,{...base,studentNumber:'21005'}),/STUDENT_AMBIGUOUS/);
  const mail=(await one('select email from auth.users where id=$1',[b.id])).email;
  assert.equal((await remove(admin,{...base,studentNumber:'21005',email:mail})).deleted,true);
  assert.equal((await rpc(a,'select public.festival_nfc_profile() value')).studentNumber,'21005');
  await assert.rejects(rpc(b,'select public.festival_nfc_profile() value'),/GOOGLE_AUTH_REQUIRED/);
});
await test('rollback removes the function',async()=>{
  await sql('operations-server/account-delete-rollback.sql');
  await assert.rejects(remove(admin,{...base,studentNumber:'21002'}),/does not exist/);
  assert.equal(await count('visits','user_id',walker.uid),3);
});
console.log(JSON.stringify({passed:results.every(r=>r.ok),results}));
if(!results.every(r=>r.ok)) process.exitCode=1;
