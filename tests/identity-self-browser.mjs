// Student self-confirmed club identity, own-club stamp refusal and the operator 소속 관리 screen in a real browser. Every Supabase request is
// answered by local PGlite with synthetic accounts and a synthetic roster.
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
const sql=file=>db.exec(fs.readFileSync(path.join(root,file),'utf8'));
for(const file of ['nfc-server/isolated-test/shim.sql','nfc-server/install.sql','nfc-server/admin-issue.sql','nfc-server/updates/20260930-nonexpiring-tags.sql','nfc-server/reviews.sql','operations-server/install.sql']) await sql(file);
let queue=Promise.resolve();
function rpc(a,query,args=[]) {
  const call=queue.then(async()=>{
    await db.exec('begin');
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:a.id,session_id:a.session,role:'authenticated'})]);
      await db.exec('set local role authenticated');
      const r=await db.query(query,args); await db.exec('commit'); return r.rows[0].value;
    } catch(e) { await db.exec('rollback'); throw e; }
  }); queue=call.catch(()=>{}); return call;
}
async function account(studentNumber,admin=false) {
  const a={id:randomUUID(),session:randomUUID()};
  await db.query(`insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data) values($1,$2,now(),'{"provider":"google"}',$3)`,[a.id,`${a.id}@example.invalid`,{full_name:'격리 학생',festival_name:'격리 학생',festival_student_number:studentNumber}]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[a.session,a.id]);
  a.uid=(await rpc(a,'select public.festival_nfc_profile() value')).id;
  if(admin) await db.query('update public.users set admin=true where id=$1',[a.uid]);
  const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
  a.jwt=`${enc({alg:'HS256',typ:'JWT'})}.${enc({sub:a.id,session_id:a.session,exp:4102444800,role:'authenticated'})}.fixture`;
  return a;
}
const admin=await account('29999',true);
const write=(a,k,p)=>rpc(a,'select public.festival_ops_write($1,$2,$3) value',[k,p,randomUUID()]);
await write(admin,'event_save',{name:'Stored legacy name',state:'open',reviewPoints:10,version:0});
for(const file of ['operations-server/review-identity.draft.sql','operations-server/reward-visits.sql','operations-server/reward-fixed-milestones.sql','operations-server/voucher-unlimited-and-reset.sql','operations-server/review-identity-self.sql','operations-server/voucher-short-code.sql','operations-server/review-distribution-self-redeem.sql','operations-server/nfc-tag-registry.sql','operations-server/claim-guard.sql','operations-server/booth-bulk-and-tag-register.sql','operations-server/notices.sql']) await sql(file);
const eventId=(await db.query('select id from festival_ops.events where current')).rows[0].id;
await sql('operations-server/operator-identity-and-scoped-reset.sql');
await sql('operations-server/self-identity-and-own-club-stamps.sql');
await sql('operations-server/student-number-display.sql');
const [own,away]=['인벨릭스','매커니즘'];
for(const booth of [own,away]) await write(admin,'booth_save',{booth,name:booth,floor:1,status:'open',version:1});
const catalog=(await db.query('select key from festival_ops.booths order by key collate "C"')).rows.map(r=>r.key);
const widths=[320,390,430], number=width=>`1${width}0`;
await db.query('select festival_ops.import_review_roster($1,$2,$3)',[eventId,{format:1,sourceSha256:'c'.repeat(64),catalogKeys:catalog,
  records:widths.map(width=>({studentNumber:number(width),realName:'가상 학생',clubs:['인벨릭스'],boothKeys:[own],status:'ready',issues:[],sourceCells:['Synthetic!A1']}))},admin.uid]);
