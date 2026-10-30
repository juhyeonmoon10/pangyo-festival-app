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
const self=(a,action='status',realName='Synthetic One')=>rpc(a,'select public.festival_review_identity_self($1,$2) value',[action,{eventId:event.id,realName}]);
const identify=(action,payload)=>rpc(admin,'select public.festival_review_identity_admin($1,$2) value',[action,{eventId:event.id,...payload}]);
const overview=(a=admin,role)=>rpc(a,'select public.festival_identity_overview() value',[],role);
const visits=async(a,booth)=>Number((await one('select count(*) n from festival_ops.visits where user_id=$1 and booth_key=$2',[a.uid,booth])).n);
const mirror=async a=>(await one('select to_jsonb(completed_booths) b from public.users where id=$1',[a.uid])).b;
async function account(sid,admin=false) {
  const a={id:randomUUID(),session:randomUUID()};
  await db.query(`insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data) values($1,$2,now(),'{"provider":"google"}',$3)`,[a.id,`${a.id}@example.invalid`,{festival_name:'Synthetic',festival_student_number:sid}]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[a.session,a.id]);
  a.uid=(await rpc(a,'select public.festival_nfc_profile() value')).id;
  if(admin) await db.query('update public.users set admin=true where id=$1',[a.uid]);
  return a;
}
async function test(name,fn) {try {await fn();results.push({name,ok:true});console.log('PASS',name);}catch(e){results.push({name,ok:false,error:e.message});console.log('FAIL',name,e.message);}}
for(const f of ['nfc-server/isolated-test/shim.sql','nfc-server/install.sql','nfc-server/admin-issue.sql','nfc-server/updates/20260930-nonexpiring-tags.sql','nfc-server/reviews.sql','operations-server/install.sql']) await sql(f);
const admin=await account('29999',true);
const event=(await ops(admin,'event_save',{name:'Synthetic own-club event',state:'open',reviewPoints:10,version:0})).event;
for(const f of ['operations-server/review-identity.draft.sql','operations-server/reward-visits.sql','operations-server/reward-fixed-milestones.sql','operations-server/voucher-unlimited-and-reset.sql','operations-server/review-identity-self.sql','operations-server/voucher-short-code.sql','operations-server/review-distribution-self-redeem.sql','operations-server/nfc-tag-registry.sql','operations-server/claim-guard.sql','operations-server/booth-bulk-and-tag-register.sql','operations-server/notices.sql','operations-server/operator-identity-and-scoped-reset.sql']) await sql(f);
const catalog=(await db.query('select key from festival_ops.booths where event_id=$1 order by key collate "C"',[event.id])).rows.map(r=>r.key);
const [own,away]=catalog;
for(const booth of [own,away]) await ops(admin,'booth_save',{booth,name:booth,status:'open',floor:1,version:1});
const record=(studentNumber,realName,boothKeys)=>({studentNumber,realName,clubs:['Synthetic Club'],boothKeys,status:'ready',issues:[],sourceCells:['Synthetic!A1']});
await db.query('select festival_ops.import_review_roster($1,$2,$3)',[event.id,{format:1,sourceSha256:'d'.repeat(64),catalogKeys:catalog,
  records:[record('11001','Synthetic One',[own]),record('11002','Synthetic Two',[away])]},admin.uid]);
const tag=async booth=>(await one('select festival_nfc_private.issue_tag($1,null) t',[booth])).t;
const ownTag=await tag(own),awayTag=await tag(away);
const student=await account('11001'),impostor=await account('11001'),member=await account('11002'),outsider=await account('11003');
// Stamps earned at the student's own club before this update: one NFC, one manual.
await ops(student,'claim',{token:ownTag});
await ops(student,'claim',{token:awayTag});
await ops(admin,'visit_approve',{booth:own,userId:member.uid,reason:'Synthetic fixture'});
await sql('operations-server/self-identity-and-own-club-stamps.sql');

