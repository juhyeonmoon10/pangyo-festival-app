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
const manager=(a,action,payload={},request=null)=>rpc(a,'select public.festival_booth_manager($1,$2,$3) value',[action,payload,request]);
const grant=(action,payload)=>rpc(admin,'select public.festival_booth_manager_admin($1,$2) value',[action,payload]);
const notice=(a,action,payload)=>rpc(a,'select public.festival_notice_admin($1,$2) value',[action,payload]);
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
const event=(await ops(admin,'event_save',{name:'Synthetic manager event',state:'open',reviewPoints:10,version:0})).event;
for(const f of ['review-identity.draft','reward-visits','reward-fixed-milestones','voucher-unlimited-and-reset','review-identity-self','voucher-short-code','review-distribution-self-redeem','nfc-tag-registry','claim-guard','booth-bulk-and-tag-register','notices','operator-identity-and-scoped-reset','self-identity-and-own-club-stamps','student-number-display','student-number-only','operator-self-actions','sun-nfc']) await sql(`operations-server/${f}.sql`);
const catalog=(await db.query('select key from festival_ops.booths where event_id=$1 order by key collate "C"',[event.id])).rows.map(r=>r.key);
const [club,other]=catalog;
for(const booth of [club,other]) await ops(admin,'booth_save',{booth,name:booth,status:'open',floor:1,version:1});
const record=(studentNumber,realName,boothKeys)=>({studentNumber,realName,clubs:['Synthetic Club'],boothKeys,status:'ready',issues:[],sourceCells:['Synthetic!A1']});
await db.query('select festival_ops.import_review_roster($1,$2,$3)',[event.id,{format:1,sourceSha256:'e'.repeat(64),catalogKeys:catalog,
  records:[record('11001','Manager One',[club]),record('11002','Member Two',[club]),record('29999','Synthetic Admin',[])]},admin.uid]);
const lead=await account('11001'),member=await account('11002'),visitor=await account('21001'),twinA=await account('21002'),twinB=await account('21002');
await rpc(lead,'select public.festival_review_identity_self($1,$2) value',['confirm',{eventId:event.id,realName:'Manager One'}]);
await sql('operations-server/booth-managers.sql');
await sql('operations-server/notice-images.sql');

