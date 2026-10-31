// Real browser and operations SQL; all remote requests terminate in local PGlite.
// Covers 관리 마법사 → 참여자 → 학생 계정 삭제: choosing the student, the typed confirmation, the result and
// the student's session ending.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require('playwright');
const {openOperatorTool}=require('./operator-navigation.cjs');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=path.join(process.env.PGLITE_DIR,'node_modules/@electric-sql/pglite/dist');
const {PGlite}=await import(pathToFileURL(path.join(dir,'index.js')));
const {pgcrypto}=await import(pathToFileURL(path.join(dir,'contrib/pgcrypto.js')));
const {PROJECT_URL}=require('../supabase-catalog.js');
const db=new PGlite({extensions:{pgcrypto}});
for(const file of ['nfc-server/isolated-test/shim.sql','nfc-server/install.sql','nfc-server/admin-issue.sql','nfc-server/reviews.sql','operations-server/install.sql']) await db.exec(fs.readFileSync(path.join(root,file),'utf8'));
let queue=Promise.resolve();
function rpc(a,sql,args=[]) {
  const call=queue.then(async()=>{
    await db.exec('begin');
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:a.id,session_id:a.session,role:'authenticated'})]);
      await db.exec('set local role authenticated');
      const r=await db.query(sql,args); await db.exec('commit'); return r.rows[0].value;
    } catch(e) { await db.exec('rollback'); throw e; }
  }); queue=call.catch(()=>{}); return call;
}
async function account(admin,studentNumber,name='격리 학생') {
  const a={id:randomUUID(),session:randomUUID()};
  await db.query(`insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data) values($1,$2,now(),'{"provider":"google"}',$3)`,[a.id,`${a.id}@example.invalid`,{full_name:name,festival_name:name,festival_student_number:studentNumber}]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[a.session,a.id]);
  a.uid=(await rpc(a,'select public.festival_nfc_profile() value')).id;
  if(admin) await db.query('update public.users set admin=true where id=$1',[a.uid]);
  const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
  a.jwt=`${enc({alg:'HS256',typ:'JWT'})}.${enc({sub:a.id,session_id:a.session,exp:4102444800,role:'authenticated'})}.fixture`;
  return a;
}
const admin=await account(true,'29999','격리 운영자');
const write=(a,k,p)=>rpc(a,'select public.festival_ops_write($1,$2,$3) value',[k,p,randomUUID()]);
await write(admin,'event_save',{name:'계정 삭제 격리 검증',state:'open',reviewPoints:10,version:0});
for(const file of ['review-identity.draft','reward-visits','reward-fixed-milestones','voucher-unlimited-and-reset','review-identity-self','voucher-short-code','review-distribution-self-redeem','nfc-tag-registry','claim-guard','booth-bulk-and-tag-register','notices','operator-identity-and-scoped-reset','self-identity-and-own-club-stamps','student-number-display','student-number-only','operator-self-actions','sun-nfc','booth-managers','notice-images','booth-profile','manual-voucher-issue','voucher-managers','voucher-approval-and-manual-issue','account-delete'])
  await db.exec(fs.readFileSync(path.join(root,`operations-server/${file}.sql`),'utf8'));
for(const {key} of (await db.query('select key from festival_ops.booths')).rows) await write(admin,'booth_save',{booth:key,name:key,status:'open',floor:1,version:1});
const eventId=(await db.query('select id from festival_ops.events where current')).rows[0].id;
const catalog=(await db.query('select key from festival_ops.booths order by key collate "C"')).rows.map(r=>r.key);
const CLUB='인벨릭스';
await db.query('select festival_ops.import_review_roster($1,$2,$3)',[eventId,{format:1,sourceSha256:'a'.repeat(64),catalogKeys:catalog,
  records:[{studentNumber:'11001',realName:'가상담당',clubs:['인벨릭스'],boothKeys:[CLUB],status:'ready',issues:[],sourceCells:['Synthetic!A1']}]},admin.uid]);
const lead=await account(false,'11001','가상담당'), visitor=await account(false,'21001','가상방문');
await rpc(lead,'select public.festival_review_identity_self($1,$2) value',['confirm',{eventId,realName:'가상담당'}]);

