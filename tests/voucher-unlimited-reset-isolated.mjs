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
const ops=(a,action,payload,id=randomUUID())=>rpc(a,'select public.festival_ops_write($1,$2,$3) value',[action,payload,id]);
const get=(a,kind)=>rpc(a,'select public.festival_ops_read($1) value',[kind]);
const rewards=a=>rpc(a,'select public.festival_reward_read() value');
const reward=(a,action,payload,id=randomUUID())=>rpc(a,'select public.festival_reward_write($1,$2,$3) value',[action,payload,id]);
const reset=(a,payload,id=randomUUID())=>rpc(a,'select public.festival_ops_reset($1,$2) value',[payload,id]);
async function account(admin=false){
  const a={id:randomUUID(),session:randomUUID(),earned:0};
  await db.query(`insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data)
    values($1,$2,now(),'{"provider":"google"}','{"festival_name":"Synthetic","festival_student_number":"21001"}')`,[a.id,`${a.id}@example.invalid`]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[a.session,a.id]);
  a.uid=(await rpc(a,'select public.festival_nfc_profile() value')).id;
  if(admin) await db.query('update public.users set admin=true where id=$1',[a.uid]);return a;
}
async function test(name,fn){try{await fn();results.push({name,ok:true});console.log('PASS',name);}catch(e){results.push({name,ok:false,error:e.message});console.log('FAIL',name,e.message);}}
for(const f of ['nfc-server/isolated-test/shim.sql','nfc-server/install.sql','nfc-server/admin-issue.sql','nfc-server/reviews.sql','operations-server/install.sql','operations-server/review-identity.draft.sql','operations-server/reward-visits.sql','operations-server/reward-fixed-milestones.sql','operations-server/voucher-unlimited-and-reset.sql']) await db.exec(read(f));
const admin=await account(true),admin2=await account(true),photo=await account(),food=await account(),limited=await account();
const event=(await ops(admin,'event_save',{name:'Synthetic voucher test',state:'open',reviewPoints:10,version:0})).event;
const booths=(await get(admin,'catalog')).items.slice(0,8).map(b=>b.key);
for(const booth of booths) await ops(admin,'booth_save',{booth,name:booth,floor:1,status:'open',version:1});
async function earn(a,n){for(let i=a.earned;i<n;i++){await ops(admin,'visit_approve',{booth:booths[i],userId:a.uid,reason:'Synthetic visit check'});a.earned++;}}
const choose=(a,kind)=>reward(a,'reward_choose',{eventId:event.id,kind,firstTarget:3});
async function config(photoStock,foodStock,expiresAt='infinity',enabled=true){
  const s=await rewards(admin),v=k=>s.options.find(o=>o.kind===k)?.version||0;
  return reward(admin,'reward_config',{eventId:event.id,photoStock,foodStock,photoVersion:v('photo'),foodVersion:v('food'),expiresAt,enabled});
}
const vouchers=a=>get(a,'me').then(m=>m.vouchers);
const count=async t=>Number((await one(`select count(*) n from ${t}`)).n);

await test('missing stock key is rejected, explicit null means no limit',async()=>{
  const s=await rewards(admin);
  await assert.rejects(reward(admin,'reward_config',{eventId:event.id,photoStock:null,photoVersion:0,foodVersion:0,expiresAt:'infinity',enabled:true}),/INVALID_INPUT/);
  assert.equal(s.ready,false);
  const r=await config(null,null);
  assert.equal(r.ready,true);
  for(const o of r.options){assert.equal(o.stock,null);assert.equal(o.available,true);assert.equal(o.issued,0);assert.equal(o.expiresAt,'infinity');}
  assert.equal((await one("select count(*) n from festival_ops.rules where reward_kind is not null and stock is null and expires_at='infinity'")).n,2);
});
await test('students see availability but not stock, issued count or version',async()=>{
  const r=await rewards(photo);
  for(const o of r.options){assert.equal(o.available,true);assert.equal('stock' in o,false);assert.equal('issued' in o,false);}
});
await test('unlimited vouchers are issued at exactly 3 and 6 with no deadline',async()=>{
  await earn(photo,3);
  const r=await choose(photo,'photo');
  assert.equal(r.firstChoice,'photo');assert.equal(r.secondIssued,false);
  await earn(photo,6);
  const v=await vouchers(photo);
  assert.deepEqual(v.map(x=>x.title).sort(),['포토부스 이용권','푸드트럭 교환권']);
  assert.ok(v.every(x=>x.expires_at==='infinity' || x.expiresAt==='infinity'));
  await earn(photo,8);
  assert.equal((await vouchers(photo)).length,2);
  const admin_view=await rewards(admin);
  assert.equal(admin_view.options.find(o=>o.kind==='photo').issued,1);
  assert.equal(admin_view.options.find(o=>o.kind==='food').issued,1);
});
await test('a finite stock still stops issuance and cannot drop below issued count',async()=>{
  await assert.rejects(config(0,null),/INVALID_INPUT/);
  await config(1,null);
  await earn(food,3);
  await assert.rejects(choose(food,'photo'),/OUT_OF_STOCK/);
  const r=await choose(food,'food');
  assert.equal(r.firstChoice,'food');
  assert.equal((await rewards(limited)).options.find(o=>o.kind==='photo').available,false);
});
await test('a changed deadline applies to available vouchers too',async()=>{
  const deadline='2099-12-18T09:00:00.000Z';
  await config(null,null,deadline);
  const v=await vouchers(photo);
  assert.ok(v.every(x=>new Date(x.expires_at || x.expiresAt).toISOString()===deadline));
  await assert.rejects(config(null,null,'2000-01-01T00:00:00Z'),/INVALID_INPUT/);
  await config(null,null,'infinity');
});
// Seed records the reset must clear: points, a named review, a legacy rating and stamps.
await db.query("insert into festival_ops.ledger(event_id,user_id,delta,source_key,actor_id,reason) values($1,$2,10,'seed',$3,'Synthetic points')",[event.id,photo.uid,admin.uid]);
await db.exec('set session_replication_role=replica');
await db.query("insert into festival_ops.reviews(event_id,user_id,booth_key,rating,content) values($1,$2,$3,5,'좋아요')",[event.id,photo.uid,booths[0]]);
await db.query("insert into public.booth_ratings(user_id,booth_id,rating) values($1,'글빛누리',4)",[photo.uid]);
await db.query("insert into festival_ops.review_identities(event_id,user_id,real_name,confirmed_by,student_number,roster_version) values($1,$2,'검증학생',$3,'11001',1)",[event.id,food.uid,admin.uid]);
await db.exec('set session_replication_role=origin');
await db.query("update public.booths set rating=4 where id='글빛누리'");
await db.query("update public.users set completed_booths='{글빛누리}' where id=$1",[photo.uid]);

