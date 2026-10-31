// Synthetic, in-memory PostgreSQL only. Never connects to the shared project.
// A small stand-in for Supabase Storage (buckets, objects with row level security) checks the policies.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
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
const manager=(a,action,payload={})=>rpc(a,'select public.festival_booth_manager($1,$2,$3) value',[action,payload,null]);
const grant=(action,payload)=>rpc(admin,'select public.festival_booth_manager_admin($1,$2) value',[action,payload]);
const photo=()=>`booths/${randomBytes(16).toString('hex')}.jpg`;
const upload=(a,name,bucket='festival-booths')=>rpc(a,'insert into storage.objects(bucket_id,name,owner_id) values($1,$2,auth.uid()::text) returning 1 value',[bucket,name]);
const removeObject=(a,name,bucket='festival-booths')=>rpc(a,'with d as (delete from storage.objects where bucket_id=$1 and name=$2 returning 1) select count(*)::integer value from d',[bucket,name]);
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
const event=(await ops(admin,'event_save',{name:'Synthetic profile event',state:'open',reviewPoints:10,version:0})).event;
for(const f of ['review-identity.draft','reward-visits','reward-fixed-milestones','voucher-unlimited-and-reset','review-identity-self','voucher-short-code','review-distribution-self-redeem','nfc-tag-registry','claim-guard','booth-bulk-and-tag-register','notices','operator-identity-and-scoped-reset','self-identity-and-own-club-stamps','student-number-display','student-number-only','operator-self-actions','sun-nfc']) await sql(`operations-server/${f}.sql`);
const catalog=(await db.query('select key from festival_ops.booths where event_id=$1 order by key collate "C"',[event.id])).rows.map(r=>r.key);
const [club,other]=catalog;
for(const booth of [club,other]) await ops(admin,'booth_save',{booth,name:booth,status:'open',floor:1,version:1});
const record=(studentNumber,realName,boothKeys)=>({studentNumber,realName,clubs:['Synthetic Club'],boothKeys,status:'ready',issues:[],sourceCells:['Synthetic!A1']});
await db.query('select festival_ops.import_review_roster($1,$2,$3)',[event.id,{format:1,sourceSha256:'e'.repeat(64),catalogKeys:catalog,
  records:[record('11001','Manager One',[club]),record('29999','Synthetic Admin',[])]},admin.uid]);
const lead=await account('11001'),visitor=await account('21001');
await rpc(lead,'select public.festival_review_identity_self($1,$2) value',['confirm',{eventId:event.id,realName:'Manager One'}]);
await db.exec(`create schema storage;
  create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner_id text, unique(bucket_id, name));
  alter table storage.objects enable row level security;
  grant usage on schema storage to authenticated;
  grant select, insert, delete on storage.objects to authenticated;`);
for(const f of ['booth-managers','notice-images','booth-profile']) await sql(`operations-server/${f}.sql`);

