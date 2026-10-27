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
const ops=(a,action,payload,id=randomUUID())=>rpc(a,'select public.festival_ops_write($1,$2,$3) value',[action,payload,id]);
const get=(a,kind)=>rpc(a,'select public.festival_ops_read($1) value',[kind]);
const rewards=a=>rpc(a,'select public.festival_reward_read() value');
const reward=(a,action,payload,id=randomUUID())=>rpc(a,'select public.festival_reward_write($1,$2,$3) value',[action,payload,id]);
async function account(admin=false){
  const a={id:randomUUID(),session:randomUUID(),earned:0};
  await db.query(`insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data)
    values($1,$2,now(),'{"provider":"google"}','{"festival_name":"Synthetic","festival_student_number":"21001"}')`,[a.id,`${a.id}@example.invalid`]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[a.session,a.id]);
  a.uid=(await rpc(a,'select public.festival_nfc_profile() value')).id;
  if(admin) await db.query('update public.users set admin=true where id=$1',[a.uid]);return a;
}
async function test(name,fn){try{await fn();results.push({name,ok:true});console.log('PASS',name);}catch(e){results.push({name,ok:false,error:e.message});console.log('FAIL',name,e.message);}}
for(const f of ['nfc-server/isolated-test/shim.sql','nfc-server/install.sql','nfc-server/admin-issue.sql','nfc-server/reviews.sql','operations-server/install.sql','operations-server/review-identity.draft.sql','operations-server/reward-choice.draft.sql']) await db.exec(read(f));
const admin=await account(true),photo=await account(),food=await account(),late=await account(),stock=await account(),none=await account();
const event=(await ops(admin,'event_save',{name:'Synthetic reward test',state:'open',reviewPoints:10,version:0})).event;
const booths=(await get(admin,'catalog')).items.slice(0,18).map(b=>b.key);
for(const booth of booths) await ops(admin,'booth_save',{booth,name:booth,floor:1,status:'open',version:1});
for(const a of [photo,food,late,stock,none]) await rpc(admin,'select public.festival_review_identity_admin($1,$2) value',['save',{eventId:event.id,userId:a.uid,version:0,realName:'검증학생',boothKeys:[],verified:true,reason:'Synthetic school roster'}]);
async function earn(a,n){for(let i=a.earned;i<n;i++){await ops(admin,'visit_approve',{booth:booths[i],userId:a.uid,reason:'Synthetic visit check'});await ops(a,'review_save',{booth:booths[i],rating:5,content:''});a.earned++;}}
const choose=(a,kind,id=randomUUID(),firstTarget=3)=>reward(a,'reward_choose',{eventId:event.id,kind,firstTarget},id);
async function config(photoStock,foodStock){const s=await rewards(admin);return reward(admin,'reward_config',{eventId:event.id,photoStock,foodStock,photoVersion:s.options.find(o=>o.kind==='photo')?.version||0,foodVersion:s.options.find(o=>o.kind==='food')?.version||0,expiresAt:'2099-01-01T00:00:00Z'});}
const vouchers=a=>get(a,'me').then(m=>m.vouchers);
let legacy;
await test('unconfigured program stays unavailable',async()=>assert.equal((await rewards(photo)).ready,false));
await test('anonymous/direct access and student configuration denied',async()=>{
  await assert.rejects(rpc(photo,'select public.festival_reward_read() value',[],'anon'),/permission denied/);
  await assert.rejects(rpc(photo,"select festival_ops.award_choice($1,$2,'photo',$2,true) value",[event.id,photo.uid]),/permission denied/);
  await assert.rejects(reward(photo,'reward_config',{eventId:event.id}),/ADMIN_REQUIRED/);
});
await test('configuration creates only two rules and disables old automatic rules',async()=>{
  legacy=(await ops(admin,'rule_save',{title:'Old five',target:5,stock:20,enabled:true,expiresAt:'2099-01-01T00:00:00Z'})).id;
  const r=await config(10,10);assert.equal(r.ready,true);assert.equal(r.options.length,2);
  const rules=(await get(admin,'rules')).items;assert.equal(rules.find(x=>x.id===legacy).enabled,false);
});
await test('zero/two stamps and forged count or userId do not grant vouchers',async()=>{
  await assert.rejects(choose(photo,'photo'),/VISIT_REQUIRED/);await earn(photo,2);
  await assert.rejects(reward(photo,'reward_choose',{eventId:event.id,kind:'photo',firstTarget:3,count:999,userId:admin.uid}),/VISIT_REQUIRED/);
  assert.equal((await vouchers(photo)).length,0);
});
await test('three completed stamps wait for an explicit choice',async()=>{
  await earn(photo,3);assert.equal((await vouchers(photo)).length,0);
  assert.equal((await rewards(photo)).canChoose,true);
});
await test('old generic claim and manual issuance cannot pick the first benefit',async()=>{
  const id=(await rewards(photo)).options.find(o=>o.kind==='photo').ruleId;
  await ops(photo,'voucher_claim',{ruleId:id});await ops(admin,'voucher_issue',{ruleId:id,userId:photo.uid,reason:'Synthetic manual attempt'});
  assert.equal((await vouchers(photo)).length,0);
});
await test('photo choice is exactly once and locked against switching',async()=>{
  const id=randomUUID(),first=await choose(photo,'photo',id);assert.equal(first.firstChoice,'photo');
  assert.deepEqual(await choose(photo,'photo',id),first);
  await assert.rejects(choose(photo,'food',id),/REQUEST_CONFLICT/);
  await assert.rejects(choose(photo,'food'),/REWARD_CHOICE_LOCKED/);
  assert.deepEqual((await vouchers(photo)).map(v=>v.title),['포토부스 이용권']);
});
await test('first voucher remains chosen after use; sixth stamp grants only food',async()=>{
  const v=(await vouchers(photo))[0],qr=await ops(photo,'voucher_qr',{id:v.id});
  await ops(admin,'voucher_redeem',{token:qr.token});await earn(photo,5);assert.equal((await vouchers(photo)).length,1);
  await earn(photo,6);const all=await vouchers(photo);assert.equal(all.length,2);
  assert.equal(all.find(v=>v.title==='포토부스 이용권').state,'used');assert.equal(all.filter(v=>v.title==='푸드트럭 교환권').length,1);
});
await test('reverse selection yields food then photo even when first is voided',async()=>{
  await earn(food,3);await choose(food,'food');const v=(await vouchers(food))[0];
  await ops(admin,'voucher_void',{id:v.id,reason:'Synthetic cancellation'});await earn(food,6);
  assert.equal((await rewards(food)).firstTarget,9);assert.equal((await vouchers(food)).length,2);
  assert.equal((await vouchers(food)).filter(v=>v.title==='포토부스 이용권').length,1);
});
await test('late choice at six grants both distinct benefits once',async()=>{
  await earn(late,6);assert.equal((await vouchers(late)).length,0);
  await choose(late,'food');await choose(late,'food');assert.equal((await vouchers(late)).length,2);
});
await test('9/12/15/18 repeat with explicit choices and opposite automatic rewards',async()=>{
  await earn(photo,9);assert.equal((await vouchers(photo)).length,2);
  await choose(photo,'food',undefined,9);await choose(photo,'food',undefined,9);
  assert.equal((await vouchers(photo)).length,3);
  await assert.rejects(choose(photo,'photo',undefined,9),/REWARD_CHOICE_LOCKED/);
  await earn(photo,12);assert.equal((await vouchers(photo)).length,4);
  await earn(photo,15);await choose(photo,'photo',undefined,15);assert.equal((await vouchers(photo)).length,5);
  await earn(photo,18);assert.equal((await vouchers(photo)).length,6);
  const stages=(await db.query('select reward_stage from festival_ops.vouchers where user_id=$1 order by reward_stage',[photo.uid])).rows.map(r=>r.reward_stage);
  assert.deepEqual(stages,[3,6,9,12,15,18]);
  await choose(photo,'photo');assert.equal((await vouchers(photo)).length,6);
});
await test('late visits cannot skip unselected pairs or claim an unearned milestone',async()=>{
  await earn(none,12);
  await assert.rejects(choose(none,'photo',undefined,9),/REWARD_ORDER_REQUIRED/);
  await assert.rejects(choose(none,'photo',undefined,15),/VISIT_REQUIRED/);
  await choose(none,'food');await choose(none,'photo',undefined,9);
  assert.equal((await vouchers(none)).length,4);
  await assert.rejects(choose(none,'food',undefined,0),/INVALID_INPUT/);
  await assert.rejects(choose(none,'food',undefined,6),/INVALID_INPUT/);
});
await test('same stage with a different request ID still cannot duplicate',async()=>{
  await choose(none,'photo',undefined,9);await choose(none,'photo',undefined,9);
  assert.equal((await vouchers(none)).length,4);
  const id=randomUUID();await choose(none,'photo',id,9);
  await assert.rejects(choose(none,'food',id,3),/REQUEST_CONFLICT/);
});
await test('out-of-stock first choice never records a selection',async()=>{
  await earn(stock,6);const issued=(await db.query("select count(*)::int n from festival_ops.vouchers v join festival_ops.rules r on r.id=v.rule_id where r.reward_kind='photo'")).rows[0].n;
  await config(issued,10);await assert.rejects(choose(stock,'photo'),/OUT_OF_STOCK/);
  assert.equal((await rewards(stock)).firstChoice,null);
});
await test('stock shortage holds only remaining voucher; restock/retry completes it',async()=>{
  await choose(stock,'food');assert.equal((await vouchers(stock)).length,1);assert.equal((await rewards(stock)).secondIssued,false);
  await config(20,20);await choose(stock,'food');await choose(stock,'food');assert.equal((await vouchers(stock)).length,2);
});
await test('negative/insufficient stock, stale event, and bad choices rejected',async()=>{
  await assert.rejects(config(0,20),/INVALID_INPUT/);
  await assert.rejects(reward(photo,'reward_choose',{eventId:randomUUID(),kind:'photo'}),/VERSION_CONFLICT/);
  await assert.rejects(choose(photo,'cash'),/INVALID_INPUT/);
});
await test('pause blocks new choices and does not remove already-issued vouchers',async()=>{
  await ops(admin,'event_save',{name:event.name,state:'paused',reviewPoints:10,version:event.version});
  await assert.rejects(choose(stock,'food'),/EVENT_CLOSED/);assert.equal((await vouchers(stock)).length,2);
});
await test('existing untyped issued vouchers require an explicit migration',async()=>{
  await db.query("insert into festival_ops.vouchers(event_id,rule_id,user_id,title,expires_at) values($1,$2,$3,'Historical','2099-01-01')",[event.id,legacy,none.uid]);
  await assert.rejects(config(20,20),/REWARD_MIGRATION_REQUIRED/);
});
fs.mkdirSync(path.join(root,'artifacts/reward-choice'),{recursive:true});
fs.writeFileSync(path.join(root,'artifacts/reward-choice/isolated.json'),JSON.stringify({at:new Date().toISOString(),environment:'PGlite synthetic auth/Vault; real concurrent sessions unverified',results},null,2));
await db.close();console.log(`${results.filter(r=>r.ok).length}/${results.length} passed`);process.exitCode=results.some(r=>!r.ok)?1:0;
