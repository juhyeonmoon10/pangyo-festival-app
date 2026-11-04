// Five missing club booths (operations-server/club-booths-added.sql) on synthetic, in-memory PostgreSQL only.
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
// A refused file leaves its transaction open; close it so later steps run.
const refusedFile=(f,code)=>assert.rejects(sql(f).finally(()=>db.exec('rollback').catch(()=>{})),code);
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
const self=(a,action,payload={})=>rpc(a,'select public.festival_review_identity_self($1,$2) value',[action,payload]);
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
// ORBIT tables the shim does not carry, used only by the rollback's in-use check.
await db.exec('create schema if not exists private; create table private.booth_nfc_tokens(booth_id public.booth_enum); create table public.stock(booth_id public.booth_enum);');
const admin=await account('29999',true);
const event=(await ops(admin,'event_save',{name:'Synthetic club event',state:'open',reviewPoints:10,version:0})).event;
for(const f of ['review-identity.draft','reward-visits','reward-fixed-milestones','voucher-unlimited-and-reset','review-identity-self','voucher-short-code','review-distribution-self-redeem','nfc-tag-registry','claim-guard','booth-bulk-and-tag-register','notices','operator-identity-and-scoped-reset','self-identity-and-own-club-stamps','student-number-display','student-number-only','operator-self-actions','sun-nfc','booth-managers','identity-required','reviews-private','identity-no-attempt-limit']) await sql(`operations-server/${f}.sql`);
const catalogKeys=async()=>(await db.query('select key from festival_ops.booths where event_id=$1 order by key collate "C"',[event.id])).rows.map(r=>r.key);
const before=await catalogKeys();
const existing=before[0];
// Roster clubs are stored without spaces, the way tools/import-review-roster.cjs writes them.
const record=(studentNumber,clubs,boothKeys)=>({studentNumber,realName:'Synthetic One',clubs,boothKeys,status:'ready',issues:[],sourceCells:['Synthetic!A1']});
await db.query('select festival_ops.import_review_roster($1,$2,$3)',[event.id,{format:1,sourceSha256:'e'.repeat(64),catalogKeys:before,records:[
  record('11001',['축구반'],[]), record('11002',['바이오브릿지'],[]), record('11003',[existing.replace(/\s/g,'')],[existing]), record('11004',['판고흐'],[])]},admin.uid]);
const confirmed=await account('11001'), unconfirmed=await account('11002'), other=await account('11003');
for(const a of [confirmed,other]) assert.equal((await self(a,'confirm',{eventId:event.id,realName:'Synthetic One'})).result,'CONFIRMED');
const state=a=>one('select festival_ops.identity_state($1,$2) s',[event.id,a.uid]).then(r=>r.s);
const own=a=>one('select festival_ops.own_booths($1,$2) k',[event.id,a.uid]).then(r=>r.k);
const policy=(a,b)=>one('select festival_ops.review_policy($1,$2,$3) p',[event.id,a.uid,b]).then(r=>r.p);
const rosterRows=()=>db.query('select student_number,booth_keys,catalog_keys,version from festival_ops.review_roster where event_id=$1 order by student_number',[event.id]).then(r=>r.rows);
const rosterBefore=await rosterRows(), otherBefore=await state(other);

await test('the five booths join ORBIT and the event, linked by legacy_key, open and not yet placed',async()=>{
  await sql('operations-server/club-booths-added.sql');
  const rows=(await db.query(`select b.key,b.legacy_key::text legacy,b.status,b.floor,b.location,p.name orbit from festival_ops.booths b
    left join public.booths p on p.id=b.legacy_key where b.event_id=$1 and b.key = any($2) order by b.key`,[event.id,['바이오 브릿지','스크린에세이스트','수학창의탐구반','미디어비평반','축구반']])).rows;
  assert.equal(rows.length,5);
  for(const r of rows) assert.deepEqual([r.legacy,r.status,r.floor,r.location,r.orbit],[r.key,'open',1,'',r.key]);
  assert.equal((await catalogKeys()).length,before.length+5);
});

await test('club members get the new booth; other rows only get the new catalog',async()=>{
  const rows=await rosterRows(), cat=await catalogKeys();
  assert.deepEqual(rows.map(r=>r.booth_keys),[['축구반'],['바이오 브릿지'],[existing],[]]);
  for(const [i,r] of rows.entries()) { assert.deepEqual(r.catalog_keys,cat); assert.equal(r.version,rosterBefore[i].version+1); }
});

await test('a confirmed member stays confirmed and is now limited at the own-club booth',async()=>{
  const s=await state(confirmed);
  assert.equal(s.verified,true);
  assert.deepEqual(s.boothKeys,['축구반']);
  assert.deepEqual(await own(confirmed),['축구반']);
  assert.equal((await policy(confirmed,'축구반')).reason,'OWN_CLUB_REVIEW');
  assert.equal((await policy(confirmed,existing)).allowed,true);
});

await test('an unconfirmed member is limited from the roster; other confirmations are unchanged',async()=>{
  assert.deepEqual(await own(unconfirmed),['바이오 브릿지']);
  assert.deepEqual(await state(other),otherBefore);
  assert.equal((await one("select count(*)::int n from festival_ops.audit where action='maintenance_club_booths_added'")).n,1);
});

await test('NFC tags can be issued for a new booth',async()=>{
  const t=await one("select festival_nfc_private.issue_tag('축구반',null) t");
  assert.ok(t.t);
  await db.exec("delete from festival_nfc_private.tags where booth::text='축구반'");
});

await test('running it again refuses',async()=>{
  await refusedFile('operations-server/club-booths-added.sql',/CLUB_BOOTHS_ALREADY_ADDED/);
});

await test('the rollback refuses while a new booth is in use',async()=>{
  await db.exec("insert into public.stock(booth_id) values('축구반')");
  await refusedFile('operations-server/club-booths-added-rollback.sql',/CLUB_BOOTHS_IN_USE/);
  await db.exec("delete from public.stock");
});

await test('the rollback removes the booths and keeps every confirmation',async()=>{
  await sql('operations-server/club-booths-added-rollback.sql');
  assert.deepEqual(await catalogKeys(),before);
  assert.equal((await one("select count(*)::int n from public.booths where id::text = any($1)",[['바이오 브릿지','축구반']])).n,0);
  assert.deepEqual((await rosterRows()).map(r=>[r.booth_keys,r.catalog_keys]),rosterBefore.map(r=>[r.booth_keys,r.catalog_keys]));
  assert.equal((await state(confirmed)).verified,true);
  assert.deepEqual((await state(confirmed)).boothKeys,[]);
  assert.deepEqual(await state(other),otherBefore);
});

await db.close();
const failed=results.filter(r=>!r.ok);
console.log(`${results.length-failed.length}/${results.length} passed`);
if(failed.length) process.exit(1);
