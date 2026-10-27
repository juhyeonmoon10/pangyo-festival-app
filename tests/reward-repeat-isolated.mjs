// Synthetic PostgreSQL (PGlite) checks for operations-server/reward-repeat.draft.sql.
// Policy: a choice of photo/food at every 3 completed stamps (3, 6, 9, 12, ...).
// PGlite runs one connection with auth/Vault shims: this is NOT live Supabase or real concurrency proof.
// Run: PGLITE_DIR=<folder containing node_modules/@electric-sql/pglite> node tests/reward-repeat-isolated.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dep=path.join(process.env.PGLITE_DIR,'node_modules/@electric-sql/pglite/dist');
const {PGlite}=await import(pathToFileURL(path.join(dep,'index.js')));
const {pgcrypto}=await import(pathToFileURL(path.join(dep,'contrib/pgcrypto.js')));
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
const base=['nfc-server/isolated-test/shim.sql','nfc-server/install.sql','nfc-server/admin-issue.sql','nfc-server/reviews.sql','operations-server/install.sql','operations-server/review-identity.draft.sql'];
const DRAFT='operations-server/reward-repeat.draft.sql';
const db=new PGlite({extensions:{pgcrypto}}),results=[];
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

for(const f of base) await db.exec(read(f));
const admin=await account(true);
const event=(await ops(admin,'event_save',{name:'Synthetic repeat reward test',state:'open',reviewPoints:10,version:0})).event;
const allBooths=(await get(admin,'catalog')).items.map(b=>b.key);
const booths=allBooths.slice(0,15);
for(const booth of booths) await ops(admin,'booth_save',{booth,name:booth,floor:1,status:'open',version:1});
const legacyUser=await account();
async function identify(a){await rpc(admin,'select public.festival_review_identity_admin($1,$2) value',['save',{eventId:event.id,userId:a.uid,version:0,realName:'검증학생',boothKeys:[],verified:true,reason:'Synthetic school roster'}]);}
async function student(){const a=await account();await identify(a);return a;}
async function earn(a,n){for(let i=a.earned;i<n;i++){await ops(admin,'visit_approve',{booth:booths[i],userId:a.uid,reason:'Synthetic visit check'});await ops(a,'review_save',{booth:booths[i],rating:5,content:''});a.earned++;}}
const choose=(a,kind,stage,id=randomUUID())=>reward(a,'reward_choose',{eventId:event.id,kind,stage},id);
async function config(photoStock,foodStock){const s=await rewards(admin);return reward(admin,'reward_config',{eventId:event.id,photoStock,foodStock,photoVersion:s.options.find(o=>o.kind==='photo')?.version||0,foodVersion:s.options.find(o=>o.kind==='food')?.version||0,expiresAt:'2099-01-01T00:00:00Z'});}
const vouchers=a=>get(a,'me').then(m=>m.vouchers);
const typedCount=async a=>(await db.query('select count(*)::int n from festival_ops.vouchers where user_id=$1 and reward_stage is not null',[a.uid])).rows[0].n;
let legacyRule;

await test('fixture has enough booths for 12+ stamps',async()=>assert.ok(booths.length>=13,`only ${allBooths.length} catalog booths`));

await test('legacy untyped voucher issued BEFORE the draft is kept through apply',async()=>{
  await identify(legacyUser);
  legacyRule=(await ops(admin,'rule_save',{title:'Old one',target:1,stock:20,enabled:true,expiresAt:'2099-01-01T00:00:00Z'})).id;
  await ops(admin,'visit_approve',{booth:booths[0],userId:legacyUser.uid,reason:'Synthetic visit check'});
  await ops(legacyUser,'review_save',{booth:booths[0],rating:5,content:''});legacyUser.earned=1;
  assert.equal((await vouchers(legacyUser)).length,1);
  await db.exec(read(DRAFT));
  const v=await vouchers(legacyUser);assert.equal(v.length,1);assert.equal(v[0].title,'Old one');
});

await test('draft refuses to be applied twice',async()=>{
  await assert.rejects(db.exec(read(DRAFT)),/REWARD_DRAFT_ALREADY_APPLIED/);
  await db.exec('rollback').catch(()=>{});
});

