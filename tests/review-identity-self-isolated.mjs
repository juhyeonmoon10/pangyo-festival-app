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
const self=(a,action,payload={})=>rpc(a,'select public.festival_review_identity_self($1,$2) value',[action,payload]);
const admin_=(a,action,payload)=>rpc(a,'select public.festival_review_identity_admin($1,$2) value',[action,payload]);
async function account(studentNumber,admin=false){
  const a={id:randomUUID(),session:randomUUID(),studentNumber};
  await db.query(`insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data)
    values($1,$2,now(),'{"provider":"google"}',$3)`,[a.id,`${a.id}@example.invalid`,{festival_name:'표시 이름',festival_student_number:studentNumber}]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[a.session,a.id]);
  a.uid=(await rpc(a,'select public.festival_nfc_profile() value')).id;
  if(admin) await db.query('update public.users set admin=true where id=$1',[a.uid]);return a;
}
async function test(name,fn){try{await fn();results.push({name,ok:true});console.log('PASS',name);}catch(e){results.push({name,ok:false,error:e.message});console.log('FAIL',name,e.message);}}
for(const f of ['nfc-server/isolated-test/shim.sql','nfc-server/install.sql','nfc-server/admin-issue.sql','nfc-server/reviews.sql','operations-server/install.sql']) await db.exec(read(f));
const admin=await account('29999',true);
const event=(await ops(admin,'event_save',{name:'Synthetic identity test',state:'open',reviewPoints:10,version:0})).event;
for(const f of ['operations-server/review-identity.draft.sql','operations-server/reward-visits.sql','operations-server/reward-fixed-milestones.sql','operations-server/voucher-unlimited-and-reset.sql','operations-server/review-identity-self.sql']) await db.exec(read(f));
const catalog=(await db.query('select key from festival_ops.booths where event_id=$1 order by key collate "C"',[event.id])).rows.map(r=>r.key);
const [own,away]=['인벨릭스','매커니즘'];
for(const booth of [own,away]) await ops(admin,'booth_save',{booth,name:booth,floor:1,status:'open',version:1});
const record=(sid,realName,clubs,boothKeys,status='ready')=>({studentNumber:sid,realName,clubs,boothKeys,status,issues:status==='ready'?[]:['SHEET_CONFLICT'],sourceCells:['Synthetic!A1']});
let records=[record('11001','김 하나',['인벨릭스'],[own]),record('11002','이둘',['축구반'],[]),record('11003','박셋',['인벨릭스'],[own],'review_required')];
const importRoster=()=>db.query('select festival_ops.import_review_roster($1,$2,$3)',[event.id,{format:1,sourceSha256:'b'.repeat(64),catalogKeys:catalog,records},admin.uid]);
await importRoster();
const student=await account('11001'),impostor=await account('11001'),other=await account('11002'),pending=await account('11003'),senior=await account('31001'),stranger=await account('12999');
const confirm=(a,realName)=>self(a,'confirm',{eventId:event.id,realName});

