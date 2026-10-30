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
const ops=(a,action,payload)=>rpc(a,'select public.festival_ops_write($1,$2,$3) value',[action,payload,randomUUID()]);
const reward=(a,action,payload)=>rpc(a,'select public.festival_reward_write($1,$2,$3) value',[action,payload,randomUUID()]);
const codeOf=(a,id)=>rpc(a,'select public.festival_voucher_code($1) value',[id]);
const check=(a,code)=>rpc(a,"select public.festival_voucher_redeem('check',$1) value",[{code}]);
const redeem=(a,code,id=randomUUID())=>rpc(a,"select public.festival_voucher_redeem('redeem',$1,$2) value",[{code},id]);
async function account(admin=false){
  const a={id:randomUUID(),session:randomUUID()};
  await db.query(`insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data)
    values($1,$2,now(),'{"provider":"google"}','{"festival_name":"Synthetic","festival_student_number":"21001"}')`,[a.id,`${a.id}@example.invalid`]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[a.session,a.id]);
  a.uid=(await rpc(a,'select public.festival_nfc_profile() value')).id;
  if(admin) await db.query('update public.users set admin=true where id=$1',[a.uid]);return a;
}
async function test(name,fn){try{await fn();results.push({name,ok:true});console.log('PASS',name);}catch(e){results.push({name,ok:false,error:e.message});console.log('FAIL',name,e.message);}}
for(const f of ['nfc-server/isolated-test/shim.sql','nfc-server/install.sql','nfc-server/admin-issue.sql','nfc-server/reviews.sql','operations-server/install.sql']) await db.exec(read(f));
const admin=await account(true),admin2=await account(true),student=await account(),other=await account(),late=await account();
const event=(await ops(admin,'event_save',{name:'Synthetic code test',state:'open',reviewPoints:10,version:0})).event;
for(const f of ['operations-server/review-identity.draft.sql','operations-server/reward-visits.sql','operations-server/reward-fixed-milestones.sql','operations-server/voucher-unlimited-and-reset.sql','operations-server/voucher-short-code.sql']) await db.exec(read(f));
const booths=(await db.query('select key from festival_ops.booths where event_id=$1 order by key collate "C" limit 3',[event.id])).rows.map(r=>r.key);
for(const booth of booths) await ops(admin,'booth_save',{booth,name:booth,floor:1,status:'open',version:1});
await reward(admin,'reward_config',{eventId:event.id,photoStock:null,foodStock:null,photoVersion:0,foodVersion:0,expiresAt:'infinity',enabled:true});
async function voucherFor(a,approver=admin){
  for(const booth of booths) await ops(approver,'visit_approve',{booth,userId:a.uid,reason:'Synthetic visit check'});
  await reward(a,'reward_choose',{eventId:event.id,kind:'photo',firstTarget:3});
  return (await one('select id from festival_ops.vouchers where user_id=$1',[a.uid])).id;
}
const vid=await voucherFor(student),otherVid=await voucherFor(other),ownVid=await voucherFor(admin2),lateVid=await voucherFor(late);
const stepCode=async(id,delta)=>(await one('select festival_ops.voucher_code(code_secret,festival_ops.voucher_step()+$2) c from festival_ops.vouchers where id=$1',[id,delta])).c;
const ALPHABET=/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/;