await test('untyped vouchers stay one per rule per user after constraint swap',async()=>{
  const v=(await vouchers(legacyUser))[0];
  await assert.rejects(db.query("insert into festival_ops.vouchers(event_id,rule_id,user_id,title,expires_at) values($1,$2,$3,'dup','2099-01-01')",[event.id,legacyRule,legacyUser.uid]),/duplicate key/);
  assert.ok(v.id);
});

await test('existing untyped issued vouchers block configuration until a reviewed migration',async()=>{
  await assert.rejects(config(10,10),/REWARD_MIGRATION_REQUIRED/);
  // Synthetic stand-in for the separately approved migration so the remaining cases can run.
  await db.query("update festival_ops.vouchers set state='void' where rule_id=$1",[legacyRule]);
  await db.query('create temp table kept as select * from festival_ops.vouchers where rule_id=$1',[legacyRule]);
  await db.query('delete from festival_ops.vouchers where rule_id=$1',[legacyRule]);
});

await test('unconfigured program stays unavailable; anonymous/direct/student config denied',async()=>{
  const s=await student();
  assert.equal((await rewards(s)).ready,false);
  await assert.rejects(rpc(s,'select public.festival_reward_read() value',[],'anon'),/permission denied/);
  await assert.rejects(rpc(s,"select festival_ops.award_stage($1,$2,'photo',3,$2) value",[event.id,s.uid]),/permission denied/);
  await assert.rejects(reward(s,'reward_config',{eventId:event.id}),/ADMIN_REQUIRED/);
});

await test('configuration creates two typed rules and disables old automatic rules',async()=>{
  const r=await config(50,50);assert.equal(r.ready,true);assert.equal(r.version,3);assert.equal(r.options.length,2);
  const rules=(await get(admin,'rules')).items;assert.equal(rules.find(x=>x.id===legacyRule).enabled,false);
});

const A=await student(),B=await student(),C=await student(),S=await student(),P=await student(),D=await student();

await test('boundaries 0/2 stamps: nothing claimable, forged count/userId ignored',async()=>{
  await assert.rejects(choose(A,'photo',3),/VISIT_REQUIRED/);
  await earn(A,2);
  await assert.rejects(reward(A,'reward_choose',{eventId:event.id,kind:'photo',stage:3,count:999,userId:admin.uid}),/VISIT_REQUIRED/);
  const s=await rewards(A);assert.equal(s.canChoose,false);assert.equal(s.nextStage,3);assert.equal(s.pendingStages,0);
  assert.equal(await typedCount(A),0);
});

await test('3 stamps: explicit choice only (auto/claim/manual paths issue nothing)',async()=>{
  await earn(A,3);assert.equal(await typedCount(A),0);
  const s=await rewards(A);assert.equal(s.canChoose,true);assert.equal(s.pendingStages,1);
  const id=s.options.find(o=>o.kind==='photo').ruleId;
  await ops(A,'voucher_claim',{ruleId:id});
  await ops(admin,'voucher_issue',{ruleId:id,userId:A.uid,reason:'Synthetic manual attempt'});
  assert.equal(await typedCount(A),0);
});

await test('stage 3 choice is idempotent: same request replay, new request after lost response, rapid double tap',async()=>{
  const id=randomUUID(),first=await choose(A,'photo',3,id);
  assert.deepEqual(first.claimed.map(c=>[c.stage,c.kind]),[[3,'photo']]);
  assert.deepEqual(await choose(A,'photo',3,id),first);
  await assert.rejects(choose(A,'food',3,id),/REQUEST_CONFLICT/);
  await choose(A,'photo',3);await choose(A,'photo',3);
  assert.equal(await typedCount(A),1);
  await assert.rejects(choose(A,'food',3),/REWARD_CHOICE_LOCKED/);
});

