import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dep=path.join(process.env.PGLITE_DIR,'node_modules/@electric-sql/pglite/dist');
const {PGlite}=await import(pathToFileURL(path.join(dep,'index.js')));
const {pgcrypto}=await import(pathToFileURL(path.join(dep,'contrib/pgcrypto.js')));
const db=new PGlite({extensions:{pgcrypto}}), results=[];
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const one=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
async function rpc(a,sql,args=[],role='authenticated') {
  await db.exec('begin');
  try {
    await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:a.id,session_id:a.session,role})]);
    await db.exec(`set local role ${role}`);
    const r=await one(sql,args); await db.exec('commit'); return r?.value;
  } catch(e) { await db.exec('rollback'); throw e; }
}
const write=(a,action,payload,id=randomUUID())=>rpc(a,'select public.festival_ops_write($1,$2,$3) value',[action,payload,id]);
const get=(a,kind,query={})=>rpc(a,'select public.festival_ops_read($1,$2) value',[kind,query]);
const roster=(a,action,payload)=>rpc(a,'select public.festival_review_identity_admin($1,$2) value',[action,payload]);
async function account(admin=false) {
  const a={id:randomUUID(),session:randomUUID()};
  await db.query(`insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data)
    values($1,$2,now(),'{"provider":"google"}','{"festival_name":"Editable display","festival_student_number":"21001"}')`,[a.id,`${a.id}@example.invalid`]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[a.session,a.id]);
  a.uid=(await rpc(a,'select public.festival_nfc_profile() value')).id;
  if(admin) await db.query('update public.users set admin=true where id=$1',[a.uid]);
  return a;
}
async function test(name,fn) { try {await fn();results.push({name,ok:true});console.log('PASS',name);} catch(e){results.push({name,ok:false,error:e.message});console.log('FAIL',name,e.message);} }
for(const f of ['nfc-server/isolated-test/shim.sql','nfc-server/install.sql','nfc-server/admin-issue.sql','nfc-server/reviews.sql','operations-server/install.sql']) await db.exec(read(f));
const admin=await account(true),student=await account(),unknown=await account(),other=await account();
const event=(await write(admin,'event_save',{name:'Synthetic review test',state:'open',reviewPoints:10,version:0})).event;
const own='글빛누리', away='매커니즘', second='인사이트';
for(const booth of [own,away,second]) await write(admin,'booth_save',{booth,version:1,name:booth,floor:1,status:'open'});
for(const a of [student,unknown,other]) for(const booth of [own,away,second]) await write(admin,'visit_approve',{userId:a.uid,booth,reason:'Synthetic verified visit'});
await write(other,'review_save',{booth:away,rating:4,content:''});
await db.exec(read('operations-server/review-identity.draft.sql'));
const payload=(a,keys=[own],version=0)=>({eventId:event.id,userId:a.uid,version,realName:'테스트실명',boothKeys:keys,verified:true,reason:'Synthetic roster check'});
await test('anonymous and direct roster access denied',async()=>{
  await assert.rejects(rpc(admin,"select public.festival_review_identity_admin('get','{}') value",[],'anon'),/permission denied/);
  await assert.rejects(rpc(admin,'select count(*) value from festival_ops.review_identities'),/permission denied/);
});
await test('student cannot read or edit anyone in roster',async()=>{
  for(const action of ['get','save']) await assert.rejects(roster(student,action,payload(student)),/ADMIN_REQUIRED/);
});
await test('admin cannot verify own identity',async()=>await assert.rejects(roster(admin,'save',payload(admin)),/SELF_ADJUSTMENT/));
await test('missing verified membership fails closed',async()=>{
  assert.equal((await get(unknown,'reviews',{booth:away})).reviewPolicy.reason,'REVIEW_IDENTITY_REQUIRED');
  await assert.rejects(write(unknown,'review_save',{booth:away,rating:5,content:''}),/REVIEW_IDENTITY_REQUIRED/);
});
await test('admin registers multiple own-club booths, emits audit',async()=>{
  const r=await roster(admin,'save',payload(student,[own,second]));
  assert.equal(r.version,1); assert.equal(r.verified,true);
  assert.ok((await get(admin,'audit')).items.some(a=>a.action==='review_identity_save'));
});
await test('stale version and wrong event rejected',async()=>{
  await assert.rejects(roster(admin,'save',payload(student)),/VERSION_CONFLICT/);
  await assert.rejects(roster(admin,'save',{...payload(student),eventId:randomUUID()}),/VERSION_CONFLICT/);
});
await test('malformed or unknown membership rejected',async()=>{
  for(const boothKeys of [['not-a-booth'],[null],null]) await assert.rejects(roster(admin,'save',{...payload(unknown),boothKeys}),/INVALID_INPUT/);
});
await test('own club star-only and text reviews are blocked',async()=>{
  for(const booth of [own,second]) {
    assert.equal((await get(student,'reviews',{booth})).reviewPolicy.reason,'OWN_CLUB_REVIEW');
    for(const content of ['', 'Fake praise']) await assert.rejects(write(student,'review_save',{booth,rating:5,content}),/OWN_CLUB_REVIEW/);
  }
});
await test('denial preserves visits, ledger, and review count',async()=>{
  const me=await get(student,'me'); assert.equal(me.visits.length,3);assert.equal(me.reviews.length,0);assert.equal(me.points,0);
});
await test('new unrelated review uses verified name only',async()=>{
  const result=await write(student,'review_save',{booth:away,rating:5,content:''});
  assert.equal(result.reviews.find(r=>r.mine).author,'테스트실명');
  assert.equal(result.reviewPolicy.authorName,'테스트실명');
  assert.ok(!JSON.stringify(result).includes('@example.invalid'));assert.ok(!JSON.stringify(result).includes('21001'));
});
await test('changing editable profile never changes published author',async()=>{
  await db.query(`update auth.users set raw_user_meta_data=raw_user_meta_data||'{"festival_name":"Changed alias"}'::jsonb where id=$1`,[student.id]);
  await rpc(student,'select public.festival_nfc_profile() value');
  assert.equal((await get(student,'reviews',{booth:away})).reviews.find(r=>r.mine).author,'테스트실명');
});
await test('later text and exact retry award points once',async()=>{
  const id=randomUUID(), body={booth:away,rating:5,content:'즐거웠어요'};
  assert.deepEqual(await write(student,'review_save',body,id),await write(student,'review_save',body,id));
  assert.equal((await get(student,'me')).points,10);
});
await test('existing anonymous review is not retroactively unmasked',async()=>{
  await roster(admin,'save',payload(other,[]));
  assert.equal((await get(other,'reviews',{booth:away})).reviews.find(r=>r.mine).author,'참여자');
});
await test('changed membership blocks adding text to old own-club review',async()=>{
  await roster(admin,'save',payload(other,[away],1));
  await assert.rejects(write(other,'review_save',{booth:away,rating:4,content:'Later text'}),/OWN_CLUB_REVIEW/);
});
await test('unverified roster remains blocked; explicitly confirmed no club is allowed',async()=>{
  await roster(admin,'save',{...payload(unknown,[]),verified:false});
  await assert.rejects(write(unknown,'review_save',{booth:own,rating:5}),/REVIEW_IDENTITY_REQUIRED/);
  await roster(admin,'save',payload(unknown,[],1));
  assert.equal((await write(unknown,'review_save',{booth:own,rating:5})).result,'SAVED');
});
await test('old RPC and direct legacy rating insert cannot bypass guard',async()=>{
  await db.query('update public.users set completed_booths=array[$1]::public.booth_enum[] where id=$2',[own,student.uid]);
  await assert.rejects(rpc(student,'select public.festival_review_submit($1,5,null) value',[own]),/REVIEW_POLICY_REQUIRED/);
  await assert.rejects(rpc(student,'insert into public.booth_ratings(user_id,booth_id,rating) values($1,$2,5) returning rating value',[student.uid,own]),/REVIEW_POLICY_REQUIRED|permission denied/);
});
await test('review identity revocation takes effect on next request',async()=>{
  await roster(admin,'save',{...payload(student,[],1),verified:false});
  assert.equal((await get(student,'reviews',{booth:away})).reviewPolicy.allowed,false);
  await assert.rejects(write(student,'review_save',{booth:second,rating:5}),/REVIEW_IDENTITY_REQUIRED/);
});
await test('expired sessions cannot register roster',async()=>{
  await db.query("update auth.sessions set not_after=now()-interval '1 minute' where id=$1",[admin.session]);
  await assert.rejects(roster(admin,'get',payload(student)),/GOOGLE_AUTH_REQUIRED/);
});
fs.mkdirSync(path.join(root,'artifacts/review-identity'),{recursive:true});
fs.writeFileSync(path.join(root,'artifacts/review-identity/isolated.json'),JSON.stringify({at:new Date().toISOString(),environment:'PGlite synthetic auth; no live Supabase or concurrency proof',results},null,2));
await db.close(); process.exitCode=results.some(r=>!r.ok)?1:0;
console.log(`${results.filter(r=>r.ok).length}/${results.length} passed`);
