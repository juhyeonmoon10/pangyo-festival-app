// Browser -> real operations SQL in local PGlite. Every remote request is intercepted.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_PATH || 'playwright');
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
    try{await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:a.id,session_id:a.session,role:'authenticated'})]);await db.exec('set local role authenticated');const r=await db.query(sql,args);await db.exec('commit');return r.rows[0].value;}
    catch(e){await db.exec('rollback');throw e;}
  });queue=call.catch(()=>{});return call;
}
async function account(admin=false){
  const a={id:randomUUID(),session:randomUUID()};
  await db.query(`insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data) values($1,$2,now(),'{"provider":"google"}','{"festival_name":"격리 학생","festival_student_number":"21001"}')`,[a.id,`${a.id}@example.invalid`]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[a.session,a.id]);
  a.uid=(await rpc(a,'select public.festival_nfc_profile() value')).id;
  if(admin)await db.query('update public.users set admin=true where id=$1',[a.uid]);
  const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
  a.jwt=`${enc({alg:'HS256',typ:'JWT'})}.${enc({sub:a.id,session_id:a.session,exp:4102444800,role:'authenticated'})}.fixture`;
  return a;
}
const admin=await account(true);
const write=(a,k,p)=>rpc(a,'select public.festival_ops_write($1,$2,$3) value',[k,p,randomUUID()]);
await write(admin,'event_save',{name:'운영 연동 격리 검증',state:'open',reviewPoints:10,version:0});
await write(admin,'booth_save',{booth:'글빛누리',version:1,name:'글빛누리',floor:2,location:'2층 1-1',status:'open',description:'체험 프로그램'});
const rule=(await write(admin,'rule_save',{title:'간식 교환권',target:1,stock:20,enabled:true,expiresAt:'2099-01-01T00:00:00Z'})).id;
const output=path.join(root,'artifacts/operations');fs.mkdirSync(output,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});
const reports=[];
async function pageFor(a,width){
  const context=await browser.newContext({viewport:{width,height:850},isMobile:true,hasTouch:true});
  await context.addInitScript(a=>localStorage.setItem('pangyo-google-session-v1',JSON.stringify({access_token:a.jwt,refresh_token:'fixture',token_type:'bearer',expires_at:4102444800,expires_in:3600,user:{id:a.id}})),a);
  const page=await context.newPage(), errors=[]; page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.route('**/*',async route=>{
    const req=route.request(), url=new URL(req.url());
    if(url.protocol==='file:')return route.continue();
    if(url.origin!==PROJECT_URL)return route.abort();
    try {
      let value;
      if(url.pathname==='/rest/v1/booths')value=(await db.query('select id,name,rating,position from public.booths')).rows;
      else if(url.pathname==='/rest/v1/rpc/festival_nfc_profile')value=await rpc(a,'select public.festival_nfc_profile() value');
      else if(url.pathname==='/rest/v1/rpc/festival_ops_read'){const p=req.postDataJSON();value=await rpc(a,'select public.festival_ops_read($1,$2) value',[p.p_kind,p.p_query]);}
      else if(url.pathname==='/rest/v1/rpc/festival_ops_write'){const p=req.postDataJSON();value=await rpc(a,'select public.festival_ops_write($1,$2,$3) value',[p.p_action,p.p_payload,p.p_request_id]);}
      else if(url.pathname==='/auth/v1/logout')return route.fulfill({status:204});
      else throw Error('Unexpected API '+url.pathname);
      return route.fulfill({json:value});
    } catch(e){return route.fulfill({status:400,json:{code:e.code || 'TEST_ERROR',message:e.message}});}
  });
  await page.goto(pathToFileURL(path.join(root,'index.html')).href);
  await page.waitForFunction(()=>festivalOpsUI.snapshot()?.ready);
  return {page,context,errors};
}
async function routeTo(page,route){await page.evaluate(r=>{state.route=r;render();},route);}
async function screenshot(page,width,name){
  await page.waitForTimeout(100);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`overflow: ${width} ${name}`);
  await page.screenshot({path:path.join(output,`${width}-${name}.png`),fullPage:true});
}
try {
  for(const width of [320,390,430]){
    const student=await account();
    const a=await pageFor(admin,width),s=await pageFor(student,width);
    await routeTo(a.page,'admin');await a.page.waitForSelector('#opsTab');
    await screenshot(a.page,width,'dashboard');
    await a.page.selectOption('#opsTab','visits');
    const f=a.page.locator('[data-ops-form="visit_approve"]');
    await f.locator('[name=userId]').fill(String(student.uid));await f.locator('[name=booth]').selectOption('글빛누리');
    await f.locator('[name=reason]').fill('현장 확인 완료');await f.locator('button[type=submit]').click();
    await a.page.waitForFunction(()=>!document.querySelector('[data-ops-form=visit_approve] button').disabled);
    await screenshot(a.page,width,'visits');
    await s.page.evaluate(async()=>{await festivalOpsUI.refresh(false);state.selectedBoothId=boothForKey('글빛누리').id;state.route='detail';render();});
    await s.page.locator('[data-rating="5"]').click();
    await s.page.locator('#submitReview').click();
    await s.page.waitForFunction(()=>festivalOpsUI.snapshot().reviews.length===1);
    await s.page.locator('#reviewContent').fill('재미있었어요');await s.page.locator('#submitReview').click();
    await s.page.waitForFunction(()=>festivalOpsUI.snapshot().points===10);
    await routeTo(s.page,'vouchers');await s.page.waitForSelector('[data-ops-qr]');
    await s.page.locator('[data-ops-qr]').click();await s.page.waitForSelector('.ops-qr svg');
    await screenshot(s.page,width,'voucher-qr');
    const token=(await rpc(student,'select public.festival_ops_write($1,$2,$3) value',['voucher_qr',{id:(await s.page.evaluate(()=>festivalOpsUI.snapshot().vouchers[0].id))},randomUUID()])).token;
    await a.page.selectOption('#opsTab','vouchers');await a.page.locator('#opsRedeem [name=token]').fill(token);
    await a.page.locator('#opsRedeem button[type=submit]').click();
    await a.page.waitForFunction(()=>document.querySelector('#opsRedeem [name=token]')?.value==='');
    await screenshot(a.page,width,'redemptions');
    for(const tab of ['catalog','participants','ledger','rules','audit']){
      await a.page.selectOption('#opsTab',tab);await a.page.waitForFunction(t=>document.querySelector('#opsTab')?.value===t,tab);
      await screenshot(a.page,width,tab);
    }
    await a.page.selectOption('#opsTab','participants');
    await a.page.locator('#opsSearch input').fill('격리 학생');
    assert.equal(await a.page.locator('#opsSearch input').inputValue(),'격리 학생');
    await routeTo(s.page,'admin');assert.equal(await s.page.locator('#opsTab').count(),0);
    assert.deepEqual(a.errors,[]);assert.deepEqual(s.errors,[]);
    reports.push({width,passed:true,flows:['manual approval','rating','late written review','10 points','voucher QR','redemption','admin tabs','Korean text','student admin denial']});
    await a.context.close();await s.context.close();
  }
} catch(e){reports.push({passed:false,error:e.stack});console.error(e);process.exitCode=1;}
finally{await browser.close();await db.close();fs.writeFileSync(path.join(output,'browser.json'),JSON.stringify({environment:'Chromium to local PGlite; all Supabase requests intercepted; no production data',reports},null,2));}