await test('5 stamps: stage 6 locked; 6 stamps: the SAME kind may be chosen again',async()=>{
  await earn(A,5);await assert.rejects(choose(A,'photo',6),/VISIT_REQUIRED/);
  assert.equal((await rewards(A)).canChoose,false);
  await earn(A,6);const s=await choose(A,'photo',6);
  assert.deepEqual(s.claimed.map(c=>[c.stage,c.kind]),[[3,'photo'],[6,'photo']]);
  assert.equal((await vouchers(A)).filter(v=>v.title==='포토부스 이용권').length,2);
});

await test('8 stamps: stage 9 locked; 9 and 12 stamps continue granting (no max-2 cap)',async()=>{
  await earn(A,8);await assert.rejects(choose(A,'food',9),/VISIT_REQUIRED/);
  await earn(A,9);await choose(A,'food',9);
  await earn(A,12);const s=await choose(A,'photo',12);
  assert.deepEqual(s.claimed.map(c=>c.stage),[3,6,9,12]);assert.equal(s.nextStage,15);assert.equal(s.canChoose,false);
  assert.equal(await typedCount(A),4);
});

await test('stages are claimed in order; malformed stage values rejected',async()=>{
  await earn(B,9);
  const s=await rewards(B);assert.equal(s.pendingStages,3);assert.equal(s.nextStage,3);
  await assert.rejects(choose(B,'photo',6),/REWARD_STAGE_ORDER/);
  await assert.rejects(choose(B,'photo',4),/INVALID_INPUT/);
  await assert.rejects(choose(B,'photo','3'),/INVALID_INPUT/);
  await assert.rejects(reward(B,'reward_choose',{eventId:event.id,kind:'photo'}),/INVALID_INPUT/);
  await assert.rejects(choose(B,'cash',3),/INVALID_INPUT/);
  assert.equal(await typedCount(B),0);
});

await test('late claiming at 9 stamps grants exactly three, one per stage',async()=>{
  await choose(B,'food',3);await choose(B,'food',6);const s=await choose(B,'photo',9);
  assert.equal(s.pendingStages,0);assert.equal(await typedCount(B),3);
  await assert.rejects(choose(B,'photo',12),/VISIT_REQUIRED/);
});

await test('used and voided vouchers keep their stage; no replacement on re-request',async()=>{
  await earn(C,6);await choose(C,'photo',3);
  const v=(await vouchers(C)).find(x=>x.title==='포토부스 이용권'),qr=await ops(C,'voucher_qr',{id:v.id});
  await ops(admin,'voucher_redeem',{token:qr.token});
  await choose(C,'food',6);const f=(await vouchers(C)).find(x=>x.title==='푸드트럭 교환권');
  await ops(admin,'voucher_void',{id:f.id,reason:'Synthetic cancellation'});
  await choose(C,'photo',3);await choose(C,'food',6);
  await assert.rejects(choose(C,'photo',6),/REWARD_CHOICE_LOCKED/);
  const s=await rewards(C);assert.deepEqual(s.claimed.map(c=>c.state),['used','void']);assert.equal(await typedCount(C),2);
});

await test('DB backstop rejects a second voucher for the same stage',async()=>{
  const r=(await db.query("select id from festival_ops.rules where reward_kind='food'")).rows[0].id;
  await assert.rejects(db.query("insert into festival_ops.vouchers(event_id,rule_id,user_id,title,expires_at,reward_stage) values($1,$2,$3,'x','2099-01-01',3)",[event.id,r,C.uid]),/duplicate key/);
  await assert.rejects(db.query("insert into festival_ops.vouchers(event_id,rule_id,user_id,title,expires_at,reward_stage) values($1,$2,$3,'x','2099-01-01',4)",[event.id,r,C.uid]),/check constraint/);
});

await test('out of stock: no record, stage stays open, other kind or restock works',async()=>{
  await earn(S,6);
  const issued=(await rewards(admin)).options.find(o=>o.kind==='photo').issued;
  await config(issued,50);
  assert.equal((await rewards(S)).options.find(o=>o.kind==='photo').available,false);
  await assert.rejects(choose(S,'photo',3),/OUT_OF_STOCK/);
  assert.equal((await rewards(S)).nextStage,3);assert.equal(await typedCount(S),0);
  await choose(S,'food',3);
  await assert.rejects(choose(S,'photo',6),/OUT_OF_STOCK/);
  await config(issued+5,50);await choose(S,'photo',6);
  assert.deepEqual((await rewards(S)).claimed.map(c=>c.kind),['food','photo']);
});

