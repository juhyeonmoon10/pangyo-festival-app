// Real browser and operations SQL; all remote requests terminate in local PGlite.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require('playwright');
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
async function account(admin=false) {
  const a={id:randomUUID(),session:randomUUID()};
  await db.query(`insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data) values($1,$2,now(),'{"provider":"google"}','{"festival_name":"격리 학생","festival_student_number":"21001"}')`,[a.id,`${a.id}@example.invalid`]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[a.session,a.id]);
  a.uid=(await rpc(a,'select public.festival_nfc_profile() value')).id;
  if(admin) await db.query('update public.users set admin=true where id=$1',[a.uid]);
  const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
  a.jwt=`${enc({alg:'HS256',typ:'JWT'})}.${enc({sub:a.id,session_id:a.session,exp:4102444800,role:'authenticated'})}.fixture`;
  return a;
}
const admin=await account(true);
const write=(a,k,p)=>rpc(a,'select public.festival_ops_write($1,$2,$3) value',[k,p,randomUUID()]);
await write(admin,'event_save',{name:'운영자 복구 격리 검증',state:'open',reviewPoints:10,version:0});
const output=path.join(root,'artifacts/operations-hotfix'); fs.mkdirSync(output,{recursive:true});
const browser=await chromium.launch({headless:true,channel:process.env.CHROME_PATH?undefined:'msedge',executablePath:process.env.CHROME_PATH});
const reports=[];
async function pageFor(a,width) {
  const context=await browser.newContext({viewport:{width,height:850},isMobile:true,hasTouch:true});
  await context.addInitScript(a=>localStorage.setItem('pangyo-google-session-v1',JSON.stringify({access_token:a.jwt,refresh_token:'fixture',token_type:'bearer',expires_at:4102444800,expires_in:3600,user:{id:a.id}})),a);
  const page=await context.newPage(), errors=[], calls=[];
  const control={reward:'missing',slowKind:null,release:null,waitStarted:null,qrToken:null,noEvent:false,failKind:null};
  page.on('pageerror',e=>errors.push(e.message)); page.on('dialog',d=>d.accept());
  await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());
    if(url.protocol==='file:') return route.continue();
    if(url.origin!==PROJECT_URL) return route.abort();
    try {
      let value; const p=req.method()==='POST'?req.postDataJSON():{};
      if(url.pathname==='/rest/v1/booths') value=(await db.query('select id,name,rating,position from public.booths')).rows;
      else if(url.pathname==='/rest/v1/rpc/festival_nfc_profile') value=await rpc(a,'select public.festival_nfc_profile() value');
      else if(url.pathname==='/rest/v1/rpc/festival_reward_read') {
        if(control.reward==='unknown') return route.fulfill({status:503,json:{message:'fixture network failure'}});
        if(control.reward==='legacy') return route.fulfill({json:{version:1,ready:true}});
        return route.fulfill({status:404,json:{code:'PGRST202',message:'Missing optional function'}});
      }
      else if(url.pathname==='/rest/v1/rpc/festival_ops_read') {
        if(p.p_kind===control.slowKind) { control.slowKind=null; control.waitStarted?.(); await new Promise(r=>{control.release=r;}); }
        if(p.p_kind===control.failKind) return route.fulfill({status:403,json:{message:'ADMIN_REQUIRED'}});
        value=control.noEvent?{ready:false,items:[]}:await rpc(a,'select public.festival_ops_read($1,$2) value',[p.p_kind,p.p_query]);
      }
      else if(url.pathname==='/rest/v1/rpc/festival_ops_write') {
        calls.push(p); value=await rpc(a,'select public.festival_ops_write($1,$2,$3) value',[p.p_action,p.p_payload,p.p_request_id]);
        if(p.p_action==='voucher_qr') control.qrToken=value.token;
      }
      else if(url.pathname==='/auth/v1/logout') return route.fulfill({status:204});
      else return route.fulfill({status:404,json:{code:'PGRST202',message:'Missing optional function'}});
      return route.fulfill({json:value});
    } catch(e) { return route.fulfill({status:400,json:{code:e.code || 'TEST_ERROR',message:e.message}}); }
  });
  await page.goto(pathToFileURL(path.join(root,'index.html')).href);
  await page.waitForFunction(()=>festivalOpsUI.snapshot()?.ready);
  return {page,context,errors,calls,control};
}
const routeTo=(page,route)=>page.evaluate(r=>{state.route=r;render();},route);
async function tab(page,name,selector) {
  await page.selectOption('#opsTab',name);
  assert.equal(await page.locator('#opsTab').inputValue(),name);
  if(name!=='nfc') await page.waitForSelector('.ops-body[aria-busy="false"]');
  await page.locator(selector).first().waitFor({state:'visible'});
}
async function screenshot(page,width,name) {
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`overflow ${width} ${name}`);
  await page.screenshot({path:path.join(output,`${width}-${name}.png`),fullPage:true});
}
try {
  for(const width of [320,390,430]) {
    const student=await account(),a=await pageFor(admin,width),s=await pageFor(student,width);
    await routeTo(a.page,'admin'); await a.page.locator('[data-ops-form=event_save]').waitFor();
    const menus={dashboard:'[data-ops-form=event_save]',catalog:'[data-ops-form=booth_save]',participants:'#reviewRosterLookup',visits:'[data-ops-form=visit_approve]',ledger:'[data-ops-form=points_adjust]',rules:'[data-ops-form=rule_save]',vouchers:'#opsRedeem',audit:'.ops-paging',nfc:'.nfc-manager-heading'};
    for(const [name,selector] of Object.entries(menus)) await tab(a.page,name,selector);

    a.control.slowKind='participants';
    const started=new Promise(r=>{a.control.waitStarted=r;});
    await a.page.selectOption('#opsTab','participants'); await started;
    await a.page.selectOption('#opsTab','ledger');
    assert.equal(await a.page.locator('.ops-body h1').innerText(),'포인트');
    await a.page.selectOption('#opsTab','rules');
    assert.equal(await a.page.locator('.ops-body h1').innerText(),'바우처 설정');
    a.control.release(); await a.page.locator('[data-ops-form=rule_save]').waitFor();
    assert.equal(await a.page.locator('#reviewRosterLookup').count(),0);

    const f=a.page.locator('[data-ops-form=rule_save]');
    await f.locator('[name=title]').fill(`테스트 이용권 ${width}`);
    await f.locator('[name=target]').fill('3'); await f.locator('[name=stock]').fill('20');
    await f.locator('[name=expiresAt]').fill('2099-01-01T15:00'); await f.locator('[name=enabled]').check();
    await f.locator('button[type=submit]').click();
    await a.page.getByText('저장했어요.',{exact:true}).waitFor();
    await screenshot(a.page,width,'voucher-rules');
    await tab(a.page,'vouchers','[data-ops-form=voucher_issue]');
    const issue=a.page.locator('[data-ops-form=voucher_issue]');
    await issue.locator('[name=ruleId]').selectOption({label:`테스트 이용권 ${width}`});
    await issue.locator('[name=reason]').fill('격리 발급 검증');
    await issue.locator('[name=userId]').fill(String(admin.uid));
    await issue.locator('button[type=submit]').click();
    await a.page.getByText('참여자 번호와 처리 사유를 확인해 주세요. 본인 계정에는 발급할 수 없어요.',{exact:true}).waitFor();
    await issue.locator('[name=userId]').fill(String(student.uid));
    const before=a.calls.filter(x=>x.p_action==='voucher_issue').length;
    await issue.evaluate(f=>{f.requestSubmit();f.requestSubmit();});
    await a.page.getByText('바우처를 발급했어요.',{exact:true}).waitFor();
    assert.equal(a.calls.filter(x=>x.p_action==='voucher_issue').length-before,1);
    const mine=await rpc(student,'select public.festival_ops_read($1,$2) value',['me',{}]);
    assert.equal(mine.vouchers.length,1); assert.equal(mine.vouchers[0].state,'available');
    await screenshot(a.page,width,'issued');

    await s.page.evaluate(async()=>{await festivalOpsUI.refresh(false);state.route='vouchers';render();});
    await s.page.locator('[data-ops-qr]').click(); await s.page.locator('.ops-qr svg').waitFor();
    assert.match(s.control.qrToken,/^fv1\.[0-9a-f]{64}$/);
    await a.page.locator('#opsRedeem [name=token]').fill(s.control.qrToken);
    await a.page.locator('#opsRedeem button[type=submit]').click();
    await a.page.waitForFunction(()=>document.querySelector('#opsRedeem [name=token]')?.value==='');
    assert.equal((await rpc(student,'select public.festival_ops_read($1,$2) value',['me',{}])).vouchers[0].state,'used');
    await screenshot(a.page,width,'redeemed');

    for(const mode of ['unknown','legacy']) {
      a.control.reward=mode; await tab(a.page,'rules','.ops-alert');
      assert.equal(await a.page.locator('[data-ops-form=rule_save],[data-ops-form=reward_config]').count(),0);
    }
    a.control.reward='missing'; a.control.failKind='participants';
    await tab(a.page,'participants','.ops-alert'); assert.equal(await a.page.locator('#reviewRosterLookup').count(),0);
    a.control.failKind=null; await a.page.locator('[data-ops-refresh]').click();
    await a.page.locator('#reviewRosterLookup').waitFor();
    a.control.noEvent=true; await tab(a.page,'vouchers','[data-ops-tab=dashboard]');
    assert.equal(await a.page.locator('[data-ops-form=event_save]').count(),0);
    await a.page.locator('[data-ops-tab=dashboard]').click(); await a.page.locator('[data-ops-form=event_save]').waitFor();
    await routeTo(s.page,'admin'); assert.equal(await s.page.locator('#opsTab').count(),0);
    assert.deepEqual(a.errors,[]); assert.deepEqual(s.errors,[]);
    reports.push({width,passed:true,menus:9,flows:['immediate tab changes','delayed response race','legacy rule save','manual issue','double-submit guard','student QR','redemption','missing/unknown API distinction','permission failure retry','empty event','student denied']});
    await a.context.close(); await s.context.close();
  }
} catch(e) { reports.push({passed:false,error:e.stack}); console.error(e); process.exitCode=1; }
finally {
  await browser.close(); await db.close();
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({environment:'Edge + local PostgreSQL shim; no shared DB access',reports},null,2));
  console.log(JSON.stringify(reports));
}
