// 1.54 private ratings and reviews (operations-server/reviews-private.sql) on synthetic, in-memory PostgreSQL only.
// Never connects to the shared project.
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
async function rpc(a,q,args=[]) {
  await db.exec('begin');
  try {
    await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:a.id,session_id:a.session,role:'authenticated'})]);
    await db.exec('set local role authenticated');
    const row=await one(q,args); await db.exec('commit'); return row?.value;
  } catch(e) {await db.exec('rollback'); throw e;}
}
const ops=(a,action,payload)=>rpc(a,'select public.festival_ops_write($1,$2,$3) value',[action,payload,randomUUID()]);
const read=(a,kind,query={})=>rpc(a,'select public.festival_ops_read($1,$2) value',[kind,query]);
const legacy=(a,booth)=>rpc(a,'select public.festival_booth_reviews($1) value',[booth]);
async function account(sid,isAdmin=false) {
  const a={id:randomUUID(),session:randomUUID()};
  await db.query(`insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data) values($1,$2,now(),'{"provider":"google"}',$3)`,[a.id,`${a.id}@example.invalid`,{festival_name:'Synthetic',festival_student_number:sid}]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[a.session,a.id]);
  a.uid=(await rpc(a,'select public.festival_nfc_profile() value')).id;
  if(isAdmin) await db.query('update public.users set admin=true where id=$1',[a.uid]);
  return a;
}
async function test(name,fn) {try {await fn();results.push({name,ok:true});console.log('PASS',name);}catch(e){results.push({name,ok:false,error:e.message});console.log('FAIL',name,e.message);}}

for(const f of ['nfc-server/isolated-test/shim.sql','nfc-server/install.sql','nfc-server/admin-issue.sql','nfc-server/updates/20260930-nonexpiring-tags.sql','nfc-server/reviews.sql','operations-server/install.sql']) await sql(f);
const admin=await account('29999',true);
const event=(await ops(admin,'event_save',{name:'Synthetic review event',state:'open',reviewPoints:10,version:0})).event;
for(const f of ['review-identity.draft','reward-visits','reward-fixed-milestones','voucher-unlimited-and-reset','review-identity-self','voucher-short-code','review-distribution-self-redeem','nfc-tag-registry','claim-guard','booth-bulk-and-tag-register','notices','operator-identity-and-scoped-reset','self-identity-and-own-club-stamps','student-number-display','student-number-only','operator-self-actions','sun-nfc','identity-required']) await sql(`operations-server/${f}.sql`);
const catalog=(await db.query('select key from festival_ops.booths where event_id=$1 order by key collate "C"',[event.id])).rows.map(r=>r.key);
const [own,away]=catalog;
for(const booth of [own,away]) await ops(admin,'booth_save',{booth,name:booth,status:'open',floor:1,version:1});
const numbers=['11001','11002','11003'];
await db.query('select festival_ops.import_review_roster($1,$2,$3)',[event.id,{format:1,sourceSha256:'f'.repeat(64),catalogKeys:catalog,
  records:numbers.map((studentNumber,i)=>({studentNumber,realName:`Synthetic ${i+1}`,clubs:['Synthetic Club'],boothKeys:[own],status:'ready',issues:[],sourceCells:['Synthetic!A1']}))},admin.uid]);
const students=[];
for(const [i,sid] of numbers.entries()) {
  const a=await account(sid);
  assert.equal((await rpc(a,'select public.festival_review_identity_self($1,$2) value',['confirm',{eventId:event.id,realName:`Synthetic ${i+1}`}])).result,'CONFIRMED');
  students.push(a);
}
const [first,second,reader]=students;
for(const [i,rating] of [[0,5],[1,3]]) {
  await rpc(admin,'select public.festival_ops_write_student($1,$2,$3) value',['visit_approve',{booth:away,studentNumber:numbers[i],reason:'Synthetic visit'},randomUUID()]);
  await ops(students[i],'review_save',{booth:away,rating,content:`Synthetic review ${rating}`});
}
// Legacy ratings (read only when no festival is running) for the same accounts.
const legacyBooth=(await one('select id::text id from public.booths order by id limit 1')).id;
// New legacy writes are blocked by a trigger; these stand for rows written before that.
await db.exec("set session_replication_role = replica");
for(const [a,rating] of [[first,4],[second,2]]) await db.query('insert into public.booth_ratings(user_id,booth_id,rating,content) values($1,$2::public.booth_enum,$3,$4)',[a.uid,legacyBooth,rating,'Synthetic legacy']);
await db.exec("set session_replication_role = origin");

