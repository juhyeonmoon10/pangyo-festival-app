// 1.53 club check at sign-up (operations-server/identity-required.sql) on synthetic, in-memory PostgreSQL only.
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
const self=(a,action,payload={})=>rpc(a,'select public.festival_review_identity_self($1,$2) value',[action,payload]);
const sunClaim=a=>rpc(a,'select public.festival_sun_claim($1,$2) value',[{picc:'0'.repeat(32),cmac:'0'.repeat(16)},randomUUID()]);
async function account(sid,isAdmin=false) {
  const a={id:randomUUID(),session:randomUUID()};
  await db.query(`insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data) values($1,$2,now(),'{"provider":"google"}',$3)`,[a.id,`${a.id}@example.invalid`,{festival_name:'Synthetic',festival_student_number:sid}]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[a.session,a.id]);
  a.uid=(await rpc(a,'select public.festival_nfc_profile() value')).id;
  if(isAdmin) await db.query('update public.users set admin=true where id=$1',[a.uid]);
  return a;
}
async function test(name,fn) {try {await fn();results.push({name,ok:true});console.log('PASS',name);}catch(e){results.push({name,ok:false,error:e.message});console.log('FAIL',name,e.message);}}
const refused=async(promise,code)=>assert.match(await promise.then(()=>'accepted',e=>e.message),new RegExp(code));

for(const f of ['nfc-server/isolated-test/shim.sql','nfc-server/install.sql','nfc-server/admin-issue.sql','nfc-server/updates/20260930-nonexpiring-tags.sql','nfc-server/reviews.sql','operations-server/install.sql']) await sql(f);
const admin=await account('29999',true);
const event=(await ops(admin,'event_save',{name:'Synthetic identity event',state:'open',reviewPoints:10,version:0})).event;
for(const f of ['review-identity.draft','reward-visits','reward-fixed-milestones','voucher-unlimited-and-reset','review-identity-self','voucher-short-code','review-distribution-self-redeem','nfc-tag-registry','claim-guard','booth-bulk-and-tag-register','notices','operator-identity-and-scoped-reset','self-identity-and-own-club-stamps','student-number-display','student-number-only','operator-self-actions','sun-nfc']) await sql(`operations-server/${f}.sql`);
const catalog=(await db.query('select key from festival_ops.booths where event_id=$1 order by key collate "C"',[event.id])).rows.map(r=>r.key);
const [own,away]=catalog;
for(const booth of [own,away]) await ops(admin,'booth_save',{booth,name:booth,status:'open',floor:1,version:1});
const tag=booth=>one('select festival_nfc_private.issue_tag($1,null) t',[booth]).then(r=>r.t);
const patched=['public.festival_review_identity_self(text,jsonb)','festival_nfc_private.claim(text)','public.festival_sun_claim(jsonb,uuid)'];
const defs=()=>Promise.all(patched.map(f=>one('select pg_get_functiondef($1::regprocedure) d',[f]).then(r=>r.d)));

await test('without a ready roster nobody is asked, and claims work as before',async()=>{
  await sql('operations-server/identity-required.sql');
  const student=await account('11009');
  assert.equal((await self(student,'status')).required,false);
  await ops(student,'claim',{token:await tag(away)});
  await sql('operations-server/identity-required-rollback.sql');
});

await db.query('select festival_ops.import_review_roster($1,$2,$3)',[event.id,{format:1,sourceSha256:'e'.repeat(64),catalogKeys:catalog,
  records:['11001','11002'].map(studentNumber=>({studentNumber,realName:'Synthetic One',clubs:['Synthetic Club'],boothKeys:[own],status:'ready',issues:[],sourceCells:['Synthetic!A1']}))},admin.uid]);

// The live project stores LF bodies; a Windows checkout loads CRLF ones. Both must patch and roll back exactly.
for(const [ending,number] of [['\r\n','11001'],['\n','11002']]) {
  const label=ending==='\n'?'LF':'CRLF';
  for(const def of await defs()) await db.exec(def.replace(/\r?\n/g,ending));
  const before=await defs();
  await sql('operations-server/identity-required.sql');
  const after=await defs();

  await test(`${label}: each function gains exactly one line with the same line ending`,async()=>{
    assert.ok(after[0].includes("'required',festival_ops.identity_required(me),"));
    for(const i of [1,2]) {
      assert.equal(after[i].split(/\r?\n/).length,before[i].split(/\r?\n/).length+1);
      // The header Postgres writes always uses LF; the new line follows the body around it.
      assert.match(after[i],new RegExp(`end if;${ending}  if festival_ops\\.identity_required\\(me\\) then raise exception [^\\r\\n]*IDENTITY_REQUIRED'; end if;${ending}  [^ \\r\\n]`));
    }
    assert.equal((await one("select has_function_privilege('authenticated','festival_ops.identity_required(jsonb)','execute') v")).v,false);
  });

  await test(`${label}: a 1st/2nd grader on the roster must confirm before any stamp`,async()=>{
    const student=await account(number);
    const status=await self(student,'status');
    assert.equal(status.required,true); assert.equal(status.verified,false);
    await refused(ops(student,'claim',{token:await tag(away)}),'IDENTITY_REQUIRED');
    await refused(sunClaim(student),'IDENTITY_REQUIRED');
    assert.equal((await self(student,'confirm',{eventId:event.id,realName:'Wrong Name'})).result,'IDENTITY_MISMATCH');
    assert.equal((await self(student,'status')).required,true);
    const done=await self(student,'confirm',{eventId:event.id,realName:'Synthetic One'});
    assert.equal(done.result,'CONFIRMED'); assert.equal(done.required,false);
    await ops(student,'claim',{token:await tag(away)});
    await refused(sunClaim(student),'^(?!.*IDENTITY_REQUIRED)');
  });

  await test(`${label}: a 2nd grader missing from the roster is asked too; 3rd graders and operators are not`,async()=>{
    const missing=await account('21999');
    assert.equal((await self(missing,'status')).required,true);
    await refused(ops(missing,'claim',{token:await tag(away)}),'IDENTITY_REQUIRED');
    const senior=await account('30101');
    assert.equal((await self(senior,'status')).required,false);
    await ops(senior,'claim',{token:await tag(away)});
    assert.equal((await self(admin,'status')).required,false);
    await refused(sunClaim(admin),'^(?!.*IDENTITY_REQUIRED)');
  });

  await test(`${label}: the rollback restores all three functions exactly`,async()=>{
    await sql('operations-server/identity-required-rollback.sql');
    assert.deepEqual(await defs(),before);
    assert.equal((await one("select to_regprocedure('festival_ops.identity_required(jsonb)') is null v")).v,true);
  });
}

await db.close();
const failed=results.filter(r=>!r.ok);
console.log(`${results.length-failed.length}/${results.length} passed`);
if(failed.length) process.exit(1);
