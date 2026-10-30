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
const self=(a,action='status')=>rpc(a,'select public.festival_review_identity_self($1,$2) value',[action,{eventId:event.id,realName:'Synthetic One'}]);
const identify=(action,payload)=>rpc(admin,'select public.festival_review_identity_admin($1,$2) value',[action,{eventId:event.id,...payload}]);
const reset=(id=randomUUID(),a=admin,p={})=>rpc(a,'select public.festival_ops_reset($1,$2) value',[{eventId:event.id,confirm:'\uCD08\uAE30\uD654',identities:false,...p},id]);
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
const event=(await ops(admin,'event_save',{name:'Synthetic safety event',state:'open',reviewPoints:10,version:0})).event;
for(const f of ['operations-server/review-identity.draft.sql','operations-server/reward-visits.sql','operations-server/reward-fixed-milestones.sql','operations-server/voucher-unlimited-and-reset.sql','operations-server/review-identity-self.sql','operations-server/voucher-short-code.sql','operations-server/review-distribution-self-redeem.sql','operations-server/nfc-tag-registry.sql','operations-server/claim-guard.sql','operations-server/booth-bulk-and-tag-register.sql','operations-server/notices.sql']) await sql(f);
const catalog=(await db.query('select key from festival_ops.booths where event_id=$1 order by key collate "C"',[event.id])).rows.map(r=>r.key);
const [own,away]=catalog;
for(const booth of [own,away]) await ops(admin,'booth_save',{booth,name:booth,status:'open',floor:1,version:1});
await db.query('select festival_ops.import_review_roster($1,$2,$3)',[event.id,{format:1,sourceSha256:'d'.repeat(64),catalogKeys:catalog,records:[{studentNumber:'11001',realName:'Synthetic One',clubs:['Synthetic Club'],boothKeys:[own],status:'ready',issues:[],sourceCells:['Synthetic!A1']}]},admin.uid]);
const student=await account('11001'),impostor=await account('11001'),outsider=await account('11002');
assert.equal((await self(impostor,'confirm')).result,'CONFIRMED','historical vulnerability fixture');
await ops(admin,'visit_approve',{booth:away,userId:impostor.uid,reason:'Synthetic fixture'});
await ops(impostor,'review_save',{booth:away,rating:4,content:''});
const before=await one('select (select count(*) from festival_ops.review_identities) links,(select count(*) from festival_ops.reviews) reviews');
await sql('operations-server/operator-identity-and-scoped-reset.sql');