await test('the photo bucket exists; only operators and active managers upload',async()=>{
  const bucket=await one("select public,file_size_limit,allowed_mime_types from storage.buckets where id='festival-booths'");
  assert.equal(bucket.public,true); assert.equal(Number(bucket.file_size_limit),3145728);
  await assert.rejects(upload(lead,photo()),/row-level security/);
  await assert.rejects(upload(visitor,photo()),/row-level security/);
  await grant('grant',{account:{studentNumber:'11001'},booth:club,canApprove:false});
  assert.equal(await upload(lead,photo()),1);
  await assert.rejects(upload(lead,'booths/../../etc.jpg'),/row-level security/);
  await assert.rejects(upload(visitor,photo()),/row-level security/);
});
await test('a manager sets photo, hours, floor, map room and location of their booth',async()=>{
  const mine=(await manager(lead,'status')).items[0];
  assert.equal(mine.room,''); assert.equal(mine.image,'');
  const pic=photo(); await upload(lead,pic);
  const saved=await manager(lead,'save',{booth:club,version:mine.version,status:'open',description:'Intro',
    program:{title:'Program',hours:'10:00-15:00'},location:'3층 다목적강당 입구',floor:3,room:'다목적강당',image:pic});
  assert.equal(saved.floor,3); assert.equal(saved.room,'다목적강당'); assert.equal(saved.location,'3층 다목적강당 입구');
  assert.equal(saved.image,pic); assert.equal(saved.program.hours,'10:00-15:00');
  const read=await rpc(visitor,"select public.festival_ops_read('catalog','{}') value");
  const row=(read.items || read).find(b=>b.key===club);
  assert.equal(row.image,pic); assert.equal(row.room,'다목적강당'); assert.equal(row.floor,3);
  // Keys left out keep their value: a client from before this change.
  const kept=await manager(lead,'save',{booth:club,version:saved.version,status:'paused',description:'Intro',program:saved.program});
  assert.equal(kept.image,pic); assert.equal(kept.room,'다목적강당'); assert.equal(kept.floor,3); assert.equal(kept.status,'paused');
  const cleared=await manager(lead,'save',{booth:club,version:kept.version,status:'open',description:'Intro',program:saved.program,location:'',floor:1,room:'',image:''});
  assert.equal(cleared.image,''); assert.equal(cleared.room,''); assert.equal(cleared.floor,1);
  const audit=await one("select reason from festival_ops.audit where action='booth_manager_save' order by id desc limit 1");
  assert.match(audit.reason,/^open · 1층$/);
});
await test('photos must be the manager\'s own upload in the bucket; fields are checked',async()=>{
  const b=(await manager(lead,'status')).items[0], base={booth:club,version:b.version,status:'open',description:'Intro',program:{}};
  await assert.rejects(manager(lead,'save',{...base,image:photo()}),/BOOTH_IMAGE_NOT_FOUND/);
  const operatorPic=photo(); await upload(admin,operatorPic);
  await assert.rejects(manager(lead,'save',{...base,image:operatorPic}),/BOOTH_IMAGE_NOT_FOUND/);
  for(const bad of [{floor:5},{floor:'2'},{floor:2.5},{room:'x'.repeat(41)},{location:'x'.repeat(201)},{location:'a\nb'},{image:'../x.jpg'},{image:'notices/'+'0'.repeat(32)+'.jpg'},{room:3}])
    await assert.rejects(manager(lead,'save',{...base,...bad}),/INVALID_INPUT/,JSON.stringify(bad));
  await assert.rejects(manager(lead,'save',{...base,booth:other,image:''}),/BOOTH_MANAGER_REQUIRED/);
  // Operators may use any photo in the bucket, for any booth.
  const all=(await manager(admin,'status')).items.find(x=>x.key===other);
  assert.equal((await manager(admin,'save',{booth:other,version:all.version,status:'open',description:'',program:{},image:operatorPic,floor:2,room:'2-1'})).image,operatorPic);
});
await test('owners and operators read back and delete photos; others cannot',async()=>{
  const pic=photo(); await upload(lead,pic);
  assert.equal(await removeObject(visitor,pic),0);
  assert.equal(await removeObject(lead,pic),1);
  const operatorPic=photo(); await upload(admin,operatorPic);
  assert.equal(await removeObject(lead,operatorPic),0);
  assert.equal(await removeObject(admin,operatorPic),1);
  // Notice photos: operators can now delete them (the delete returns the removed row).
  const notice=`notices/${randomBytes(16).toString('hex')}.jpg`;
  await upload(admin,notice,'festival-notices');
  assert.equal(await removeObject(visitor,notice,'festival-notices'),0);
  assert.equal(await removeObject(admin,notice,'festival-notices'),1);
});
await test('a manager whose role ended can no longer upload',async()=>{
  await grant('revoke',{account:{studentNumber:'11001'},booth:club});
  await assert.rejects(upload(lead,photo()),/row-level security/);
  await grant('grant',{account:{studentNumber:'11001'},booth:club,canApprove:false});
});
await test('rollback then booth-managers.sql restores the earlier function and keeps the data',async()=>{
  const b=(await manager(lead,'status')).items[0], pic=photo(); await upload(lead,pic);
  await manager(lead,'save',{booth:club,version:b.version,status:'open',description:'Intro',program:{},image:pic,room:'시청각실',floor:1});
  await sql('operations-server/booth-profile-rollback.sql');
  await sql('operations-server/booth-managers.sql');
  const after=(await manager(lead,'status')).items[0];
  assert.equal('room' in after,false);
  const row=await one('select image,room from festival_ops.booths where key=$1',[club]);
  assert.equal(row.image,pic); assert.equal(row.room,'시청각실');
  assert.equal(Number((await one("select count(*) n from pg_policies where policyname like 'festival_booth_images%'")).n),0);
  await sql('operations-server/booth-profile.sql');
  assert.equal((await manager(lead,'status')).items[0].room,'시청각실');
});

const failed=results.filter(r=>!r.ok);
console.log(`${results.length-failed.length}/${results.length} passed`);
if(failed.length) process.exit(1);