await test('stock cannot be configured below already issued count',async()=>{
  const issued=(await rewards(admin)).options.find(o=>o.kind==='photo').issued;
  await assert.rejects(config(issued-1,50),/INVALID_INPUT/);
});

await test('expired reward kind is unavailable and records nothing',async()=>{
  await earn(P,3);
  await db.query("update festival_ops.rules set expires_at=now()-interval '1 minute' where reward_kind='photo'");
  await assert.rejects(choose(P,'photo',3),/OUT_OF_STOCK/);
  await db.query("update festival_ops.rules set expires_at='2099-01-01' where reward_kind='photo'");
  await choose(P,'photo',3);assert.equal(await typedCount(P),1);
});

await test('completed count dropping later keeps issued vouchers but blocks the next stage',async()=>{
  await earn(D,6);await choose(D,'food',3);
  await db.query('delete from festival_ops.reviews where ctid=(select ctid from festival_ops.reviews where user_id=$1 order by created_at desc limit 1)',[D.uid]);
  const s=await rewards(D);assert.equal(s.count,5);assert.equal(s.canChoose,false);
  await assert.rejects(choose(D,'food',6),/VISIT_REQUIRED/);assert.equal(await typedCount(D),1);
});

await test('pause blocks new choices and keeps issued vouchers',async()=>{
  const current=(await get(admin,'dashboard')).event||event;
  await ops(admin,'event_save',{name:event.name,state:'paused',reviewPoints:10,version:current.version??event.version});
  await assert.rejects(choose(D,'food',6),/EVENT_CLOSED/);
  assert.equal((await rewards(A)).canChoose,false);assert.equal(await typedCount(A),4);
});

await test('legacy untyped voucher coexists with typed ones and still blocks reconfiguration',async()=>{
  await db.query('insert into festival_ops.vouchers select * from kept');
  assert.equal((await vouchers(legacyUser)).length,1);
  await assert.rejects(config(60,60),/REWARD_MIGRATION_REQUIRED/);
  assert.equal(await typedCount(A),4);
});

await test('rollback block restores the original constraint when no typed voucher exists',async()=>{
  const fresh=new PGlite({extensions:{pgcrypto}});
  for(const f of base) await fresh.exec(read(f));
  await fresh.exec(read(DRAFT));
  const rollback=read(DRAFT).split('-- ROLLBACK')[1].split('\n').filter(l=>l.startsWith('-- ')||l.startsWith('--   ')).map(l=>l.replace(/^--\s?/,'')).filter(l=>!l.startsWith('restore')&&!l.startsWith('  -- restore')&&!l.startsWith('(only')).join('\n');
  await fresh.exec(rollback);
  await fresh.exec(read('operations-server/install.sql').match(/create function festival_ops\.award[\s\S]*?end \$\$;/)[0].replace('create function','create or replace function'));
  const cols=(await fresh.query("select count(*)::int n from information_schema.columns where table_schema='festival_ops' and column_name in ('reward_kind','reward_stage')")).rows[0].n;
  const uq=(await fresh.query("select count(*)::int n from pg_constraint where conrelid='festival_ops.vouchers'::regclass and contype='u'")).rows[0].n;
  assert.equal(cols,0);assert.equal(uq,1);
  await fresh.exec(read(DRAFT));
  await fresh.close();
});

fs.mkdirSync(path.join(root,'artifacts/reward-repeat'),{recursive:true});
fs.writeFileSync(path.join(root,'artifacts/reward-repeat/isolated.json'),JSON.stringify({at:new Date().toISOString(),environment:'PGlite synthetic auth/Vault; single connection; real Supabase and concurrent sessions unverified',results},null,2));
await db.close();console.log(`${results.filter(r=>r.ok).length}/${results.length} passed`);process.exitCode=results.some(r=>!r.ok)?1:0;
