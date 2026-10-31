// Synthetic, in-memory PostgreSQL only. Never connects to the shared project.
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
async function rpc(a,q,args=[],role='authenticated') {
  await db.exec('begin');
  try {
    await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:a.id,session_id:a.session,role})]);
    await db.exec(`set local role ${role}`);
    const row=await one(q,args); await db.exec('commit'); return row?.value;
  } catch(e) {await db.exec('rollback'); throw e;}
}
const ops=(a,action,payload)=>rpc(a,'select public.festival_ops_write($1,$2,$3) value',[action,payload,randomUUID()]);
const voucher=(a,action,payload={})=>rpc(a,'select public.festival_voucher_redeem($1,$2,$3) value',[action,payload,action==='redeem'?randomUUID():null]);
const grant=(action,payload)=>rpc(admin,'select public.festival_voucher_manager_admin($1,$2) value',[action,payload]);
async function account(sid,isAdmin=false) {
  const a={id:randomUUID(),session:randomUUID()};
  await db.query(`insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data) values($1,$2,now(),'{"provider":"google"}',$3)`,[a.id,`${a.id}@example.invalid`,{festival_name:`Synthetic ${sid}`,festival_student_number:sid}]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[a.session,a.id]);
  a.uid=(await rpc(a,'select public.festival_nfc_profile() value')).id;
  if(isAdmin) await db.query('update public.users set admin=true where id=$1',[a.uid]);
  return a;
}
async function test(name,fn) {try {await fn();results.push({name,ok:true});console.log('PASS',name);}catch(e){results.push({name,ok:false,error:e.message});console.log('FAIL',name,e.message);}}

for(const f of ['nfc-server/isolated-test/shim.sql','nfc-server/install.sql','nfc-server/admin-issue.sql','nfc-server/updates/20260930-nonexpiring-tags.sql','nfc-server/reviews.sql','operations-server/install.sql']) await sql(f);
const admin=await account('29999',true);
const event=(await ops(admin,'event_save',{name:'Synthetic voucher event',state:'open',reviewPoints:10,version:0})).event;
for(const f of ['review-identity.draft','reward-visits','reward-fixed-milestones','voucher-unlimited-and-reset','review-identity-self','voucher-short-code','review-distribution-self-redeem','nfc-tag-registry','claim-guard','booth-bulk-and-tag-register','notices','operator-identity-and-scoped-reset','self-identity-and-own-club-stamps','student-number-display','student-number-only','operator-self-actions','sun-nfc','booth-managers','manual-voucher-issue']) await sql(`operations-server/${f}.sql`);
const catalog=(await db.query('select key from festival_ops.booths where event_id=$1 order by key collate "C"',[event.id])).rows.map(r=>r.key);
const record=(studentNumber,realName,boothKeys)=>({studentNumber,realName,clubs:['Synthetic Club'],boothKeys,status:'ready',issues:[],sourceCells:['Synthetic!A1']});
await db.query('select festival_ops.import_review_roster($1,$2,$3)',[event.id,{format:1,sourceSha256:'f'.repeat(64),catalogKeys:catalog,
  records:[record('11001','Food Lead',[]),record('11002','Photo Lead',[]),record('11003','Not Confirmed',[]),record('29999','Synthetic Admin',[])]},admin.uid]);
const food=await account('11001'),photo=await account('11002'),unverified=await account('11003'),owner=await account('21001');
for(const [a,name] of [[food,'Food Lead'],[photo,'Photo Lead']]) await rpc(a,'select public.festival_review_identity_self($1,$2) value',['confirm',{eventId:event.id,realName:name}]);
await sql('operations-server/voucher-managers.sql');

// Vouchers are made directly: one food rule, one photo rule, and an untyped legacy rule.
const rules={};
for(const kind of ['food','photo',null]) rules[kind]=(await one(`insert into festival_ops.rules(event_id,title,target,stock,enabled,expires_at,reward_kind)
  values($1,$2,3,100,true,now()+interval '1 day',$3) returning id`,[event.id,kind?`Synthetic ${kind}`:'Synthetic legacy',kind])).id;
// Each voucher goes to its own synthetic participant (one voucher per rule and person).
let next=21001;
async function issue(kind,to=null) {
  to=to||(next===21001?owner:await account(String(next)));
  next+=1;
  return (await one(`insert into festival_ops.vouchers(event_id,rule_id,user_id,title,expires_at,reward_stage,code_secret)
    values($1,$2,$3,'Synthetic voucher',now()+interval '1 day',null,extensions.gen_random_bytes(20)) returning id`,[event.id,rules[kind],to.uid])).id;
}
const codeOf=async id=>(await one('select festival_ops.voucher_code(code_secret,festival_ops.voucher_step()) c from festival_ops.vouchers where id=$1',[id])).c;
const stateOf=async id=>(await one('select state from festival_ops.vouchers where id=$1',[id])).state;