const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==','base64');
const output=path.join(root,'artifacts/account-delete'); fs.mkdirSync(output,{recursive:true});
const browser=await chromium.launch({headless:true,channel:process.env.CHROME_PATH?undefined:'msedge',executablePath:process.env.CHROME_PATH});
const pages=[], uploads=[], boothUploads=[], removed=[], calls=[], dialogs=[];
async function pageFor(a,width=390) {
  const context=await browser.newContext({viewport:{width,height:850},isMobile:true,hasTouch:true});
  await context.addInitScript(a=>localStorage.setItem('pangyo-google-session-v1',JSON.stringify({access_token:a.jwt,refresh_token:'fixture',token_type:'bearer',expires_at:4102444800,expires_in:3600,user:{id:a.id}})),a);
  const page=await context.newPage(), errors=[];
  page.on('pageerror',e=>errors.push(e.message)); page.on('dialog',d=>{dialogs.push(d.message());d.accept();});
  await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());
    if(url.protocol==='file:') return route.continue();
    if(url.origin!==PROJECT_URL) return route.abort();
    try {
      const bucket=/^\/storage\/v1\/object\/(?:public\/)?(festival-notices|festival-booths)(?:\/|$)/.exec(url.pathname)?.[1];
      if(url.pathname.startsWith(`/storage/v1/object/public/${bucket}/`)) return route.fulfill({status:200,contentType:'image/png',body:PNG});
      if(bucket && url.pathname.startsWith(`/storage/v1/object/${bucket}/`) && req.method()==='POST') {
        (bucket==='festival-booths'?boothUploads:uploads).push(url.pathname.slice(`/storage/v1/object/${bucket}/`.length));
        return route.fulfill({json:{Key:url.pathname.slice('/storage/v1/object/'.length)}});
      }
      if(bucket && url.pathname===`/storage/v1/object/${bucket}` && req.method()==='DELETE') { removed.push(...(req.postDataJSON().prefixes||[])); return route.fulfill({json:[]}); }
      let value; const p=req.method()==='POST'?req.postDataJSON():{};
      if(url.pathname.startsWith('/rest/v1/rpc/')) calls.push(url.pathname.slice('/rest/v1/rpc/'.length));
      const call=(name,sql,args)=>rpc(a,`select public.${name}(${sql}) value`,args);
      if(url.pathname==='/rest/v1/booths') value=(await db.query('select id,name,rating,position from public.booths')).rows;
      else if(url.pathname==='/rest/v1/rpc/festival_nfc_profile') value=await call('festival_nfc_profile','',[]);
      else if(url.pathname==='/rest/v1/rpc/festival_ops_read') value=await call('festival_ops_read','$1,$2',[p.p_kind,p.p_query]);
      else if(url.pathname==='/rest/v1/rpc/festival_ops_write') value=await call('festival_ops_write','$1,$2,$3',[p.p_action,p.p_payload,p.p_request_id]);
      else if(url.pathname==='/rest/v1/rpc/festival_notices') value=await call('festival_notices','',[]);
      else if(url.pathname==='/rest/v1/rpc/festival_notice_admin') value=await call('festival_notice_admin','$1,$2',[p.p_action,p.p_payload]);
      else if(url.pathname==='/rest/v1/rpc/festival_booth_manager') value=await call('festival_booth_manager','$1,$2,$3',[p.p_action,p.p_payload,p.p_request_id ?? null]);
      else if(url.pathname==='/rest/v1/rpc/festival_booth_manager_admin') value=await call('festival_booth_manager_admin','$1,$2',[p.p_action,p.p_payload]);
      else if(url.pathname==='/rest/v1/rpc/festival_student_lookup') value=await call('festival_student_lookup','$1',[p.p_payload]);
      else if(url.pathname==='/rest/v1/rpc/festival_account_delete') value=await call('festival_account_delete','$1,$2',[p.p_payload,p.p_request_id]);
      else if(url.pathname==='/auth/v1/logout') return route.fulfill({status:204});
      else return route.fulfill({status:404,json:{code:'PGRST202',message:'Missing optional function'}});
      return route.fulfill({json:value});
    } catch(e) { return route.fulfill({status:400,json:{code:e.code || 'TEST_ERROR',message:e.message}}); }
  });
  await page.goto(pathToFileURL(path.join(root,'index.html')).href);
  await page.waitForFunction(()=>festivalOpsUI.snapshot()?.ready);
  pages.push({page,errors});
  return {page,context,errors};
}
const routeTo=(page,route)=>page.evaluate(r=>{state.route=r;render();},route);
async function check(page,name,width=390) {
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`overflow ${name}`);
  await page.screenshot({path:path.join(output,`${width}-${name}.png`),fullPage:true});
}

