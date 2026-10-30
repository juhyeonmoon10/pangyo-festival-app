// In-memory PostgreSQL only: NFC stamp rate limit and the suspicious participant list.
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
const guard=(a,action='read',payload={})=>rpc(a,'select public.festival_claim_guard($1,$2) value',[action,payload]);
async function account(admin=false){
  const a={id:randomUUID(),session:randomUUID()};
  await db.query(`insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data)
    values($1,$2,now(),'{"provider":"google"}','{"festival_name":"Synthetic","festival_student_number":"21001"}')`,[a.id,`${a.id}@example.invalid`]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[a.session,a.id]);
  a.uid=(await rpc(a,'select public.festival_nfc_profile() value')).id;
  if(admin) await db.query('update public.users set admin=true where id=$1',[a.uid]);return a;
}
async function test(name,fn){try{await fn();results.push({name,ok:true});console.log('PASS',name);}catch(e){results.push({name,ok:false,error:e.message});console.log('FAIL',name,e.message);}}
for(const f of ['nfc-server/isolated-test/shim.sql','nfc-server/install.sql','nfc-server/admin-issue.sql','nfc-server/updates/20260930-nonexpiring-tags.sql','nfc-server/reviews.sql','operations-server/install.sql','operations-server/review-identity.draft.sql','operations-server/reward-visits.sql','operations-server/reward-fixed-milestones.sql','operations-server/voucher-unlimited-and-reset.sql']) await db.exec(read(f));
const admin=await account(true),fast=await account(),slow=await account(),student=await account();
const event=(await ops(admin,'event_save',{name:'Synthetic guard',state:'open',reviewPoints:10,version:0})).event;
const booths=(await db.query('select key from festival_ops.booths where event_id=$1 order by key collate "C" limit 8',[event.id])).rows.map(r=>r.key);
for(const booth of booths) await ops(admin,'booth_save',{booth,name:booth,floor:1,status:'open',version:1});
await db.exec(read('operations-server/nfc-tag-registry.sql'));
const tokens={};
for(const booth of booths) tokens[booth]=(await db.query('select festival_nfc_private.issue_tag($1::public.booth_enum,null) t',[booth])).rows[0].t;
const claim=(a,booth)=>ops(a,'claim',{token:tokens[booth]});
const age=(a,minutes)=>db.query(`update festival_ops.visits set created_at=created_at-make_interval(mins=>$2) where user_id=$1`,[a.uid,minutes]);

await test('defaults: enabled, at most 5 new NFC stamps in 10 minutes, nobody listed',async()=>{
  await db.exec(read('operations-server/claim-guard.sql'));
  const g=await guard(admin);
  assert.deepEqual({...g,items:undefined},{enabled:true,windowMinutes:10,maxClaims:5,version:0,items:undefined});
  assert.deepEqual(g.items,[]);
});
await test('the sixth new booth within the window is refused; re-scans and nothing else change',async()=>{
  for(const booth of booths.slice(0,5)) assert.equal((await claim(fast,booths.includes(booth)?booth:null)).result,'EARNED');
  await assert.rejects(claim(fast,booths[5]),/CLAIM_RATE_LIMITED/);
  assert.equal((await claim(fast,booths[0])).result,'ALREADY_EARNED','an earned booth can always be re-scanned');
  assert.equal((await db.query('select count(*)::int n from festival_ops.visits where user_id=$1',[fast.uid])).rows[0].n,5);
  await assert.rejects(rpc(fast,'select public.festival_nfc_claim($1) value',[tokens[booths[5]]]),/CLAIM_RATE_LIMITED/,'the legacy endpoint shares the limit');
});
await test('the limit is a rolling window: older stamps stop counting',async()=>{
  await age(fast,11);
  assert.equal((await claim(fast,booths[5])).result,'EARNED');
});
await test('manual approvals neither count nor get blocked',async()=>{
  for(const booth of booths.slice(0,4)) await claim(slow,booth);
  for(const booth of booths.slice(4,8)) await ops(admin,'visit_approve',{booth,userId:slow.uid,reason:'Synthetic visit check'});
  assert.equal((await db.query('select count(*)::int n from festival_ops.visits where user_id=$1',[slow.uid])).rows[0].n,8);
});
await test('participants who reached the limit are listed with their peak',async()=>{
  const {items}=await guard(admin);
  assert.deepEqual(items.map(x=>[x.userId,x.peak,x.nfc,x.manual]),[[fast.uid,5,6,0]]);
  assert.ok(items[0].lastAt && items[0].peakAt);
});
await test('operators change the rule with a version check; the new rule applies at once',async()=>{
  const g=await guard(admin,'save',{enabled:true,windowMinutes:30,maxClaims:3,version:0});
  assert.deepEqual([g.windowMinutes,g.maxClaims,g.version],[30,3,1]);
  await assert.rejects(guard(admin,'save',{enabled:true,windowMinutes:30,maxClaims:3,version:0}),/VERSION_CONFLICT/);
  for(const bad of [{windowMinutes:0,maxClaims:3},{windowMinutes:181,maxClaims:3},{windowMinutes:10,maxClaims:0},{windowMinutes:10,maxClaims:101}])
    await assert.rejects(guard(admin,'save',{enabled:true,...bad,version:1}),/INVALID_INPUT/);
  await assert.rejects(guard(admin,'save',{windowMinutes:10,maxClaims:3,version:1}),/INVALID_INPUT/);
  for(const booth of booths.slice(0,3)) await claim(student,booth);
  await assert.rejects(claim(student,booths[3]),/CLAIM_RATE_LIMITED/);
  assert.ok((await guard(admin)).items.some(x=>x.userId===student.uid),'slow is now listed too under 3 in 30 minutes');
  assert.equal((await db.query("select count(*)::int n from festival_ops.audit where action='claim_guard_save'")).rows[0].n,1);
});
await test('turning the limit off lets the next booth through',async()=>{
  await guard(admin,'save',{enabled:false,windowMinutes:30,maxClaims:3,version:1});
  assert.equal((await claim(student,booths[3])).result,'EARNED');
});
await test('only operators can read or change the rule',async()=>{
  await assert.rejects(guard(student),/ADMIN_REQUIRED/);
  await assert.rejects(guard(student,'save',{enabled:false,windowMinutes:10,maxClaims:5,version:2}),/ADMIN_REQUIRED/);
  await assert.rejects(rpc(admin,"select public.festival_claim_guard('read','{}') value",[],'anon'),/permission denied/);
  await assert.rejects(rpc(student,'select count(*) value from festival_ops.claim_guard'),/permission denied/);
});
await test('rollback removes the limit and keeps tag management',async()=>{
  await guard(admin,'save',{enabled:true,windowMinutes:60,maxClaims:1,version:2});
  await db.exec(read('operations-server/claim-guard-rollback.sql'));
  assert.equal((await db.query("select to_regclass('festival_ops.claim_guard') t")).rows[0].t,null);
  const other=await account();
  for(const booth of booths.slice(0,3)) assert.equal((await claim(other,booth)).result,'EARNED');
  assert.ok((await db.query('select count(*)::int n from festival_nfc_private.tags')).rows[0].n>0);
  await db.exec(read('operations-server/claim-guard.sql'));
});
const failed=results.filter(r=>!r.ok);
console.log(`${results.length-failed.length}/${results.length} passed`);
if(failed.length) process.exitCode=1;
