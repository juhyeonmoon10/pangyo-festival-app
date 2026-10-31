// Synthetic, in-memory PostgreSQL only. Never connects to the shared project.
// voucher-approval-and-manual-issue.sql: manual issue without limits; approval result with 학번 and time.
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
const event=(await ops(admin,'event_save',{name:'Synthetic approval event',state:'open',reviewPoints:10,version:0})).event;
for(const f of ['review-identity.draft','reward-visits','reward-fixed-milestones','voucher-unlimited-and-reset','review-identity-self','voucher-short-code','review-distribution-self-redeem','nfc-tag-registry','claim-guard','booth-bulk-and-tag-register','notices','operator-identity-and-scoped-reset','self-identity-and-own-club-stamps','student-number-display','student-number-only','operator-self-actions','sun-nfc','booth-managers','manual-voucher-issue','voucher-managers'])
  await sql(`operations-server/${f}.sql`);
const booths=(await db.query('select key from festival_ops.booths where event_id=$1 order by key collate "C" limit 6',[event.id])).rows.map(r=>r.key);
for(const booth of booths) await ops(admin,'booth_save',{booth,name:booth,status:'open',floor:1,version:1});
await reward(admin,'reward_config',{eventId:event.id,photoStock:null,foodStock:null,photoVersion:0,foodVersion:0,expiresAt:'infinity',enabled:true});
const rules=(await db.query('select id,reward_kind from festival_ops.rules where event_id=$1 and reward_kind is not null',[event.id])).rows;
const photo=rules.find(r=>r.reward_kind==='photo').id, food=rules.find(r=>r.reward_kind==='food').id;
const student=await account('21001'), walker=await account('21002');
const issue=(sid,ruleId)=>rpc(admin,'select public.festival_ops_write_student($1,$2,$3) value',['voucher_issue',{studentNumber:sid,ruleId,reason:'Synthetic manual voucher'},randomUUID()]);
const approve=(sid,booth)=>rpc(admin,'select public.festival_ops_write_student($1,$2,$3) value',['visit_approve',{studentNumber:sid,booth,reason:'Synthetic visit'},randomUUID()]);
const redeem=(a,action,code)=>rpc(a,'select public.festival_voucher_redeem($1,$2,$3) value',[action,{code},action==='redeem'?randomUUID():null]);
const codeOf=async id=>{
  await db.query('update festival_ops.vouchers set code_secret=coalesce(code_secret,extensions.gen_random_bytes(20)) where id=$1',[id]);
  return (await one('select festival_ops.voucher_code(code_secret,festival_ops.voucher_step()) c from festival_ops.vouchers where id=$1',[id])).c;
};
await sql('operations-server/voucher-approval-and-manual-issue.sql');

await test('the same voucher can be issued by hand again, beyond stock',async()=>{
  await db.query('update festival_ops.rules set stock=1 where id=$1',[photo]);
  const ids=[];
  for(let i=0;i<3;i++) ids.push((await issue('21001',photo)).id);
  assert.equal(new Set(ids).size,3);
  const mine=(await me(student)).vouchers.filter(v=>v.title==='포토부스 이용권');
  assert.equal(mine.length,3);
  assert.equal((await one('select count(*)::int n from festival_ops.vouchers where id=any($1) and manual_issue',[ids])).n,3);
  await db.query('update festival_ops.rules set stock=null where id=$1',[photo]);
});
await test('a disabled or expired rule is still refused',async()=>{
  await db.query('update festival_ops.rules set enabled=false where id=$1',[food]);
  await assert.rejects(issue('21001',food),/NOT_FOUND/);
  await db.query('update festival_ops.rules set enabled=true where id=$1',[food]);
});
await test('other untyped vouchers stay one per student and rule',async()=>{
  const legacy=(await one(`insert into festival_ops.rules(event_id,title,target,stock,enabled,expires_at) values($1,'Synthetic legacy',1,10,true,now()+interval '1 day') returning id`,[event.id])).id;
  await db.query("insert into festival_ops.vouchers(event_id,rule_id,user_id,title,expires_at) values($1,$2,$3,$4,now()+interval '1 day')",[event.id,legacy,student.uid,'Synthetic legacy']);
  await assert.rejects(db.query("insert into festival_ops.vouchers(event_id,rule_id,user_id,title,expires_at) values($1,$2,$3,$4,now()+interval '1 day')",[event.id,legacy,student.uid,'Synthetic legacy']),/legacy_voucher_per_rule/);
});
await test('approval returns the owner 학번 and the approval time',async()=>{
  const id=(await issue('21001',food)).id, code=await codeOf(id);
  const seen=await redeem(admin,'check',code);
  assert.equal(seen.studentNumber,'21001'); assert.equal(seen.valid,true);
  const before=Date.now();
  const done=await redeem(admin,'redeem',code);
  assert.equal(done.result,'REDEEMED'); assert.equal(done.studentNumber,'21001'); assert.equal(done.title,'푸드트럭 교환권'); assert.equal(done.kind,'food');
  assert.ok(Math.abs(new Date(done.redeemedAt)-before)<60000);
  assert.equal(new Date(done.redeemedAt).getTime(),new Date((await one('select redeemed_at from festival_ops.vouchers where id=$1',[id])).redeemed_at).getTime());
});
await test('rollback fails safely while duplicates exist, then restores the limit',async()=>{
  await assert.rejects(sql('operations-server/voucher-approval-and-manual-issue-rollback.sql'),/legacy_voucher_per_rule|duplicate|unique/i);
  await db.exec('rollback').catch(()=>{});
  assert.equal((await one("select count(*)::int n from information_schema.columns where table_schema='festival_ops' and table_name='vouchers' and column_name='manual_issue'")).n,1);
  const keep=(await db.query('select distinct on (user_id,rule_id) id from festival_ops.vouchers where manual_issue order by user_id,rule_id,created_at')).rows.map(r=>r.id);
  await db.query('delete from festival_ops.vouchers where manual_issue and not (id=any($1))',[keep]);
  await sql('operations-server/voucher-approval-and-manual-issue-rollback.sql');
  await assert.rejects(issue('21001',photo),/VOUCHER_ALREADY_ISSUED/);
  const other=await account('21004');
  const id=(await issue('21004',food)).id;
  const done=await redeem(admin,'redeem',await codeOf(id));
  assert.equal(done.result,'REDEEMED'); assert.equal(done.studentNumber,undefined);
});
console.log(JSON.stringify({passed:results.every(r=>r.ok),results}));
if(!results.every(r=>r.ok)) process.exitCode=1;