await test('installation removes existing own-club stamps and only their NFC mirror entries',async()=>{
  assert.equal(await visits(student,own),0); assert.equal(await visits(student,away),1);
  assert.deepEqual(await mirror(student),[away]);
  assert.equal(await visits(member,own),1,'a booth outside the member club is kept');
  assert.equal((await overview()).removedStamps,1);
});
await test('a student confirms their own club with the roster name',async()=>{
  assert.equal((await self(student)).verified,false);
  assert.equal((await self(student,'confirm','Wrong Name')).result,'IDENTITY_MISMATCH');
  const r=await self(student,'confirm',' Synthetic  One ');
  assert.equal(r.result,'CONFIRMED'); assert.equal(r.verified,true); assert.equal(r.selfRegistered,true);
  assert.equal(r.realName,'Synthetic One'); assert.deepEqual(r.boothKeys,[own]); assert.equal(r.studentNumber,'11001');
  assert.equal((await self(student)).verified,true);
});
await test('a self-confirmed student reviews other booths under the roster name, never their own',async()=>{
  await assert.rejects(ops(student,'review_save',{booth:own,rating:5,content:''}),/OWN_CLUB_REVIEW|VISIT_REQUIRED/);
  await ops(student,'review_save',{booth:away,rating:5,content:'Synthetic review'});
  assert.equal((await one('select author_name from festival_ops.reviews where user_id=$1',[student.uid])).author_name,'Synthetic One');
});
await test('own-club NFC claims and manual approvals are refused without side effects',async()=>{
  const uses=(await one('select sum(use_count)::int n from festival_nfc_private.tags')).n;
  await assert.rejects(ops(student,'claim',{token:ownTag}),/OWN_CLUB_STAMP/);
  await assert.rejects(ops(admin,'visit_approve',{booth:own,userId:student.uid,reason:'Synthetic check'}),/OWN_CLUB_STAMP/);
  assert.equal((await one('select sum(use_count)::int n from festival_nfc_private.tags')).n,uses);
  assert.deepEqual(await mirror(student),[away]); assert.equal(await visits(student,own),0);
  // Before confirmation the sign-up student number on the roster decides the club.
  await assert.rejects(ops(member,'claim',{token:awayTag}),/OWN_CLUB_STAMP/);
  assert.equal((await ops(outsider,'claim',{token:ownTag})).result,'EARNED');
  assert.equal((await ops(member,'claim',{token:ownTag})).result,'ALREADY_EARNED');
});
await test('a second account claiming a linked student number is refused and listed for operators',async()=>{
  assert.equal((await self(impostor,'confirm')).result,'ROSTER_ALREADY_LINKED');
  const o=await overview();
  assert.equal(o.conflicts[0].userId,impostor.uid); assert.equal(o.conflicts[0].holderId,student.uid);
  for(let i=0;i<4;i++) await self(impostor,'confirm','Wrong Name');
  assert.equal((await self(impostor,'confirm')).result,'TOO_MANY_ATTEMPTS');
  assert.equal((await self(impostor)).verified,false);
});
await test('operators revoke a wrong link, and a revoked student cannot self-confirm again',async()=>{
  const row=await identify('get',{userId:student.uid});
  await identify('revoke',{userId:student.uid,version:row.version,reason:'Synthetic wrong account'});
  assert.equal((await self(student,'confirm')).result,'OPERATOR_LOCKED');
  // A revoked link no longer reserves the number, but the attempt limit still applies to that account.
  assert.equal((await self(impostor,'confirm')).result,'TOO_MANY_ATTEMPTS');
});
await test('an operator link removes stamps that became own-club stamps',async()=>{
  await ops(outsider,'claim',{token:awayTag});
  assert.equal(await visits(outsider,away),1);
  const lookup=await identify('lookup',{userId:outsider.uid,studentNumber:'11002'});
  await identify('save',{userId:outsider.uid,studentNumber:'11002',version:lookup.version,rosterVersion:lookup.roster.version,confirmed:true,reason:'Synthetic operator check'});
  assert.equal(await visits(outsider,away),0); assert.equal(await visits(outsider,own),1);
  assert.deepEqual(await mirror(outsider),[own]);
  const o=await overview();
  assert.deepEqual(o.links,{self:0,operator:1,revoked:1});
  assert.equal(o.removedStamps,2); assert.equal(o.removals[0].userId,outsider.uid);
  assert.deepEqual(o.roster,{students:2,ready:2,review:0,withBooth:2});
});
await test('only operators read the overview',async()=>{
  await assert.rejects(overview(student),/ADMIN_REQUIRED/);
  await assert.rejects(overview(student,'anon'),/permission denied/);
});
await test('rollback stops the own-club block',async()=>{
  await sql('operations-server/self-identity-and-own-club-stamps-rollback.sql');
  assert.equal((await ops(member,'claim',{token:awayTag})).result,'EARNED');
});
const out=path.join(root,'artifacts/own-club-identity'); fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,'isolated.json'),JSON.stringify(results,null,2));
await db.close();
console.log(`${results.filter(r=>r.ok).length}/${results.length} passed`);
if(results.some(r=>!r.ok)) process.exitCode=1;