await test('nobody manages a booth until an operator grants it; operators manage every booth',async()=>{
  assert.deepEqual((await manager(lead,'status')).items,[]);
  await assert.rejects(manager(lead,'save',{booth:club,version:2,status:'open'}),/BOOTH_MANAGER_REQUIRED/);
  const all=await manager(admin,'status'); assert.equal(all.isAdmin,true); assert.equal(all.items.length,catalog.length);
  await assert.rejects(rpc(lead,'select public.festival_booth_manager_admin($1,$2) value',['list',{}]),/ADMIN_REQUIRED/);
});
await test('the role needs a verified own club and only covers that club',async()=>{
  const c=await grant('candidates',{account:{studentNumber:'11001'}});
  assert.equal(c.verified,true); assert.deepEqual(c.booths.map(b=>b.key),[club]);
  const unverified=await grant('candidates',{account:{studentNumber:'11002'}});
  assert.equal(unverified.verified,false); assert.deepEqual(unverified.booths,[]);
  await assert.rejects(grant('grant',{account:{studentNumber:'11002'},booth:club,canApprove:true}),/BOOTH_MANAGER_NOT_VERIFIED/);
  await assert.rejects(grant('grant',{account:{studentNumber:'11001'},booth:other,canApprove:true}),/BOOTH_MANAGER_NOT_VERIFIED/);
  assert.equal((await grant('grant',{account:{studentNumber:'11001'},booth:club,canApprove:false})).ok,true);
  const list=(await grant('list',{})).items; assert.equal(list.length,1);
  assert.equal(list[0].studentNumber,'11001'); assert.equal(list[0].booth,club); assert.equal(list[0].canApprove,false); assert.equal(list[0].active,true);
});
await test('a manager edits description, program and status of their booth only',async()=>{
  const mine=(await manager(lead,'status')).items; assert.deepEqual(mine.map(b=>b.key),[club]); assert.equal(mine[0].canApprove,false);
  const saved=await manager(lead,'save',{booth:club,version:mine[0].version,status:'paused',description:'Synthetic intro',
    program:{title:'Synthetic program',description:'What we do',hours:'10:00-12:00',materials:''}});
  assert.equal(saved.status,'paused'); assert.equal(saved.description,'Synthetic intro');
  assert.deepEqual(saved.program,{title:'Synthetic program',description:'What we do',hours:'10:00-12:00'});
  await assert.rejects(manager(lead,'save',{booth:club,version:mine[0].version,status:'open'}),/VERSION_CONFLICT/);
  await assert.rejects(manager(lead,'save',{booth:club,version:saved.version,status:'open',program:{price:'1000'}}),/INVALID_INPUT/);
  await assert.rejects(manager(lead,'save',{booth:other,version:2,status:'open'}),/BOOTH_MANAGER_REQUIRED/);
  const read=await rpc(visitor,"select public.festival_ops_read('catalog','{}') value");
  const catalogRow=(read.items || read).find(b=>b.key===club);
  assert.equal(catalogRow.program.title,'Synthetic program');
  await manager(lead,'save',{booth:club,version:saved.version,status:'open',description:'Synthetic intro',program:saved.program});
});
await test('manual stamps need the approval option and stay within the booth and its rules',async()=>{
  await assert.rejects(manager(lead,'lookup',{booth:club,studentNumber:'21001'}),/BOOTH_APPROVAL_NOT_ALLOWED/);
  await grant('grant',{account:{studentNumber:'11001'},booth:club,canApprove:true});
  const found=await manager(lead,'lookup',{booth:club,studentNumber:'21001'});
  assert.equal(found.accounts.length,1); assert.equal(found.accounts[0].email,null); assert.equal(found.accounts[0].visited,false);
  await assert.rejects(manager(lead,'visit_approve',{booth:club,studentNumber:'21001',reason:'x'},randomUUID()),/INVALID_INPUT/);
  const request=randomUUID();
  const r=await manager(lead,'visit_approve',{booth:club,studentNumber:'21001',reason:'Synthetic booth visit'},request);
  assert.equal(r.result,'EARNED');
  assert.deepEqual(await manager(lead,'visit_approve',{booth:club,studentNumber:'21001',reason:'Synthetic booth visit'},request),r);
  const v=await one('select method,actor_id from festival_ops.visits where user_id=$1 and booth_key=$2',[visitor.uid,club]);
  assert.equal(v.method,'manual'); assert.equal(v.actor_id,lead.uid);
  await assert.rejects(manager(lead,'visit_approve',{booth:other,studentNumber:'21001',reason:'Synthetic booth visit'},randomUUID()),/BOOTH_MANAGER_REQUIRED/);
  // Club members (the manager included) never stamp their own club.
  await assert.rejects(manager(lead,'visit_approve',{booth:club,studentNumber:'11002',reason:'Synthetic member visit'},randomUUID()),/OWN_CLUB_STAMP/);
  await assert.rejects(manager(lead,'visit_approve',{booth:club,studentNumber:'11001',reason:'Synthetic self visit'},randomUUID()),/OWN_CLUB_STAMP/);
  // Two accounts with one 학번: the manager picks by a masked email reference.
  const twins=await manager(lead,'lookup',{booth:club,studentNumber:'21002'});
  assert.equal(twins.accounts.length,2); assert.match(twins.accounts[0].email,/\*\*\*@example\.invalid$/);
  await assert.rejects(manager(lead,'visit_approve',{booth:club,studentNumber:'21002',reason:'Synthetic twin visit'},randomUUID()),/STUDENT_AMBIGUOUS/);
  const pick=twins.accounts[1];
  assert.equal((await manager(lead,'visit_approve',{booth:club,studentNumber:'21002',ref:pick.ref,reason:'Synthetic twin visit'},randomUUID())).result,'EARNED');
  const stamped=(await db.query('select user_id from festival_ops.visits where booth_key=$1 and user_id = any($2)',[club,[twinA.uid,twinB.uid]])).rows;
  assert.equal(stamped.length,1);
  await ops(admin,'booth_save',{booth:club,name:club,status:'closed',floor:1,version:(await one('select version from festival_ops.booths where key=$1',[club])).version});
  await assert.rejects(manager(lead,'visit_approve',{booth:club,studentNumber:'21003',reason:'Synthetic closed'},randomUUID()),/BOOTH_CLOSED/);
  const audit=(await db.query("select action from festival_ops.audit where action like 'booth_manager%'")).rows.map(r=>r.action);
  for(const a of ['booth_manager_grant','booth_manager_save','booth_manager_visit']) assert.ok(audit.includes(a),a);
});
await test('revoking the grant or the club verification ends the role',async()=>{
  await rpc(admin,'select public.festival_review_identity_student($1,$2) value',['revoke',{eventId:event.id,account:{studentNumber:'11001'},reason:'Synthetic revoke'}]).catch(()=>
    db.query('update festival_ops.review_identities set verified=false where user_id=$1',[lead.uid]));
  await db.query('update festival_ops.review_identities set verified=false where user_id=$1',[lead.uid]);
  assert.deepEqual((await manager(lead,'status')).items,[]);
  assert.equal((await grant('list',{})).items[0].active,false);
  await db.query('update festival_ops.review_identities set verified=true where user_id=$1',[lead.uid]);
  assert.equal((await manager(lead,'status')).items.length,1);
  await grant('revoke',{account:{studentNumber:'11001'},booth:club});
  assert.deepEqual((await manager(lead,'status')).items,[]);
  assert.deepEqual((await grant('list',{})).items,[]);
});
await test('notices carry up to four photo paths; participants see them',async()=>{
  const img=n=>`notices/${String(n).repeat(32)}.jpg`;
  const saved=await notice(admin,'save',{id:'',version:0,title:'Synthetic notice',body:'Body',important:true,published:true,images:[img(1),img(2)]});
  const item=saved.items.find(n=>n.id===saved.id); assert.deepEqual(item.images,[img(1),img(2)]);
  const seen=(await rpc(visitor,'select public.festival_notices() value')).items.find(n=>n.id===saved.id);
  assert.deepEqual(seen.images,[img(1),img(2)]);
  await assert.rejects(notice(admin,'save',{id:saved.id,version:1,title:'T',body:'',important:false,published:true,images:['../etc/passwd']}),/INVALID_INPUT/);
  await assert.rejects(notice(admin,'save',{id:saved.id,version:1,title:'T',body:'',important:false,published:true,images:[1,2,3,4,5].map(img)}),/INVALID_INPUT/);
  const edited=await notice(admin,'save',{id:saved.id,version:1,title:'Synthetic notice',body:'Body',important:true,published:true,images:[]});
  assert.deepEqual(edited.items.find(n=>n.id===saved.id).images,[]);
  // Older clients without the field keep working.
  const plain=await notice(admin,'save',{id:'',version:0,title:'Plain',body:'',important:false,published:true});
  assert.deepEqual(plain.items.find(n=>n.id===plain.id).images,[]);
  assert.equal(await rpc(admin,'select public.festival_is_operator() value'),true);
  assert.equal(await rpc(visitor,'select public.festival_is_operator() value'),false);
});
await test('rollback removes the manager role and keeps booth programs',async()=>{
  await sql('operations-server/booth-managers-rollback.sql');
  assert.equal(Number((await one("select count(*) n from pg_proc where proname like 'festival_booth_manager%'")).n),0);
  assert.equal((await one('select program from festival_ops.booths where key=$1',[club])).program.title,'Synthetic program');
  await sql('operations-server/booth-managers.sql');
});

await test('notice photo rollback restores the earlier notice functions',async()=>{
  await sql('operations-server/notice-images-rollback.sql');
  const item=(await rpc(visitor,'select public.festival_notices() value')).items[0];
  assert.equal('images' in item,false);
  await sql('operations-server/notice-images.sql');
  assert.ok('images' in (await rpc(visitor,'select public.festival_notices() value')).items[0]);
});

const failed=results.filter(r=>!r.ok);
console.log(`${results.length-failed.length}/${results.length} passed`);
if(failed.length) process.exit(1);