await test('nobody redeems until an operator grants a kind; operators redeem every kind',async()=>{
  assert.deepEqual((await voucher(food,'status')).kinds,[]);
  const v=await issue('food');
  await assert.rejects(voucher(food,'check',{code:await codeOf(v)}),/VOUCHER_MANAGER_REQUIRED/);
  await assert.rejects(voucher(food,'redeem',{code:await codeOf(v)}),/VOUCHER_MANAGER_REQUIRED/);
  assert.equal(await stateOf(v),'available');
  const status=await voucher(admin,'status'); assert.equal(status.isAdmin,true); assert.deepEqual(status.kinds,['food','photo']);
  await assert.rejects(rpc(food,'select public.festival_voucher_manager_admin($1,$2) value',['list',{}]),/ADMIN_REQUIRED/);
});
await test('the role needs a verified identity and one of the two kinds',async()=>{
  const c=await grant('candidates',{account:{studentNumber:'11003'}});
  assert.equal(c.verified,false); assert.deepEqual(c.kinds,[]);
  await assert.rejects(grant('grant',{account:{studentNumber:'11003'},kind:'food'}),/VOUCHER_MANAGER_NOT_VERIFIED/);
  await assert.rejects(grant('grant',{account:{studentNumber:'11001'},kind:'drinks'}),/INVALID_INPUT/);
  await assert.rejects(grant('grant',{account:{studentNumber:'11001'},kind:'food',userId:food.uid}),/INVALID_INPUT/);
  assert.equal((await grant('grant',{account:{studentNumber:'11001'},kind:'food'})).ok,true);
  assert.equal((await grant('grant',{account:{studentNumber:'11002'},kind:'photo'})).ok,true);
  assert.deepEqual((await grant('candidates',{account:{studentNumber:'11001'}})).kinds,['food']);
  const list=(await grant('list',{})).items;
  assert.deepEqual(list.map(m=>[m.studentNumber,m.kind,m.active]),[['11001','food',true],['11002','photo',true]]);
  assert.deepEqual((await voucher(food,'status')).kinds,['food']);
  assert.deepEqual((await voucher(unverified,'status')).kinds,[]);
});
await test('a food manager checks and redeems food vouchers only',async()=>{
  const f=await issue('food'),p=await issue('photo');
  const seen=await voucher(food,'check',{code:await codeOf(f)});
  assert.equal(seen.valid,true); assert.equal(seen.kind,'food'); assert.equal(typeof seen.participant,'string');
  const done=await voucher(food,'redeem',{code:await codeOf(f)});
  assert.equal(done.result,'REDEEMED'); assert.equal(await stateOf(f),'used');
  const audit=await one("select action,reason from festival_ops.audit where target=$1",[f]);
  assert.deepEqual(audit,{action:'voucher_manager_redeem',reason:'food'});
  // A photo voucher reveals nothing to a food manager and stays available.
  await assert.rejects(voucher(food,'check',{code:await codeOf(p)}),/VOUCHER_KIND_NOT_ALLOWED/);
  await assert.rejects(voucher(food,'redeem',{code:await codeOf(p)}),/VOUCHER_KIND_NOT_ALLOWED/);
  assert.equal(await stateOf(p),'available');
  await assert.rejects(voucher(food,'redeem',{code:await codeOf(f)}),/VOUCHER_USED/);
});
await test('a photo manager redeems photo vouchers only',async()=>{
  const f=await issue('food'),p=await issue('photo');
  await assert.rejects(voucher(photo,'redeem',{code:await codeOf(f)}),/VOUCHER_KIND_NOT_ALLOWED/);
  assert.equal((await voucher(photo,'redeem',{code:await codeOf(p)})).result,'REDEEMED');
  assert.equal(await stateOf(f),'available'); assert.equal(await stateOf(p),'used');
});
await test('managers never confirm their own voucher or an untyped one; operators still can',async()=>{
  const own=await issue('food',food),legacy=await issue(null);
  await assert.rejects(voucher(food,'check',{code:await codeOf(own)}),/SELF_REDEMPTION/);
  await assert.rejects(voucher(food,'redeem',{code:await codeOf(own)}),/SELF_REDEMPTION/);
  await assert.rejects(voucher(food,'redeem',{code:await codeOf(legacy)}),/VOUCHER_KIND_NOT_ALLOWED/);
  assert.equal((await voucher(photo,'redeem',{code:await codeOf(own)}).catch(e=>e.message)).match(/VOUCHER_KIND_NOT_ALLOWED/)?.[0],'VOUCHER_KIND_NOT_ALLOWED');
  for(const v of [own,legacy]) assert.equal((await voucher(admin,'redeem',{code:await codeOf(v)})).result,'REDEEMED');
  assert.equal((await one("select action from festival_ops.audit where target=$1",[legacy])).action,'voucher_redeem');
});
await test('the right lapses with the identity link and ends on revoke',async()=>{
  const f=await issue('food');
  await db.query('update festival_ops.review_identities set verified=false where user_id=$1',[food.uid]);
  assert.deepEqual((await voucher(food,'status')).kinds,[]);
  assert.equal((await grant('list',{})).items.find(m=>m.kind==='food').active,false);
  await assert.rejects(voucher(food,'redeem',{code:await codeOf(f)}),/VOUCHER_MANAGER_REQUIRED/);
  await db.query('update festival_ops.review_identities set verified=true where user_id=$1',[food.uid]);
  assert.equal((await grant('revoke',{account:{studentNumber:'11001'},kind:'food'})).ok,true);
  assert.deepEqual((await voucher(food,'status')).kinds,[]);
  assert.equal((await one("select count(*)::int n from festival_ops.audit where action in ('voucher_manager_grant','voucher_manager_revoke')")).n,3);
  assert.equal(await stateOf(f),'available');
});
await test('rollback restores operator-only redemption',async()=>{
  await sql('operations-server/voucher-managers-rollback.sql');
  const p=await issue('photo');
  await assert.rejects(voucher(photo,'check',{code:await codeOf(p)}),/ADMIN_REQUIRED/);
  assert.equal((await voucher(admin,'redeem',{code:await codeOf(p)})).result,'REDEEMED');
  assert.equal((await one("select to_regclass('festival_ops.voucher_managers') t")).t,null);
});

console.log(JSON.stringify({passed:results.every(r=>r.ok),results}));
if(!results.every(r=>r.ok)) process.exit(1);