await test('anonymous and direct helper access are denied',async()=>{
  await assert.rejects(rpc(student,"select public.festival_review_identity_self('status','{}') value",[],'anon'),/permission denied/);
  await assert.rejects(rpc(student,'select festival_ops.identity_state($1,$2) value',[event.id,student.uid]),/permission denied/);
  await assert.rejects(admin_(student,'list',{eventId:event.id}),/ADMIN_REQUIRED/);
});
await test('an unconfirmed roster student needs confirmation; seniors are not eligible',async()=>{
  const s=await self(student,'status');
  assert.equal(s.verified,false);assert.equal(s.eligible,true);assert.equal(s.studentNumber,'11001');assert.equal(s.realName,null);assert.deepEqual(s.clubs,[]);
  assert.equal((await self(senior,'status')).eligible,false);
  assert.equal((await confirm(senior,'누구')).result,'ROSTER_NOT_FOUND');
});
await test('a wrong name is refused without storing it or revealing the roster',async()=>{
  const r=await confirm(student,'김하나아');
  assert.equal(r.result,'IDENTITY_MISMATCH');assert.equal(r.verified,false);assert.deepEqual(r.clubs,[]);assert.equal(r.realName,null);
  const audit=await one("select count(*) n, bool_and(target=$1 and reason is null) clean from festival_ops.audit where action='review_identity_self_mismatch'",[String(student.uid)]);
  assert.equal(Number(audit.n),1);assert.equal(audit.clean,true);
  assert.equal((await one("select count(*) n from festival_ops.audit where reason like '%김하나%' or target like '%김하나%'")).n,0);
});
await test('the roster name confirms immediately, ignoring spaces, and grants only the server roster',async()=>{
  const r=await confirm(student,'김하나');
  assert.equal(r.result,'CONFIRMED');assert.equal(r.verified,true);assert.equal(r.realName,'김 하나');
  assert.deepEqual(r.clubs,['인벨릭스']);assert.deepEqual(r.boothKeys,[own]);assert.equal(r.selfRegistered,true);
  assert.equal((await confirm(student,'아무 이름')).result,'CONFIRMED','already confirmed is idempotent');
});
await test('own club stays blocked and other booths use the roster name',async()=>{
  for(const booth of [own,away]) await ops(admin,'visit_approve',{booth,userId:student.uid,reason:'Synthetic visit check'});
  await assert.rejects(ops(student,'review_save',{booth:own,rating:5,content:''}),/OWN_CLUB_REVIEW/);
  await ops(student,'review_save',{booth:away,rating:4,content:''});
  assert.equal((await one('select author_name from festival_ops.reviews where user_id=$1',[student.uid])).author_name,'김 하나');
});
await test('the same student number cannot be confirmed by a second account',async()=>{
  assert.equal((await confirm(impostor,'김하나')).result,'ROSTER_ALREADY_LINKED');
});
await test('numbers missing from the roster or still under review are not confirmed',async()=>{
  assert.equal((await confirm(stranger,'누구')).result,'ROSTER_NOT_FOUND');
  assert.equal((await confirm(pending,'박셋')).result,'ROSTER_NOT_FOUND');
});
await test('five wrong names in an hour lock further attempts',async()=>{
  for(let i=0;i<5;i++) assert.equal((await confirm(other,`틀린${i}`)).result,'IDENTITY_MISMATCH');
  assert.equal((await confirm(other,'이둘')).result,'TOO_MANY_ATTEMPTS');
  await db.query("update festival_ops.audit set created_at=now()-interval '2 hours' where action='review_identity_self_mismatch' and actor_id=$1",[other.uid]);
  const r=await confirm(other,'이둘');assert.equal(r.result,'CONFIRMED');assert.deepEqual(r.boothKeys,[]);
});
await test('operators list self registrations and can revoke them',async()=>{
  const list=await admin_(admin,'list',{eventId:event.id});
  const row=list.items.find(x=>x.userId===student.uid);
  assert.equal(row.selfRegistered,true);assert.equal(row.state.verified,true);assert.equal(row.studentNumber,'11001');
  assert.equal(list.counts.self,2);
  assert.equal((await admin_(admin,'list',{eventId:event.id,search:'이둘'})).items.length,1);
  const got=await admin_(admin,'get',{eventId:event.id,userId:student.uid});
  assert.equal(got.selfRegistered,true);
  await admin_(admin,'revoke',{eventId:event.id,userId:student.uid,version:got.version,reason:'Wrong person check'});
  const s=await self(student,'status');assert.equal(s.verified,false);assert.equal(s.locked,true);
  assert.equal((await confirm(student,'김하나')).result,'OPERATOR_LOCKED');
  const policy=(await one('select festival_ops.review_policy($1,$2,$3) p',[event.id,student.uid,away])).p;
  assert.equal(policy.allowed,false);assert.equal(policy.reason,'REVIEW_IDENTITY_REQUIRED');
});
await test('a revoked link frees the number for the rightful account',async()=>{
  const r=await confirm(impostor,'김하나');
  assert.equal(r.result,'CONFIRMED');
  assert.equal((await self(student,'status')).locked,false,'the revoked row was released');
  assert.equal((await confirm(student,'김하나')).result,'ROSTER_ALREADY_LINKED');
});
await test('operators can change a link to another roster entry',async()=>{
  const got=await admin_(admin,'get',{eventId:event.id,userId:impostor.uid});
  await admin_(admin,'revoke',{eventId:event.id,userId:impostor.uid,version:got.version,reason:'Move link check'});
  const moved=await admin_(admin,'get',{eventId:event.id,userId:student.uid});
  const look=await admin_(admin,'lookup',{eventId:event.id,userId:student.uid,studentNumber:'11001'});
  assert.equal(look.roster.linkedElsewhere,false,'revoked links do not count as linked');
  const saved=await admin_(admin,'save',{eventId:event.id,userId:student.uid,version:moved.version,studentNumber:'11001',rosterVersion:look.roster.version,confirmed:true,reason:'Operator relink'});
  assert.equal(saved.verified,true);assert.equal(saved.selfRegistered,false);
  assert.equal((await self(student,'status')).verified,true);
  assert.equal((await self(impostor,'status')).locked,false);
});
await test('a changed roster entry asks the student to confirm again',async()=>{
  records=records.map(r=>r.studentNumber==='11002'?record('11002','이둘',['인벨릭스'],[own]):r);
  await importRoster();
  const s=await self(other,'status');assert.equal(s.verified,false);assert.equal(s.locked,false);
  const r=await confirm(other,'이둘');assert.equal(r.result,'CONFIRMED');assert.deepEqual(r.boothKeys,[own]);
});
await test('a profile without a student number is refused',async()=>{
  const a={id:randomUUID(),session:randomUUID()};
  await db.query(`insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data) values($1,$2,now(),'{"provider":"google"}','{}')`,[a.id,`${a.id}@example.invalid`]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[a.session,a.id]);
  await rpc(a,'select public.festival_nfc_profile() value');
  await assert.rejects(self(a,'status'),/PROFILE_REQUIRED/);
});
const out=path.join(root,'artifacts/review-identity-self');fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,'isolated.json'),JSON.stringify(results,null,2));
const failed=results.filter(r=>!r.ok);
console.log(`${results.length-failed.length}/${results.length} passed`);
if(failed.length) process.exitCode=1;