const flows=[];
try {
  // The student has a stamp and is signed in on their own phone.
  await rpc(admin,'select public.festival_ops_write_student($1,$2,$3) value',['visit_approve',{studentNumber:'21001',booth:catalog[0],reason:'격리 방문'},randomUUID()]);
  const s=await pageFor(visitor);
  await routeTo(s.page,'profile');

  // Operator: 관리 마법사 → 참여자 → 학생 계정 삭제.
  const a=await pageFor(admin);
  await routeTo(a.page,'admin');
  await openOperatorTool(a.page,'participants');
  const f=a.page.locator('[data-ops-form=account_delete]');
  await f.waitFor();
  assert.match(await a.page.locator('.ops-account-delete h2').innerText(),/학생 계정 삭제/);
  // Without a chosen student nothing is sent.
  await f.locator('[name=reason]').fill('중복 가입 계정');
  await f.locator('[name=confirm]').fill('삭제');
  await f.locator('button[type=submit]').click();
  await f.getByText('처리할 학생을 목록에서 골라 주세요.',{exact:true}).waitFor();
  await f.locator('[data-recipient-pick="21001"]').click();
  await f.locator('[data-recipient-result]').getByText('21001').first().waitFor();
  // A wrong confirmation word is stopped by the form itself.
  await f.locator('[name=confirm]').fill('삭재');
  await f.locator('button[type=submit]').click();
  assert.equal(await f.locator('[name=confirm]').evaluate(i=>i.validity.patternMismatch),true);
  assert.equal(calls.filter(c=>c==='festival_account_delete').length,0);
  await f.locator('[name=confirm]').fill('삭제');
  await check(a.page,'delete-form');
  await f.locator('button[type=submit]').click();
  await f.getByText('학생의 계정을 삭제했어요',{exact:false}).waitFor();
  assert.match(await f.locator('.ops-form-status').innerText(),/방문 1건, 바우처 0장, 리뷰 0건/);
  assert.equal(calls.filter(c=>c==='festival_account_delete').length,1);
  assert.equal(dialogs.some(t=>/축제 계정을 삭제할까요\?/.test(t)),true);
  await check(a.page,'deleted');
  const left=(await db.query('select count(*)::int n from festival_ops.visits where user_id=$1',[visitor.uid])).rows[0].n;
  assert.equal(left,0);
  const meta=(await db.query('select raw_user_meta_data m from auth.users where id=$1',[visitor.id])).rows[0].m;
  assert.equal(meta.festival_student_number,undefined);
  flows.push('operator deletes from 참여자','wrong confirmation blocked');

  // Two accounts share a 학번: the operator picks one and the confirmation names its Google email.
  const twinA=await account(false,'21007','가상중복'), twinB=await account(false,'21007','가상중복');
  const mailB=(await db.query('select email from auth.users where id=$1',[twinB.id])).rows[0].email;
  await f.locator('[data-recipient-change]').click().catch(()=>{});
  await f.locator('[name=recipientQuery]').fill('21007');
  await f.locator('[data-recipient-find]').click();
  await f.locator('[data-recipient-pick="21007"]').first().click();
  await f.locator('[data-recipient-choice]').nth(1).waitFor();
  const pickB=f.locator('[data-recipient-choice]').filter({hasText:mailB});
  await pickB.click();
  await f.locator('[name=reason]').fill('중복 가입 계정');
  await f.locator('[name=confirm]').fill('삭제');
  await f.locator('button[type=submit]').click();
  await f.getByText('학생의 계정을 삭제했어요',{exact:false}).waitFor();
  assert.ok(dialogs.at(-1).includes(mailB),dialogs.at(-1));
  const kept=(await db.query('select raw_user_meta_data m from auth.users where id=$1',[twinA.id])).rows[0].m;
  assert.equal(kept.festival_student_number,'21007');
  flows.push('shared 학번: email in confirmation, only the chosen account deleted');

  // The student's open app loses its session at the next server call.
  await s.page.evaluate(()=>festivalOpsUI.refresh(false)).catch(()=>{});
  await s.page.reload();
  await s.page.waitForFunction(()=>state.route==='login' || state.authStep!=='google' || !state.user,null,{timeout:15000});
  assert.equal(await s.page.evaluate(()=>state.user),null);
  flows.push('student signed out');

  for(const {errors} of pages) assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,flows}));
} finally { await browser.close(); }
