// 1.58 club check without an attempt limit (operations-server/identity-no-attempt-limit.sql) on synthetic,
// in-memory PostgreSQL only. Never connects to the shared project.
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
const admin=await account('29999',true);
const event=(await ops(admin,'event_save',{name:'Synthetic identity event',state:'open',reviewPoints:10,version:0})).event;
for(const f of ['review-identity.draft','reward-visits','reward-fixed-milestones','voucher-unlimited-and-reset','review-identity-self','voucher-short-code','review-distribution-self-redeem','nfc-tag-registry','claim-guard','booth-bulk-and-tag-register','notices','operator-identity-and-scoped-reset','self-identity-and-own-club-stamps','student-number-display','student-number-only','operator-self-actions','sun-nfc','identity-required','reviews-private']) await sql(`operations-server/${f}.sql`);
const catalog=(await db.query('select key from festival_ops.booths where event_id=$1 order by key collate "C"',[event.id])).rows.map(r=>r.key);
await db.query('select festival_ops.import_review_roster($1,$2,$3)',[event.id,{format:1,sourceSha256:'e'.repeat(64),catalogKeys:catalog,
  records:['11001','11002','11003','11004'].map(studentNumber=>({studentNumber,realName:'Synthetic One',clubs:['Synthetic Club'],boothKeys:[catalog[0]],status:'ready',issues:[],sourceCells:['Synthetic!A1']}))},admin.uid]);
const fn='public.festival_review_identity_self(text,jsonb)';
const def=()=>one('select pg_get_functiondef($1::regprocedure) d',[fn]).then(r=>r.d);
const confirm=(a,realName)=>self(a,'confirm',{eventId:event.id,realName});

const lockedStudent=await account('11001');
await test('before the patch, five wrong names in an hour lock the check (the old behaviour)',async()=>{
  for(let i=0;i<5;i++) assert.equal((await confirm(lockedStudent,'Wrong Name')).result,'IDENTITY_MISMATCH');
  assert.equal((await confirm(lockedStudent,'Synthetic One')).result,'TOO_MANY_ATTEMPTS');
});

// The live project stores LF bodies; a Windows checkout loads CRLF ones. Both must patch and roll back exactly.
for(const [ending,number] of [['\r\n','11002'],['\n','11003']]) {
  const label=ending==='\n'?'LF':'CRLF';
  await db.exec((await def()).replace(/\r?\n/g,ending));
  const before=await def();
  await sql('operations-server/identity-no-attempt-limit.sql');
  const after=await def();

  await test(`${label}: the count and the limit are gone, nothing else changes`,async()=>{
    assert.doesNotMatch(after,/failures|TOO_MANY_ATTEMPTS/);
    assert.equal(after.split(/\r?\n/).length,before.split(/\r?\n/).length-3);
    assert.match(after,new RegExp(`student_number=sid and user_id<>u and verified;${ending}      if roster\\.student_number is null or`));
  });

  await test(`${label}: many wrong names never lock the check, and the right name still confirms`,async()=>{
    const student=await account(number);
    for(let i=0;i<8;i++) assert.equal((await confirm(student,'Wrong Name')).result,'IDENTITY_MISMATCH');
    assert.equal((await confirm(student,'Synthetic One')).result,'CONFIRMED');
    const audited=await one("select count(*)::int n from festival_ops.audit where actor_id=$1 and action='review_identity_self_mismatch'",[student.uid]);
    assert.equal(audited.n,8);
  });

  if(label==='CRLF') await test('the student locked before the patch can confirm right away',async()=>{
    assert.equal((await confirm(lockedStudent,'Synthetic One')).result,'CONFIRMED');
  });

  await test(`${label}: the rollback restores the function exactly`,async()=>{
    await sql('operations-server/identity-no-attempt-limit-rollback.sql');
    assert.equal(await def(),before);
  });
}

await test('running the patch twice changes nothing the second time; the rollback refuses a limited body',async()=>{
  await sql('operations-server/identity-no-attempt-limit.sql');
  const patched=await def();
  await sql('operations-server/identity-no-attempt-limit.sql');
  assert.equal(await def(),patched);
  await sql('operations-server/identity-no-attempt-limit-rollback.sql');
  await assert.rejects(sql('operations-server/identity-no-attempt-limit-rollback.sql'),/already limited/);
});

await db.close();
const failed=results.filter(r=>!r.ok);
console.log(`${results.length-failed.length}/${results.length} passed`);
if(failed.length) process.exit(1);
