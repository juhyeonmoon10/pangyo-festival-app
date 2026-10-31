// Real browser and operations SQL; all remote requests terminate in local PGlite.
// Covers 권한 관리 → 바우처 담당자: grant by kind, approval limited to that kind, revoke.
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
await write(admin,'event_save',{name:'바우처 담당자 격리 검증',state:'open',reviewPoints:10,version:0});
for(const file of ['review-identity.draft','reward-visits','reward-fixed-milestones','voucher-unlimited-and-reset','review-identity-self','voucher-short-code','review-distribution-self-redeem','nfc-tag-registry','claim-guard','booth-bulk-and-tag-register','notices','operator-identity-and-scoped-reset','self-identity-and-own-club-stamps','student-number-display','student-number-only','operator-self-actions','sun-nfc','booth-managers','notice-images','booth-profile','manual-voucher-issue','voucher-managers'])
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
const output=path.join(root,'artifacts/voucher-manager'); fs.mkdirSync(output,{recursive:true});
const browser=await chromium.launch({headless:true,channel:process.env.CHROME_PATH?undefined:'msedge',executablePath:process.env.CHROME_PATH});
const pages=[], uploads=[], boothUploads=[], removed=[];
async function pageFor(a,width=390) {
  const context=await browser.newContext({viewport:{width,height:850},isMobile:true,hasTouch:true});
  await context.addInitScript(a=>localStorage.setItem('pangyo-google-session-v1',JSON.stringify({access_token:a.jwt,refresh_token:'fixture',token_type:'bearer',expires_at:4102444800,expires_in:3600,user:{id:a.id}})),a);
  const page=await context.newPage(), errors=[];
  page.on('pageerror',e=>errors.push(e.message)); page.on('dialog',d=>d.accept());
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
      const call=(name,sql,args)=>rpc(a,`select public.${name}(${sql}) value`,args);
      if(url.pathname==='/rest/v1/booths') value=(await db.query('select id,name,rating,position from public.booths')).rows;
      else if(url.pathname==='/rest/v1/rpc/festival_nfc_profile') value=await call('festival_nfc_profile','',[]);
      else if(url.pathname==='/rest/v1/rpc/festival_ops_read') value=await call('festival_ops_read','$1,$2',[p.p_kind,p.p_query]);
      else if(url.pathname==='/rest/v1/rpc/festival_ops_write') value=await call('festival_ops_write','$1,$2,$3',[p.p_action,p.p_payload,p.p_request_id]);
      else if(url.pathname==='/rest/v1/rpc/festival_notices') value=await call('festival_notices','',[]);
      else if(url.pathname==='/rest/v1/rpc/festival_notice_admin') value=await call('festival_notice_admin','$1,$2',[p.p_action,p.p_payload]);
      else if(url.pathname==='/rest/v1/rpc/festival_booth_manager') value=await call('festival_booth_manager','$1,$2,$3',[p.p_action,p.p_payload,p.p_request_id ?? null]);
      else if(url.pathname==='/rest/v1/rpc/festival_booth_manager_admin') value=await call('festival_booth_manager_admin','$1,$2',[p.p_action,p.p_payload]);
      else if(url.pathname==='/rest/v1/rpc/festival_voucher_redeem') value=await call('festival_voucher_redeem','$1,$2,$3',[p.p_action,p.p_payload,p.p_request_id ?? null]);
      else if(url.pathname==='/rest/v1/rpc/festival_voucher_manager_admin') value=await call('festival_voucher_manager_admin','$1,$2',[p.p_action,p.p_payload]);
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

// Synthetic vouchers: one food and one photo rule; each voucher belongs to the visitor.
async function rule(kind) {
  const found=(await db.query('select id from festival_ops.rules where event_id=$1 and reward_kind=$2',[eventId,kind])).rows[0];
  if(found) return found.id;
  return (await db.query(`insert into festival_ops.rules(event_id,title,target,stock,enabled,expires_at,reward_kind)
    values($1,$2,3,100,true,now()+interval '1 day',$3) returning id`,[eventId,kind==='food'?'푸드트럭 교환권':'포토부스 이용권',kind])).rows[0].id;
}
async function issue(kind,to) {
  return (await db.query(`insert into festival_ops.vouchers(event_id,rule_id,user_id,title,expires_at,code_secret)
    values($1,$2,$3,$4,now()+interval '1 day',extensions.gen_random_bytes(20)) returning id`,[eventId,await rule(kind),to.uid,kind==='food'?'푸드트럭 교환권':'포토부스 이용권'])).rows[0].id;
}
const codeOf=async id=>(await db.query('select festival_ops.voucher_code(code_secret,festival_ops.voucher_step()) c from festival_ops.vouchers where id=$1',[id])).rows[0].c;
const stateOf=async id=>(await db.query('select state from festival_ops.vouchers where id=$1',[id])).rows[0].state;
const food=await issue('food',visitor),photo=await issue('photo',visitor);

const flows=[];
try {
  // Operator: the tool is now 권한 관리 and holds both roles.
  const a=await pageFor(admin);
  await routeTo(a.page,'admin');
  await a.page.locator('[data-ops-tab="tools"]').first().click();
  assert.equal(await a.page.locator('.festival-ops-tools [data-ops-tab="booth_managers"] strong').innerText(),'권한 관리');
  assert.equal(await a.page.getByText('부스 담당자',{exact:true}).count(),0);
  await openOperatorTool(a.page,'booth_managers');
  await a.page.locator('.ops-body h1',{hasText:'권한 관리'}).waitFor();
  await a.page.locator('[data-bm-find]').waitFor();
  const find=a.page.locator('[data-vm-find]');
  await find.waitFor();
  await find.locator('[name=studentNumber]').fill('21001');
  await find.locator('button[type=submit]').click();
  await a.page.locator('[data-vm-root] .ops-alert',{hasText:'소속 확인이 끝나지 않았어요'}).waitFor();
  await find.locator('[name=studentNumber]').fill('11001');
  await find.locator('button[type=submit]').click();
  const grant=a.page.locator('[data-vm-grant]');
  await grant.waitFor();
  assert.deepEqual(await grant.locator('[name=kind] option').allInnerTexts(),['푸드트럭 바우처 담당자','포토부스 바우처 담당자']);
  await grant.locator('[name=kind]').selectOption('food');
  await check(a.page,'grant-form');
  await grant.locator('button[type=submit]').click();
  await a.page.getByText('푸드트럭 바우처 담당자로 지정했어요',{exact:false}).waitFor();
  await a.page.locator('[data-vm-root] .manager-list li',{hasText:'푸드트럭 바우처 담당자'}).waitFor();
  await check(a.page,'granted');
  flows.push('권한 관리 rename','grant food voucher manager');

  // Manager: profile button, then approval of a food voucher only.
  const m=await pageFor(lead);
  await routeTo(m.page,'profile');
  const open=m.page.locator('[data-route=manage]');
  await open.waitFor();
  assert.match(await open.innerText(),/바우처 사용 승인 · 푸드트럭/);
  await open.click();
  const form=m.page.locator('[data-vm-redeem]');
  await form.waitFor();
  assert.equal(await m.page.locator('.manage-screen .top-bar h1').innerText(),'바우처 사용 승인');
  assert.equal(await m.page.locator('[data-manager-save]').count(),0);
  await form.locator('[name=code]').fill('ABC');
  await form.locator('button[type=submit]').click();
  await m.page.locator('[data-spot=vm-redeem]',{hasText:'인증키 8자리를 확인해 주세요.'}).waitFor();
  await form.locator('[name=code]').fill(await codeOf(photo));
  await form.locator('button[type=submit]').click();
  await m.page.locator('[data-spot=vm-redeem]',{hasText:'담당한 종류의 바우처가 아니에요'}).waitFor();
  assert.equal(await stateOf(photo),'available');
  // The typed code stays after a failure.
  assert.equal((await form.locator('[name=code]').inputValue()).length,8);
  await check(m.page,'manager-refused');
  await form.locator('[name=code]').fill(await codeOf(food));
  await form.locator('button[type=submit]').click();
  await m.page.locator('[data-spot=vm-redeem]',{hasText:'사용 완료로 처리했어요'}).waitFor();
  assert.equal(await stateOf(food),'used');
  const audit=(await db.query('select actor_id,action,reason from festival_ops.audit where target=$1',[food])).rows[0];
  assert.deepEqual(audit,{actor_id:lead.uid,action:'voucher_manager_redeem',reason:'food'});
  await check(m.page,'manager-redeemed');
  // The same code again: already used.
  await form.locator('[name=code]').fill(await codeOf(food));
  await form.locator('button[type=submit]').click();
  await m.page.locator('[data-spot=vm-redeem]',{hasText:'이미 사용한 바우처예요.'}).waitFor();
  flows.push('manager refused other kind','manager redeemed own kind');

  // A participant without the role sees no voucher approval.
  const v=await pageFor(visitor);
  await routeTo(v.page,'profile');
  await v.page.waitForTimeout(300);
  assert.equal(await v.page.locator('[data-route=manage]').count(),0);
  await routeTo(v.page,'manage');
  await v.page.getByText('관리할 부스가 없어요',{exact:false}).waitFor();
  assert.equal(await v.page.locator('[data-vm-redeem]').count(),0);
  flows.push('no role, no approval');

  // Operator revokes; the manager's next visit shows nothing to approve.
  await a.page.locator('[data-vm-revoke="0"]').click();
  await a.page.getByText('지정을 해제했어요',{exact:false}).waitFor();
  await a.page.locator('[data-vm-root] .ops-empty',{hasText:'아직 지정한 바우처 담당자가 없어요.'}).waitFor();
  await routeTo(m.page,'profile');
  await routeTo(m.page,'manage');
  await m.page.getByText('관리할 부스가 없어요',{exact:false}).waitFor();
  flows.push('revoke');

  // Operators still redeem every kind in 관리 마법사.
  await openOperatorTool(a.page,'vouchers');
  const redeem=a.page.locator('#opsRedeem');
  await redeem.waitFor();
  await redeem.locator('[name=token]').fill(await codeOf(photo));
  await redeem.locator('button[type=submit]').click();
  await a.page.getByText('바우처를 사용 처리했어요.',{exact:false}).waitFor();
  assert.equal(await stateOf(photo),'used');
  flows.push('operator redeems any kind');

  for(const {errors} of pages) assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,flows}));
} finally { await browser.close(); }