const output=path.join(root,'artifacts/identity-self'); fs.mkdirSync(output,{recursive:true});
const browser=await chromium.launch({headless:true,channel:process.env.CHROME_PATH?undefined:'msedge',executablePath:process.env.CHROME_PATH});
const reports=[];
async function pageFor(a,width) {
  const context=await browser.newContext({viewport:{width,height:850},isMobile:true,hasTouch:true});
  await context.addInitScript(a=>localStorage.setItem('pangyo-google-session-v1',JSON.stringify({access_token:a.jwt,refresh_token:'fixture',token_type:'bearer',expires_at:4102444800,expires_in:3600,user:{id:a.id}})),a);
  const page=await context.newPage(), errors=[];
  page.on('pageerror',e=>errors.push(e.message)); page.on('dialog',d=>d.accept());
  await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());
    if(url.protocol==='file:') return route.continue();
    if(url.origin!==PROJECT_URL) return route.abort();
    try {
      let value; const p=req.method()==='POST'?req.postDataJSON():{};
      const call=(name,args)=>rpc(a,`select public.${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) value`,args);
      if(url.pathname==='/rest/v1/booths') value=(await db.query('select id,name,rating,position from public.booths')).rows;
      else if(url.pathname==='/rest/v1/rpc/festival_nfc_profile') value=await call('festival_nfc_profile',[]);
      else if(url.pathname==='/rest/v1/rpc/festival_reward_read') value=await call('festival_reward_read',[]);
      else if(url.pathname==='/rest/v1/rpc/festival_review_identity_self') value=await call('festival_review_identity_self',[p.p_action,p.p_payload]);
      else if(url.pathname==='/rest/v1/rpc/festival_identity_overview') value=await call('festival_identity_overview',[]);
      else if(url.pathname==='/rest/v1/rpc/festival_review_identity_admin') value=await call('festival_review_identity_admin',[p.p_action,p.p_payload]);
      else if(url.pathname==='/rest/v1/rpc/festival_ops_read') value=await call('festival_ops_read',[p.p_kind,p.p_query]);
      else if(url.pathname==='/rest/v1/rpc/festival_ops_write') value=await call('festival_ops_write',[p.p_action,p.p_payload,p.p_request_id]);
      else if(url.pathname==='/auth/v1/logout') return route.fulfill({status:204});
      else return route.fulfill({status:404,json:{code:'PGRST202',message:'Missing optional function'}});
      return route.fulfill({json:value});
    } catch(e) { return route.fulfill({status:400,json:{code:e.code || 'TEST_ERROR',message:e.message}}); }
  });
  await page.goto(pathToFileURL(path.join(root,'index.html')).href);
  await page.waitForFunction(()=>festivalOpsUI.snapshot()?.ready && festivalOpsUI.identity());
  return {page,context,errors};
}
const routeTo=(page,route)=>page.evaluate(r=>navigateTo(r),route);
async function screenshot(page,width,name) {
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`overflow ${width} ${name}`);
  await page.screenshot({path:path.join(output,`${width}-${name}.png`),fullPage:true});
}
try {
  for(const width of widths) {
    const student=await account(number(width));
    await write(admin,'visit_approve',{booth:away,userId:student.uid,reason:'Synthetic visit check'});
    const s=await pageFor(student,width);
    await routeTo(s.page,'home');
    const prompt=s.page.locator('.festival-identity-prompt'); await prompt.waitFor();
    assert.match(await prompt.innerText(),/본인 소속 확인을 먼저 해 주세요/);
    await screenshot(s.page,width,'home-prompt');

    // An unconfirmed account sees why it cannot rate, with a way to confirm.
    await s.page.evaluate(key=>goDetail(state.db.booths.find(b=>boothKeyFor(b)===key).id),away);
    await s.page.locator('.review-identity-link').waitFor({state:'visible'});
    assert.equal(await s.page.locator('.review-guidance').isVisible(),true);
    await s.page.locator('.review-identity-link').click();

    // The student confirms with the roster name; a wrong name is explained.
    const confirmForm=s.page.locator('[data-identity-confirm]'); await confirmForm.waitFor();
    assert.equal(await confirmForm.locator('input[readonly]').inputValue(),number(width));
    await confirmForm.locator('[name=realName]').fill('다른 이름');
    await confirmForm.locator('button[type=submit]').click();
    await s.page.getByText('동아리 명단의 이름과 달라요.',{exact:false}).waitFor();
    await screenshot(s.page,width,'identity-form');
    await s.page.locator('[data-identity-confirm] [name=realName]').fill('가상 학생');
    await s.page.locator('[data-identity-confirm] button[type=submit]').click();
    const card=s.page.locator('.festival-identity-card'); await card.getByText('소속 확인 완료').waitFor();
    assert.match(await card.innerText(),/가상 학생/); assert.match(await card.innerText(),/인벨릭스/);
    assert.match(await s.page.locator('.festival-identity').innerText(),/스탬프·별점 제외 부스/);
    await screenshot(s.page,width,'identity-confirmed');

    await routeTo(s.page,'home');
    await s.page.locator('.web-welcome').waitFor();
    assert.equal(await s.page.locator('.festival-identity-prompt').count(),0);
    await routeTo(s.page,'profile');
    assert.match(await s.page.locator('.profile-identity-row').innerText(),/확인됨 · 인벨릭스/);
    await s.page.evaluate(key=>goDetail(state.db.booths.find(b=>boothKeyFor(b)===key).id),away);
    await s.page.locator('.review-identity').getByText('가상 학생 이름으로 공개돼요.').waitFor();
    assert.equal(await s.page.locator('.review-identity-link').isHidden(),true);

    // A second account with the same sign-up number is refused and reported to operators.
    const impostor=await account(number(width));
    assert.equal((await rpc(impostor,'select public.festival_review_identity_self($1,$2) value',['confirm',{eventId,realName:'가상 학생'}])).result,'ROSTER_ALREADY_LINKED');

    const a=await pageFor(admin,width);
    await routeTo(a.page,'admin'); await a.page.locator('.festival-op-status').waitFor();
    // Own-club stamps are refused for manual approvals too, with a clear message.
    const refused=await a.page.evaluate(async args=>(await festivalAccount.operations.write('visit_approve',args)).message,{booth:own,userId:student.uid,reason:'Synthetic own-club check'});
    assert.equal(refused,'본인 동아리 부스는 스탬프를 적립할 수 없어요.');
    await openOperatorTool(a.page,'identity_overview');
    const overview=a.page.locator('.ops-identity-overview'); await overview.waitFor();
    assert.match(await overview.innerText(),/본인 확인\s*1/);
    const conflict=a.page.locator(`[data-identity-open="${impostor.uid}"]`).first(); await conflict.waitFor();
    // Accounts are identified by student number; the internal account number is never shown.
    assert.match(await conflict.innerText(),new RegExp(`\(${number(width)}\)`));
    assert.doesNotMatch(await a.page.locator('.ops-body').innerText(),/#d|참여자 번호/);
    const find=a.page.locator('[data-identity-find]');
    await find.locator('[name=search]').fill(number(width)); await find.locator('button').click();
    await a.page.locator('[data-identity-find-status]').getByText('같은 학번이나 이름의 계정이 여러 개예요.',{exact:false}).waitFor();
    assert.equal(await a.page.locator('[data-identity-found]').count(),2);
    const row=a.page.locator(`[data-identity-user="${student.uid}"]`); await row.waitFor();
    assert.match(await row.innerText(),/본인 확인/);
    await screenshot(a.page,width,'operator-identity-overview');

    // Operators can revoke the link; the student is then locked out of self-confirmation.
    await row.click();
    const dialog=a.page.locator('#reviewRosterForm'); await dialog.waitFor();
    assert.match(await dialog.innerText(),/본인 확인/);
    await dialog.locator('[name=reason]').fill('Synthetic operator correction');
    await dialog.locator('[data-roster-revoke]').click();
    await dialog.getByText('확인을 취소했어요.').waitFor();
    await a.page.keyboard.press('Escape');
    await a.page.locator(`[data-identity-user="${student.uid}"]`).getByText('운영자 취소').waitFor();

    await s.page.evaluate(()=>festivalOpsUI.refresh());
    await routeTo(s.page,'home');
    await s.page.locator('.festival-identity-prompt').getByText('운영자 확인이 필요해요',{exact:false}).waitFor();
    assert.deepEqual([...s.errors,...a.errors],[]);
    reports.push({width,passed:true,flows:['home prompt','review link','name mismatch','self confirmation','prompt hidden','profile row','author name','duplicate attempt','own-club manual refusal','operator overview','operator revoke','locked prompt']});
    await s.context.close(); await a.context.close();
  }
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(reports,null,2));
  console.log(JSON.stringify(reports));
} finally { await browser.close(); await db.close(); }
