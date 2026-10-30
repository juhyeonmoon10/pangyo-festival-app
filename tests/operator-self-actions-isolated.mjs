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
const self=(a,action='status',realName='Synthetic One')=>rpc(a,'select public.festival_review_identity_self($1,$2) value',[action,{eventId:event.id,realName}]);
const identify=(action,payload)=>rpc(admin,'select public.festival_review_identity_admin($1,$2) value',[action,{eventId:event.id,...payload}]);
const overview=(a=admin,role)=>rpc(a,'select public.festival_identity_overview() value',[],role);
const visits=async(a,booth)=>Number((await one('select count(*) n from festival_ops.visits where user_id=$1 and booth_key=$2',[a.uid,booth])).n);
const mirror=async a=>(await one('select to_jsonb(completed_booths) b from public.users where id=$1',[a.uid])).b;
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
const event=(await ops(admin,'event_save',{name:'Synthetic own-club event',state:'open',reviewPoints:10,version:0})).event;
for(const f of ['operations-server/review-identity.draft.sql','operations-server/reward-visits.sql','operations-server/reward-fixed-milestones.sql','operations-server/voucher-unlimited-and-reset.sql','operations-server/review-identity-self.sql','operations-server/voucher-short-code.sql','operations-server/review-distribution-self-redeem.sql','operations-server/nfc-tag-registry.sql','operations-server/claim-guard.sql','operations-server/booth-bulk-and-tag-register.sql','operations-server/notices.sql','operations-server/operator-identity-and-scoped-reset.sql']) await sql(f);
const catalog=(await db.query('select key from festival_ops.booths where event_id=$1 order by key collate "C"',[event.id])).rows.map(r=>r.key);
const [own,away]=catalog;
for(const booth of [own,away]) await ops(admin,'booth_save',{booth,name:booth,status:'open',floor:1,version:1});
const record=(studentNumber,realName,boothKeys)=>({studentNumber,realName,clubs:['Synthetic Club'],boothKeys,status:'ready',issues:[],sourceCells:['Synthetic!A1']});
await db.query('select festival_ops.import_review_roster($1,$2,$3)',[event.id,{format:1,sourceSha256:'d'.repeat(64),catalogKeys:catalog,
  records:[record('11001','Synthetic One',[own]),record('11002','Synthetic Two',[away]),record('29999','Synthetic Admin',[])]},admin.uid]);
const tag=async booth=>(await one('select festival_nfc_private.issue_tag($1,null) t',[booth])).t;
const ownTag=await tag(own),awayTag=await tag(away);
const student=await account('11001'),impostor=await account('11001'),member=await account('11002'),outsider=await account('11003');
// Stamps earned at the student's own club before this update: one NFC, one manual.
await ops(student,'claim',{token:ownTag});
await ops(student,'claim',{token:awayTag});
await ops(admin,'visit_approve',{booth:own,userId:member.uid,reason:'Synthetic fixture'});
for(const f of ['self-identity-and-own-club-stamps','student-number-display','student-number-only']) await sql(`operations-server/${f}.sql`);
const byStudent=(action,payload)=>rpc(admin,'select public.festival_ops_write_student($1,$2,$3) value',[action,payload,randomUUID()]);
const idStudent=(action,payload)=>rpc(admin,'select public.festival_review_identity_student($1,$2) value',[action,{eventId:event.id,...payload}]);
const me={studentNumber:'29999'};
const ruleId=(await ops(admin,'rule_save',{id:null,version:0,title:'Synthetic voucher',target:1,stock:10,enabled:true,expiresAt:'2099-12-31T00:00:00Z'})).id;
const ruleTwo=(await ops(admin,'rule_save',{id:null,version:0,title:'Synthetic voucher 2',target:1,stock:10,enabled:true,expiresAt:'2099-12-31T00:00:00Z'})).id;

await test('before: an operator cannot act on their own account',async()=>{
  await assert.rejects(byStudent('points_adjust',{...me,delta:5,reason:'Synthetic self points'}),/SELF_ADJUSTMENT/);
  await assert.rejects(byStudent('visit_approve',{...me,booth:away,reason:'Synthetic self visit'}),/SELF_ADJUSTMENT/);
});
await sql('operations-server/operator-self-actions.sql');
await test('an operator gives themselves a stamp and points',async()=>{
  assert.equal((await byStudent('visit_approve',{...me,booth:away,reason:'Synthetic self visit'})).result,'EARNED');
  await byStudent('points_adjust',{...me,delta:5,reason:'Synthetic self points'});
  assert.equal(Number((await one('select sum(delta) n from festival_ops.ledger where user_id=$1',[admin.uid])).n),5);
});
await test('an operator issues, voids and redeems their own vouchers',async()=>{
  const issued=await byStudent('voucher_issue',{...me,ruleId,reason:'Synthetic self voucher'});
  await ops(admin,'voucher_void',{id:issued.id,reason:'Synthetic self void'});
  assert.equal((await one('select state from festival_ops.vouchers where id=$1',[issued.id])).state,'void');
  const second=await byStudent('voucher_issue',{...me,ruleId:ruleTwo,reason:'Synthetic self voucher'});
  const code=(await rpc(admin,'select public.festival_voucher_code($1) value',[second.id])).code;
  const redeemed=await rpc(admin,"select public.festival_voucher_redeem('redeem',$1,$2) value",[{code},randomUUID()]);
  assert.equal(redeemed.result,'REDEEMED'); assert.equal(redeemed.own,true);
});
await test('an operator links their own club membership',async()=>{
  const found=await idStudent('lookup',{account:me,studentNumber:'29999'});
  await idStudent('save',{account:me,studentNumber:'29999',version:found.version,rosterVersion:found.roster.version,confirmed:true,reason:'Synthetic self link'});
  assert.equal((await self(admin)).verified,true);
});
await test('the other rules stay: own-club stamps, permissions and validation',async()=>{
  await assert.rejects(byStudent('visit_approve',{studentNumber:'11001',booth:own,reason:'Synthetic own club'}),/OWN_CLUB_STAMP|STUDENT_AMBIGUOUS/);
  await assert.rejects(rpc(student,'select public.festival_ops_write_student($1,$2,$3) value',['points_adjust',{...me,delta:1,reason:'Synthetic'},randomUUID()]),/ADMIN_REQUIRED/);
  await assert.rejects(byStudent('points_adjust',{...me,delta:1,reason:'x'}),/INVALID_INPUT/);
  await assert.rejects(byStudent('points_adjust',{...me,delta:-100,reason:'Synthetic overdraw'}),/POINTS_INSUFFICIENT/);
});
await test('rollback restores the self-account refusals',async()=>{
  await sql('operations-server/operator-self-actions-rollback.sql');
  await assert.rejects(byStudent('points_adjust',{...me,delta:1,reason:'Synthetic self points'}),/SELF_ADJUSTMENT/);
  await assert.rejects(byStudent('voucher_issue',{...me,ruleId,reason:'Synthetic self voucher'}),/INVALID_INPUT/);
  const row=await idStudent('get',{account:me});
  await assert.rejects(idStudent('revoke',{account:me,version:row.version,reason:'Synthetic self revoke'}),/SELF_ADJUSTMENT/);
});
const out=path.join(root,'artifacts/operator-self-actions'); fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,'isolated.json'),JSON.stringify(results,null,2));
await db.close();
console.log(`${results.filter(r=>r.ok).length}/${results.length} passed`);
if(results.some(r=>!r.ok)) process.exitCode=1;