// The rollback writes the live project's (LF) text back; repo files loaded on Windows are CRLF.
const patched=['public.festival_ops_read(text,jsonb)','public.festival_ops_write(text,jsonb,uuid)','festival_ops.review_summary(uuid,integer,text)','festival_nfc_private.booth_reviews(text)'];
const sources=()=>Promise.all(patched.map(f=>one("select md5(replace(prosrc,chr(13),'')) m from pg_proc where oid=$1::regprocedure",[f]).then(r=>r.m)));
const before=await sources();
const everyone=await read(reader,'reviews',{booth:away});

await sql('operations-server/reviews-private.sql');
const rating=async(a,booth)=>(await read(a,'catalog')).items.find(b=>b.key===booth).rating;
const currentEvent=()=>read(admin,'me').then(r=>r.event);

await test('before the change every participant saw both reviews',async()=>{
  assert.equal(everyone.count,2); assert.equal(everyone.reviews.length,2);
});

await test('private by default: a student sees nothing of other participants',async()=>{
  assert.equal((await currentEvent()).reviews_public,false);
  const r=await read(reader,'reviews',{booth:away});
  assert.equal(r.visible,false); assert.equal(r.count,0); assert.equal(r.average,null);
  assert.deepEqual(r.reviews,[]); assert.equal(r.myRating,null);
  assert.deepEqual(r.distribution,{1:0,2:0,3:0,4:0,5:0});
  assert.equal(await rating(reader,away),null);
});

await test('a reviewer still sees exactly their own review and nothing else',async()=>{
  const r=await read(second,'reviews',{booth:away});
  assert.equal(r.visible,false); assert.equal(r.count,1); assert.equal(Number(r.average),3); assert.equal(r.myRating,3);
  assert.equal(r.reviews.length,1); assert.equal(r.reviews[0].mine,true); assert.equal(r.reviews[0].content,'Synthetic review 3');
  assert.equal(r.distribution[5],0);
});

await test('operators always see every rating and review',async()=>{
  const r=await read(admin,'reviews',{booth:away});
  assert.equal(r.visible,true); assert.equal(r.count,2); assert.equal(Number(r.average),4);
  assert.equal(Number(await rating(admin,away)),4);
  const l=await legacy(admin,legacyBooth);
  assert.equal(l.visible,true); assert.equal(l.count,2);
});

await test('the legacy review path follows the same rule',async()=>{
  const l=await legacy(first,legacyBooth);
  assert.equal(l.visible,false); assert.equal(l.count,1); assert.equal(l.reviews.length,1); assert.equal(l.reviews[0].mine,true);
  assert.equal((await legacy(reader,legacyBooth)).count,0);
});

await test('opening reviews in 관리 마법사 shows them to every participant',async()=>{
  let e=await currentEvent();
  await assert.rejects(ops(reader,'event_save',{name:e.name,state:e.state,reviewPoints:e.review_points,reviewsPublic:true,version:e.version}),/ADMIN_REQUIRED/);
  e=(await ops(admin,'event_save',{name:e.name,state:e.state,reviewPoints:e.review_points,reviewsPublic:true,version:e.version})).event;
  assert.equal(e.reviews_public,true);
  const r=await read(reader,'reviews',{booth:away});
  assert.equal(r.visible,true); assert.equal(r.count,2); assert.equal(r.reviews.length,2);
  assert.equal(Number(await rating(reader,away)),4);
  assert.equal((await legacy(reader,legacyBooth)).count,2);
  // Saving the settings without the field, or with a non-boolean, keeps the switch as it is.
  e=(await ops(admin,'event_save',{name:e.name,state:e.state,reviewPoints:e.review_points,version:e.version})).event;
  assert.equal(e.reviews_public,true);
  e=(await ops(admin,'event_save',{name:e.name,state:e.state,reviewPoints:e.review_points,reviewsPublic:'no',version:e.version})).event;
  assert.equal(e.reviews_public,true);
  e=(await ops(admin,'event_save',{name:e.name,state:e.state,reviewPoints:e.review_points,reviewsPublic:false,version:e.version})).event;
  assert.equal(e.reviews_public,false);
  assert.equal((await read(reader,'reviews',{booth:away})).count,0);
});

await test('the helper is not callable by participants',async()=>{
  assert.equal((await one("select has_function_privilege('authenticated','festival_ops.reviews_visible(uuid,integer)','execute') v")).v,false);
});

await test('the rollback restores all four functions exactly and drops the switch',async()=>{
  await sql('operations-server/reviews-private-rollback.sql');
  assert.deepEqual(await sources(),before);
  assert.equal((await one("select count(*)::int n from information_schema.columns where table_schema='festival_ops' and table_name='events' and column_name='reviews_public'")).n,0);
  assert.equal((await read(reader,'reviews',{booth:away})).count,2);
});

await db.close();
const failed=results.filter(r=>!r.ok);
console.log(`${results.length-failed.length}/${results.length} passed`);
if(failed.length) process.exit(1);
