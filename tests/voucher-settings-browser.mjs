// Voucher settings (unlimited stock/deadline, issued/remaining) and participation reset in a real
// browser. Every Supabase request is answered by local PGlite; nothing leaves the machine.
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
for(const file of ['nfc-server/isolated-test/shim.sql','nfc-server/install.sql','nfc-server/admin-issue.sql','nfc-server/reviews.sql','operations-server/install.sql']) await sql(file);
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
async function account(admin=false) {
  const a={id:randomUUID(),session:randomUUID()};
  await db.query(`insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data) values($1,$2,now(),'{"provider":"google"}','{"full_name":"격리 학생","festival_name":"격리 학생","festival_student_number":"21001"}')`,[a.id,`${a.id}@example.invalid`]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[a.session,a.id]);
  a.uid=(await rpc(a,'select public.festival_nfc_profile() value')).id;
  if(admin) await db.query('update public.users set admin=true where id=$1',[a.uid]);
  const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
  a.jwt=`${enc({alg:'HS256',typ:'JWT'})}.${enc({sub:a.id,session_id:a.session,exp:4102444800,role:'authenticated'})}.fixture`;
  return a;
}
const admin=await account(true);
const write=(a,k,p)=>rpc(a,'select public.festival_ops_write($1,$2,$3) value',[k,p,randomUUID()]);
await write(admin,'event_save',{name:'Stored legacy name',state:'open',reviewPoints:10,version:0});
for(const file of ['operations-server/review-identity.draft.sql','operations-server/reward-visits.sql','operations-server/reward-fixed-milestones.sql','operations-server/voucher-unlimited-and-reset.sql']) await sql(file);
const booths=(await db.query('select key from festival_ops.booths order by key collate "C" limit 6')).rows.map(r=>r.key);
for(const booth of booths) await write(admin,'booth_save',{booth,name:booth,floor:1,status:'open',version:1});
const count=async t=>Number((await db.query(`select count(*) n from ${t}`)).rows[0].n);
const output=path.join(root,'artifacts/voucher-settings'); fs.mkdirSync(output,{recursive:true});
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
      if(url.pathname==='/rest/v1/booths') value=(await db.query('select id,name,rating,position from public.booths')).rows;
      else if(url.pathname==='/rest/v1/rpc/festival_nfc_profile') value=await rpc(a,'select public.festival_nfc_profile() value');
      else if(url.pathname==='/rest/v1/rpc/festival_reward_read') value=await rpc(a,'select public.festival_reward_read() value');
      else if(url.pathname==='/rest/v1/rpc/festival_reward_write') value=await rpc(a,'select public.festival_reward_write($1,$2,$3) value',[p.p_action,p.p_payload,p.p_request_id]);
      else if(url.pathname==='/rest/v1/rpc/festival_ops_reset') value=await rpc(a,'select public.festival_ops_reset($1,$2) value',[p.p_payload,p.p_request_id]);
      else if(url.pathname==='/rest/v1/rpc/festival_ops_read') value=await rpc(a,'select public.festival_ops_read($1,$2) value',[p.p_kind,p.p_query]);
      else if(url.pathname==='/rest/v1/rpc/festival_ops_write') value=await rpc(a,'select public.festival_ops_write($1,$2,$3) value',[p.p_action,p.p_payload,p.p_request_id]);
      else if(url.pathname==='/auth/v1/logout') return route.fulfill({status:204});
      else return route.fulfill({status:404,json:{code:'PGRST202',message:'Missing optional function'}});
      return route.fulfill({json:value});
    } catch(e) { return route.fulfill({status:400,json:{code:e.code || 'TEST_ERROR',message:e.message}}); }
  });
  await page.goto(pathToFileURL(path.join(root,'index.html')).href);
  await page.waitForFunction(()=>festivalOpsUI.snapshot()?.ready);
  return {page,context,errors};
}
const routeTo=(page,route)=>page.evaluate(r=>{state.route=r;render();},route);
async function screenshot(page,width,name) {
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`overflow ${width} ${name}`);
  await page.screenshot({path:path.join(output,`${width}-${name}.png`),fullPage:true});
}
const usage=(page,kind)=>page.locator(`[data-reward-usage=${kind}]`).innerText();
try {
  for(const width of [320,390,430]) {
    const student=await account(),a=await pageFor(admin,width);
    await routeTo(a.page,'admin');
    await a.page.locator('.festival-op-status').waitFor();
    assert.equal(await a.page.getByText('Stored legacy name').count(),0,'festival name must not be shown');

    await openOperatorTool(a.page,'rules');
    const f=a.page.locator('[data-ops-form=reward_config]'); await f.waitFor();
    if(width===320) {
      // First configuration: every limit defaults to "none" and the inputs are inactive.
      for(const key of ['photoStock','foodStock','expiresAt']) {
        assert.equal(await f.locator(`[data-unlimited=${key}]`).isChecked(),true,key);
        assert.equal(await f.locator(`[name=${key}]`).isDisabled(),true,key);
      }
      await f.locator('[name=enabled]').check();
      await f.locator('button[type=submit]').click();
      await a.page.getByText('저장했어요.',{exact:true}).waitFor();
      const rules=(await db.query("select stock,expires_at::text e,enabled from festival_ops.rules where reward_kind is not null")).rows;
      assert.equal(rules.length,2); assert.ok(rules.every(r=>r.stock===null && r.e==='infinity' && r.enabled));
    }
    assert.match(await usage(a.page,'photo'),/발급 0장 · 남은 수량 제한 없음/);
    await screenshot(a.page,width,'voucher-settings-unlimited');

    for(const booth of booths.slice(0,3)) await write(admin,'visit_approve',{booth,userId:student.uid,reason:'Synthetic visit check'});
    const s=await pageFor(student,width);
    await routeTo(s.page,'vouchers');
    const choice=s.page.locator('#rewardChoiceForm'); await choice.waitFor();
    await choice.locator('[value=photo]').check({force:true}); await choice.locator('button[type=submit]').click();
    await s.page.locator('.festival-ticket').first().waitFor();
    assert.match(await s.page.locator('.festival-ticket').first().innerText(),/사용 기한 없음/);
    assert.equal(await s.page.getByText('Invalid Date').count(),0);
    await screenshot(s.page,width,'student-voucher-no-deadline');

    // A finite stock shows remaining count and cannot go below the issued amount.
    await a.page.locator('[data-ops-refresh]').first().click();
    await a.page.locator('[data-reward-usage=photo]').getByText('발급 1장').waitFor();
    await f.locator('[data-unlimited=photoStock]').uncheck();
    assert.equal(await f.locator('[name=photoStock]').isDisabled(),false);
    assert.equal(await f.locator('[name=photoStock]').getAttribute('min'),'1');
    await f.locator('[name=photoStock]').fill('5');
    await f.locator('button[type=submit]').click();
    await a.page.locator('[data-reward-usage=photo]').getByText('4장').waitFor();
    assert.match(await usage(a.page,'photo'),/발급 1장 · 남은 수량 4장/);
    assert.match(await usage(a.page,'food'),/남은 수량 제한 없음/);
    assert.ok(await a.page.locator('.ops-table-wrap').getByText('5장').count()>=1);
    await screenshot(a.page,width,'voucher-settings-finite');

    // Reset: settings has no name field; the confirmation word is required.
    await openOperatorTool(a.page,'settings');
    const settings=a.page.locator('[data-ops-form=event_save]'); await settings.waitFor();
    assert.equal(await settings.locator('input[name=name]').getAttribute('type'),'hidden');
    assert.equal(await a.page.getByText('축제 이름').count(),0);
    const r=a.page.locator('[data-ops-form=participation_reset]');
    await r.locator('[name=confirm]').fill('reset');
    await r.locator('button[type=submit]').click();
    assert.equal(await r.locator('[name=confirm]').evaluate(i=>i.validity.patternMismatch),true);
    assert.ok(await count('festival_ops.visits')>0);
    await screenshot(a.page,width,'reset-form');
    await r.locator('[name=confirm]').fill('초기화');
    await r.locator('button[type=submit]').click();
    await a.page.getByText(/참여 기록을 초기화했어요/).waitFor();
    for(const t of ['festival_ops.visits','festival_ops.vouchers','festival_ops.reviews','festival_ops.ledger']) assert.equal(await count(t),0,t);
    assert.equal((await db.query('select admin from public.users where id=$1',[admin.uid])).rows[0].admin,true);

    // Restore the unlimited configuration for the next width.
    await openOperatorTool(a.page,'rules'); await f.waitFor();
    assert.match(await usage(a.page,'photo'),/발급 0장 · 남은 수량 5장/);
    await f.locator('[data-unlimited=photoStock]').check();
    await f.locator('button[type=submit]').click();
    await a.page.locator('[data-reward-usage=photo]').getByText('제한 없음').waitFor();
    assert.equal((await db.query("select stock from festival_ops.rules where reward_kind='photo'")).rows[0].stock,null);
    assert.deepEqual([...a.errors,...s.errors],[]);
    reports.push({width,passed:true,flows:['unlimited defaults','activation','no-deadline voucher','finite stock remaining','name hidden','reset confirmation','reset keeps admin']});
    await a.context.close(); await s.context.close();
  }
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(reports,null,2));
  console.log(JSON.stringify(reports));
} finally { await browser.close(); }
