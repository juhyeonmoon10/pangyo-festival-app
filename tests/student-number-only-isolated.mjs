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
for(const f of ['self-identity-and-own-club-stamps','student-number-display','student-number-only']) await sql(`operations-server/${f}.sql`);
const lookup=(sid,a=admin)=>rpc(a,'select public.festival_student_lookup($1) value',[{studentNumber:sid}]);
const byStudent=(action,payload,a=admin)=>rpc(a,'select public.festival_ops_write_student($1,$2,$3) value',[action,payload,randomUUID()]);
const idStudent=(action,payload)=>rpc(admin,'select public.festival_review_identity_student($1,$2) value',[action,{eventId:event.id,...payload}]);
const email=a=>`${a.id}@example.invalid`;

await test('a student number looks up its accounts; two unconfirmed sign-ups are ambiguous',async()=>{
  const r=await lookup('11001');
  assert.equal(r.accounts.length,2); assert.equal(r.accounts.some(a=>a.selected),false);
  assert.ok(r.accounts.every(a=>!('id' in a) && !('userId' in a) && typeof a.email==='string'));
  assert.deepEqual((await lookup('11003')).accounts.map(a=>[a.selected,a.visits]),[[true,0]]);
  assert.deepEqual((await lookup('19999')).accounts,[]);
});
await test('manual stamps and points are given by student number; ambiguity needs the account email',async()=>{
  await byStudent('points_adjust',{studentNumber:'11003',delta:3,reason:'Synthetic points'});
  assert.equal(Number((await one('select sum(delta) n from festival_ops.ledger where user_id=$1',[outsider.uid])).n),3);
  await assert.rejects(byStudent('points_adjust',{studentNumber:'11001',delta:1,reason:'Synthetic points'}),/STUDENT_AMBIGUOUS/);
  await byStudent('points_adjust',{studentNumber:'11001',email:email(impostor),delta:1,reason:'Synthetic points'});
  assert.equal(Number((await one('select sum(delta) n from festival_ops.ledger where user_id=$1',[impostor.uid])).n),1);
  await assert.rejects(byStudent('visit_approve',{studentNumber:'19999',booth:away,reason:'Synthetic visit'}),/STUDENT_NOT_FOUND/);
});
await test('a confirmed link resolves a shared student number to the actual student',async()=>{
  assert.equal((await self(student,'confirm')).result,'CONFIRMED');
  assert.equal((await lookup('11001')).accounts.find(a=>a.selected).email,email(student));
  await byStudent('points_adjust',{studentNumber:'11001',delta:2,reason:'Synthetic points'});
  assert.equal(Number((await one('select sum(delta) n from festival_ops.ledger where user_id=$1',[student.uid])).n),2);
});
await test('account numbers are refused: the old writes, a userId in the payload and the old identity RPC',async()=>{
  await assert.rejects(ops(admin,'visit_approve',{booth:own,userId:outsider.uid,reason:'Synthetic visit'}),/INVALID_INPUT/);
  assert.equal(await visits(outsider,own),0);
  await assert.rejects(ops(admin,'points_adjust',{userId:member.uid,delta:1,reason:'Synthetic points'}),/INVALID_INPUT/);
  await assert.rejects(byStudent('points_adjust',{studentNumber:'11002',userId:member.uid,delta:1,reason:'Synthetic points'}),/INVALID_INPUT/);
  await assert.rejects(rpc(admin,'select public.festival_review_identity_admin($1,$2) value',['list',{eventId:event.id}]),/does not exist|permission denied/);
  await assert.rejects(rpc(admin,'select public.festival_review_identity_admin_internal($1,$2) value',['list',{eventId:event.id}]),/permission denied/);
});
await test('students keep earning NFC stamps and review points',async()=>{
  assert.equal((await ops(outsider,'claim',{token:awayTag})).result,'EARNED');
});
await test('소속 확인 is managed by student number and email, never by account number',async()=>{
  const list=await idStudent('list',{search:'',offset:0});
  assert.ok(list.items.length>0 && list.items.every(i=>!('userId' in i) && typeof i.email==='string'));
  const got=await idStudent('get',{account:{studentNumber:'11001'}});
  assert.equal('userId' in got,false); assert.equal(got.account.email,email(student)); assert.equal(got.selfRegistered,true);
  await idStudent('revoke',{account:{studentNumber:'11001'},version:got.version,reason:'Synthetic wrong account'});
  await assert.rejects(idStudent('get',{account:{studentNumber:'11001'}}),/STUDENT_AMBIGUOUS/);
  const target={studentNumber:'11001',email:email(impostor)};
  const found=await idStudent('lookup',{account:target,studentNumber:'11001'});
  await idStudent('save',{account:target,studentNumber:'11001',version:found.version,rosterVersion:found.roster.version,confirmed:true,reason:'Synthetic operator check'});
  assert.equal((await self(impostor)).verified,true);
  assert.equal((await lookup('11001')).accounts.find(a=>a.selected).email,email(impostor));
});
await test('the overview names conflicting accounts by student number and email',async()=>{
  // Relinking removed the revoked row, so the student's own attempt is now a reported conflict.
  assert.equal((await self(student,'confirm')).result,'ROSTER_ALREADY_LINKED');
  const c=(await overview()).conflicts[0];
  assert.deepEqual([c.studentNumber,c.email,c.holderStudentNumber,c.holderEmail],['11001',email(student),'11001',email(impostor)]);
  assert.ok(!('userId' in c) && !('holderId' in c));
});
await test('operator lists carry no account numbers',async()=>{
  const read=(kind,query={})=>rpc(admin,'select public.festival_ops_read($1,$2) value',[kind,query]);
  const banned=['id','user_id','actor_id','userId','holderId','target_user'];
  const clean=rows=>rows.every(r=>banned.every(k=>!(k in r)));
  for(const kind of ['participants','visits','ledger','audit']) {
    const rows=(await read(kind)).items; assert.ok(rows.length>0,kind); assert.ok(clean(rows),kind);
  }
  assert.ok((await read('participants',{search:'11003'})).items.every(p=>p.student_number==='11003'));
  const adjust=(await read('audit')).items.find(r=>r.action==='points_adjust');
  assert.equal(adjust.target,null); assert.ok(/^[1-3][0-9]{4}$/.test(adjust.target_student_number));
  await rpc(admin,"select public.festival_claim_guard('save',$1) value",[{enabled:true,windowMinutes:10,maxClaims:1,version:0}]);
  const guard=await rpc(admin,"select public.festival_claim_guard('read','{}') value");
  assert.ok(guard.items.length>0 && clean(guard.items));
});
await test('only operators look up student numbers or write by them',async()=>{
  await assert.rejects(lookup('11001',student),/ADMIN_REQUIRED/);
  await assert.rejects(byStudent('points_adjust',{studentNumber:'11003',delta:1,reason:'Synthetic points'},student),/ADMIN_REQUIRED/);
  await assert.rejects(rpc(student,'select public.festival_student_lookup($1) value',[{studentNumber:'11001'}],'anon'),/permission denied/);
});
await test('rollback restores the account-number admin functions',async()=>{
  await sql('operations-server/student-number-only-rollback.sql');
  await ops(admin,'points_adjust',{userId:member.uid,delta:1,reason:'Synthetic points'});
  assert.ok((await rpc(admin,'select public.festival_review_identity_admin($1,$2) value',['list',{eventId:event.id}])).items.length>0);
});
const out=path.join(root,'artifacts/student-number-only'); fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,'isolated.json'),JSON.stringify(results,null,2));
await db.close();
console.log(`${results.filter(r=>r.ok).length}/${results.length} passed`);
if(results.some(r=>!r.ok)) process.exitCode=1;
