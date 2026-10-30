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
await sql('operations-server/student-number-display.sql');
const read=(kind,query={},a=admin)=>rpc(a,'select public.festival_ops_read($1,$2) value',[kind,query]);
const guard=()=>rpc(admin,"select public.festival_claim_guard('read','{}') value");

await test('participants carry the student number and are searched by it, not by account number',async()=>{
  const all=(await read('participants')).items;
  assert.equal(all.find(p=>p.id===member.uid).student_number,'11002');
  assert.deepEqual((await read('participants',{search:'11001'})).items.map(p=>p.id).sort(),[student.uid,impostor.uid].sort());
  assert.deepEqual((await read('participants',{search:String(outsider.uid)})).items.filter(p=>p.id===outsider.uid),[]);
  assert.deepEqual((await read('participants',{search:'11003'})).items.map(p=>p.id),[outsider.uid]);
});
await test('a confirmed student number wins over an edited sign-up number',async()=>{
  assert.equal((await self(student,'confirm')).result,'CONFIRMED');
  await db.query("update auth.users set raw_user_meta_data=raw_user_meta_data||'{\"festival_student_number\":\"11009\"}'::jsonb where id=$1",[student.id]);
  assert.equal((await read('participants',{search:'11001'})).items.find(p=>p.id===student.uid)?.student_number,'11001');
});
await test('visits, points and vouchers list student numbers and search by them',async()=>{
  await ops(admin,'points_adjust',{userId:outsider.uid,delta:5,reason:'Synthetic points'});
  const visits=(await read('visits',{search:'11001'})).items;
  assert.ok(visits.length>0 && visits.every(v=>v.user_id===student.uid && v.student_number==='11001'));
  const ledger=(await read('ledger',{search:'11003'})).items;
  assert.deepEqual(ledger.map(l=>[l.user_id,l.student_number]),[[outsider.uid,'11003']]);
  assert.deepEqual((await read('ledger',{search:String(outsider.uid)})).items,[]);
  assert.ok(Array.isArray((await read('vouchers',{search:'11001'})).items));
});
await test('audit rows name the actor and target account by student number',async()=>{
  const row=(await read('audit')).items.find(a=>a.action==='points_adjust');
  assert.equal(row.actor_student_number,'29999'); assert.equal(row.target_student_number,'11003');
  assert.equal(row.target_name,(await read('participants',{search:'11003'})).items[0].name); assert.equal('target_user' in row,false);
  const booth=(await read('audit')).items.find(a=>a.action==='booth_save');
  assert.equal(booth.target_name,null);
});
await test('the claim guard and membership overview list student numbers',async()=>{
  await rpc(admin,"select public.festival_claim_guard('save',$1) value",[{enabled:true,windowMinutes:10,maxClaims:1,version:0}]);
  assert.equal((await guard()).items.find(i=>i.userId===student.uid).studentNumber,'11001');
  assert.equal((await self(impostor,'confirm')).result,'ROSTER_ALREADY_LINKED');
  const c=(await overview()).conflicts[0];
  assert.deepEqual([c.studentNumber,c.holderStudentNumber],['11001','11001']);
});
await test('students cannot read the operator lists',async()=>{
  await assert.rejects(read('participants',{},student),/ADMIN_REQUIRED/);
});
await test('rollback restores the previous reads',async()=>{
  await sql('operations-server/student-number-display-rollback.sql');
  assert.equal('student_number' in (await read('participants')).items[0],false);
  assert.equal((await one("select count(*) n from pg_proc where proname='student_number_of'")).n,0);
});
const out=path.join(root,'artifacts/student-number'); fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,'isolated.json'),JSON.stringify(results,null,2));
await db.close();
console.log(`${results.filter(r=>r.ok).length}/${results.length} passed`);
if(results.some(r=>!r.ok)) process.exitCode=1;