await test('reset is admin-only, needs the confirmation word and the current festival',async()=>{
  await assert.rejects(rpc(photo,'select public.festival_ops_reset($1,$2) value',[{eventId:event.id,confirm:'초기화',identities:true},randomUUID()],'anon'),/permission denied/);
  await assert.rejects(reset(photo,{eventId:event.id,confirm:'초기화',identities:true}),/ADMIN_REQUIRED/);
  await assert.rejects(reset(admin,{eventId:event.id,confirm:'reset',identities:true}),/RESET_CONFIRM_REQUIRED/);
  await assert.rejects(reset(admin,{eventId:randomUUID(),confirm:'초기화',identities:true}),/VERSION_CONFLICT/);
  await assert.rejects(reset(admin,{eventId:event.id,confirm:'초기화'}),/INVALID_INPUT/);
  assert.ok(await count('festival_ops.visits')>0);
});
let resetId=randomUUID(),resetResult;
await test('reset clears participant records and keeps operator flags and setup',async()=>{
  const admins=(await db.query('select id from public.users where admin order by id')).rows.map(r=>r.id);
  const rules=await count('festival_ops.rules'),booths_=await count('festival_ops.booths');
  resetResult=await reset(admin,{eventId:event.id,confirm:'초기화',identities:true},resetId);
  assert.equal(resetResult.reset,true);
  assert.ok(resetResult.visits>0 && resetResult.vouchers>0);
  assert.equal(resetResult.points,1);assert.equal(resetResult.reviews,1);assert.equal(resetResult.ratings,1);assert.equal(resetResult.identities,1);
  for(const t of ['festival_ops.visits','festival_ops.vouchers','festival_ops.reviews','festival_ops.ledger','festival_ops.review_identities','public.booth_ratings']) assert.equal(await count(t),0,t);
  assert.equal((await one('select count(*) n from public.booths where rating<>0')).n,0);
  assert.equal((await one('select count(*) n from public.users where cardinality(completed_booths)>0')).n,0);
  assert.deepEqual((await db.query('select id from public.users where admin order by id')).rows.map(r=>r.id),admins);
  assert.equal(await count('festival_ops.rules'),rules);assert.equal(await count('festival_ops.booths'),booths_);
  const audit=await one("select actor_id,reason from festival_ops.audit where action='participation_reset'");
  assert.equal(audit.actor_id,admin.uid);assert.match(audit.reason,/"visits"/);
});
await test('a repeated reset request replays without deleting new records',async()=>{
  photo.earned=0;await earn(photo,1);
  assert.deepEqual(await reset(admin,{eventId:event.id,confirm:'초기화',identities:true},resetId),resetResult);
  assert.equal(await count('festival_ops.visits'),1);
  await assert.rejects(reset(admin,{eventId:event.id,confirm:'초기화',identities:false},resetId),/REQUEST_CONFLICT/);
});
await test('identities can be kept and vouchers are issued again after reset',async()=>{
  await db.exec('set session_replication_role=replica');
  await db.query("insert into festival_ops.review_identities(event_id,user_id,real_name,confirmed_by,student_number,roster_version) values($1,$2,'검증학생',$3,'11001',1)",[event.id,food.uid,admin.uid]);
  await db.exec('set session_replication_role=origin');
  const r=await reset(admin2,{eventId:event.id,confirm:'초기화',identities:false});
  assert.equal(r.identities,0);assert.equal(await count('festival_ops.review_identities'),1);
  photo.earned=0;await earn(photo,3);
  assert.equal((await choose(photo,'food')).firstChoice,'food');
  assert.equal((await rewards(admin)).options.find(o=>o.kind==='food').issued,1);
});
await test('rollback removes reset and restores a mandatory finite stock',async()=>{
  await db.exec(read('operations-server/voucher-unlimited-and-reset-rollback.sql'));
  assert.equal((await one("select count(*) n from pg_proc where proname='festival_ops_reset'")).n,0);
  assert.equal((await one('select count(*) n from festival_ops.rules where stock is null')).n,0);
  assert.equal((await one("select attnotnull from pg_attribute where attrelid='festival_ops.rules'::regclass and attname='stock'")).attnotnull,true);
  assert.equal((await rewards(admin)).ready,true);
});
const out=path.join(root,'artifacts/voucher-unlimited-reset');fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,'isolated.json'),JSON.stringify(results,null,2));
const failed=results.filter(r=>!r.ok);
console.log(`${results.length-failed.length}/${results.length} passed`);
if(failed.length) process.exitCode=1;