await test('anonymous and direct helper access are denied',async()=>{
  await assert.rejects(rpc(student,'select public.festival_voucher_code($1) value',[vid],'anon'),/permission denied/);
  await assert.rejects(rpc(student,"select festival_ops.voucher_code('\\x00'::bytea,1) value"),/permission denied/);
});
await test('an owner gets an 8-character code that is stable within the step',async()=>{
  const a=await codeOf(student,vid),b=await codeOf(student,vid);
  assert.match(a.code,ALPHABET);assert.equal(a.code,b.code);assert.equal(a.stepSeconds,30);
  assert.ok(new Date(a.validUntil)>new Date(a.serverTime));
  assert.equal((await one('select length(code_secret) n from festival_ops.vouchers where id=$1',[vid])).n,20);
  assert.equal(a.code,await stepCode(vid,0));
});
await test('another account cannot read a voucher code',async()=>{
  await assert.rejects(codeOf(other,vid),/NOT_FOUND/);
});
await test('codes change every step and differ between vouchers',async()=>{
  const codes=new Set();for(const d of [-2,-1,0,1,2]) codes.add(await stepCode(vid,d));
  assert.equal(codes.size,5);
  await codeOf(other,otherVid);
  assert.notEqual(await stepCode(otherVid,0),await stepCode(vid,0));
});
await test('the previous, current and next codes are accepted; two steps away are not',async()=>{
  const name=(await one('select name from public.users where id=$1',[student.uid])).name;
  for(const d of [-1,0,1]) {const r=await check(admin,await stepCode(vid,d));assert.equal(r.valid,true,`step ${d}`);assert.equal(r.title,'포토부스 이용권');assert.equal(r.participant,name);}
  for(const d of [-2,2]) await assert.rejects(check(admin,await stepCode(vid,d)),/VOUCHER_INVALID/);
});
await test('lowercase, spaces and hyphens are normalised; malformed codes are refused',async()=>{
  const c=await stepCode(vid,0);
  assert.equal((await check(admin,`${c.slice(0,4).toLowerCase()} - ${c.slice(4)}`)).valid,true);
  for(const bad of ['','ABC','ABCDEFG0','ABCDEFGHI','fv1.'+'0'.repeat(64)]) await assert.rejects(check(admin,bad),/VOUCHER_INVALID/);
});
await test('only operators can check or redeem',async()=>{
  await assert.rejects(check(student,await stepCode(vid,0)),/ADMIN_REQUIRED/);
  await assert.rejects(redeem(other,await stepCode(vid,0)),/ADMIN_REQUIRED/);
});
await test('an operator cannot redeem an own voucher',async()=>{
  await codeOf(admin2,ownVid);const c=await stepCode(ownVid,0);
  assert.equal((await check(admin2,c)).own,true);assert.equal((await check(admin2,c)).valid,false);
  await assert.rejects(redeem(admin2,c),/SELF_REDEMPTION/);
});
await test('redeeming marks the voucher used once and replays the same request',async()=>{
  const c=await stepCode(vid,1),id=randomUUID();
  const r=await redeem(admin,c,id);assert.equal(r.result,'REDEEMED');
  assert.deepEqual(await redeem(admin,c,id),r);
  await assert.rejects(redeem(admin,c),/VOUCHER_USED/);
  const s=await check(admin,await stepCode(vid,0));assert.equal(s.valid,false);assert.equal(s.state,'used');
  await assert.rejects(codeOf(student,vid),/VOUCHER_USED/);
  const row=await one('select state,redeemed_by from festival_ops.vouchers where id=$1',[vid]);
  assert.equal(row.state,'used');assert.equal(row.redeemed_by,admin.uid);
});
await test('a paused festival, a voided or an expired voucher cannot be redeemed',async()=>{
  const c=await stepCode(otherVid,0);
  await db.query("update festival_ops.events set state='paused' where id=$1",[event.id]);
  await assert.rejects(redeem(admin,c),/EVENT_CLOSED/);
  await db.query("update festival_ops.events set state='open' where id=$1",[event.id]);
  await ops(admin,'voucher_void',{id:otherVid,reason:'Synthetic void check'});
  await assert.rejects(redeem(admin,c),/VOUCHER_VOID/);
  await codeOf(late,lateVid);
  await db.query("update festival_ops.vouchers set expires_at=now()-interval '1 minute' where id=$1",[lateVid]);
  await assert.rejects(redeem(admin,await stepCode(lateVid,0)),/VOUCHER_EXPIRED/);
  await assert.rejects(codeOf(late,lateVid),/VOUCHER_EXPIRED/);
});
const out=path.join(root,'artifacts/voucher-short-code');fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,'isolated.json'),JSON.stringify(results,null,2));
const failed=results.filter(r=>!r.ok);
console.log(`${results.length-failed.length}/${results.length} passed`);
if(failed.length) process.exitCode=1;