await test('install preserves identity records and published reviews',async()=>{
  assert.deepEqual(await one('select (select count(*) from festival_ops.review_identities) links,(select count(*) from festival_ops.reviews) reviews'),before);
});
await test('historical self-approval and known name no longer grant identity',async()=>{
  const old=await self(impostor); assert.equal(old.verified,false); assert.equal(old.realName,null); assert.deepEqual(old.clubs,[]);
  assert.equal((await self(student,'confirm')).result,'OPERATOR_LOCKED');
  assert.equal((await self(impostor,'confirm')).result,'OPERATOR_LOCKED');
  await assert.rejects(ops(impostor,'review_save',{booth:away,rating:4,content:'New content'}),/REVIEW_IDENTITY_REQUIRED/);
});
await test('operators can revoke the wrong link and confirm the actual student',async()=>{
  const bad=await identify('get',{userId:impostor.uid});
  await identify('revoke',{userId:impostor.uid,version:bad.version,reason:'Verified wrong account'});
  const good=await identify('lookup',{userId:student.uid,studentNumber:'11001'});
  await identify('save',{userId:student.uid,studentNumber:'11001',version:good.version,rosterVersion:good.roster.version,confirmed:true,reason:'Independent identity check'});
  assert.equal((await self(student)).verified,true);
  assert.equal((await self(impostor)).verified,false);
});
await test('verified names and own-club restrictions remain authoritative',async()=>{
  for(const booth of [own,away]) await ops(admin,'visit_approve',{booth,userId:student.uid,reason:'Synthetic check'});
  await assert.rejects(ops(student,'review_save',{booth:own,rating:5,content:''}),/OWN_CLUB_REVIEW/);
  await ops(student,'review_save',{booth:away,rating:5,content:'Synthetic review'});
  assert.equal((await one('select author_name from festival_ops.reviews where user_id=$1',[student.uid])).author_name,'Synthetic One');
  await db.query("update auth.users set raw_user_meta_data=raw_user_meta_data||'{\"festival_student_number\":\"11002\"}'::jsonb where id=$1",[student.id]);
  assert.equal((await self(student)).studentNumber,'11001');
});
await test('anonymous callers and students cannot reset or approve identities',async()=>{
  await assert.rejects(rpc(student,"select public.festival_review_identity_self('status','{}') value",[],'anon'),/permission denied/);
  await assert.rejects(reset(randomUUID(),student),/ADMIN_REQUIRED/);
  await assert.rejects(rpc(student,'select public.festival_review_identity_admin($1,$2) value',['list',{eventId:event.id}]),/ADMIN_REQUIRED/);
  await assert.rejects(reset(randomUUID(),admin,{confirm:'wrong'}),/RESET_CONFIRM_REQUIRED/);
});
const tag=(await one('select festival_nfc_private.issue_tag($1,null) t',[away])).t;
await ops(outsider,'claim',{token:tag});
const unvisited=await account('11003');
await db.query('update public.users set completed_quests=array[\'other-team-quest\'],money=47,completed_booths=array[$2]::public.booth_enum[] where id=$1',[unvisited.uid,own]);
await db.query('update public.users set completed_quests=array[\'keep-this-quest\'],completed_booths=array_append(completed_booths,$2::public.booth_enum) where id=$1',[outsider.uid,own]);
await db.exec('set session_replication_role=replica');
await db.query('insert into public.booth_ratings(user_id,booth_id,rating) values($1,$2,4)',[unvisited.uid,own]);
await db.exec('set session_replication_role=origin');
const resetId=randomUUID();
await test('reset clears only this festival and its NFC-backed legacy stamps',async()=>{
  const r=await reset(resetId); assert.equal(r.reset,true); assert.ok(r.visits>0); assert.equal(r.ratings,0);
  assert.equal((await one('select count(*) n from festival_ops.visits where event_id=$1',[event.id])).n,0);
  const member=await one('select to_jsonb(completed_booths) b,to_jsonb(completed_quests) q from public.users where id=$1',[outsider.uid]);
  assert.deepEqual(member.b,[own]); assert.deepEqual(member.q,['keep-this-quest']);
  const other=await one('select to_jsonb(completed_booths) b,to_jsonb(completed_quests) q,money from public.users where id=$1',[unvisited.uid]);
  assert.deepEqual(other,{b:[own],q:['other-team-quest'],money:47});
  assert.equal((await one('select count(*) n from public.booth_ratings where user_id=$1',[unvisited.uid])).n,1);
  assert.equal((await one('select sum(use_count)::int n from festival_nfc_private.tags')).n,1);
  assert.equal((await self(student)).verified,true);
});
await test('NFC can earn a fresh stamp after reset; repeated reset never deletes new visits',async()=>{
  assert.equal((await ops(outsider,'claim',{token:tag})).result,'EARNED');
  await reset(resetId);
  assert.equal((await one('select count(*) n from festival_ops.visits where event_id=$1',[event.id])).n,1);
  await reset();
  await ops(outsider,'claim',{token:tag});
  await reset(resetId);
  assert.equal((await one('select count(*) n from festival_ops.visits where event_id=$1',[event.id])).n,1);
});
await test('ambiguous multi-event reset is refused without touching either event',async()=>{
  await db.query("insert into festival_ops.events(name,current,state) values('Historical event',false,'closed')");
  const requests=(await one('select count(*) n from festival_ops.requests')).n;
  await assert.rejects(reset(),/RESET_SCOPE_UNAVAILABLE/);
  assert.equal((await one('select count(*) n from festival_ops.visits where event_id=$1',[event.id])).n,1);
  assert.equal((await one('select count(*) n from festival_ops.requests')).n,requests);
});
const out=path.join(root,'artifacts/operator-safety'); fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,'isolated.json'),JSON.stringify(results,null,2));
await db.close();
console.log(`${results.filter(r=>r.ok).length}/${results.length} passed`);
if(results.some(r=>!r.ok)) process.exitCode=1;
