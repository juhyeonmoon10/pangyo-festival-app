// Booth review screen in a real browser: summary, distribution, list, filter and navigation.
// Every Supabase request is answered by local PGlite with synthetic accounts and roster.
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
async function account(studentNumber,admin=false) {
  const a={id:randomUUID(),session:randomUUID(),studentNumber};
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
for(const file of ['operations-server/review-identity.draft.sql','operations-server/reward-visits.sql','operations-server/reward-fixed-milestones.sql','operations-server/voucher-unlimited-and-reset.sql','operations-server/review-identity-self.sql','operations-server/voucher-short-code.sql']) await sql(file);
const eventId=(await db.query('select id from festival_ops.events where current')).rows[0].id;
const [booth,quiet]=['매커니즘','인사이트'];
for(const key of [booth,quiet]) await write(admin,'booth_save',{booth:key,name:key,floor:1,status:'open',version:1});
const catalog=(await db.query('select key from festival_ops.booths order by key collate "C"')).rows.map(r=>r.key);
const people=[['11001','가 학생',5,'정말 재미있었어요'],['11002','나 학생',4,''],['11003','다 학생',4,'설명이 친절했어요'],['11004','라 학생',2,'']];
await db.query('select festival_ops.import_review_roster($1,$2,$3)',[eventId,{format:1,sourceSha256:'d'.repeat(64),catalogKeys:catalog,
  records:people.map(([sid,name])=>({studentNumber:sid,realName:name,clubs:['축구반'],boothKeys:[],status:'ready',issues:[],sourceCells:['Synthetic!A1']}))},admin.uid]);
const reviewers=[];
for(const [sid,name,rating,content] of people) {
  const a=await account(sid); reviewers.push(a);
  await rpc(a,'select public.festival_review_identity_self($1,$2) value',['confirm',{eventId,realName:name}]);
  await write(admin,'visit_approve',{booth,userId:a.uid,reason:'Synthetic visit check'});
  await write(a,'review_save',{booth,rating,content});
}
const viewer=reviewers[0];
const output=path.join(root,'artifacts/booth-reviews'); fs.mkdirSync(output,{recursive:true});
const browser=await chromium.launch({headless:true,channel:process.env.CHROME_PATH?undefined:'msedge',executablePath:process.env.CHROME_PATH});
const reports=[];
async function pageFor(a,width) {
  const context=await browser.newContext({viewport:{width,height:850},isMobile:true,hasTouch:true});
  await context.addInitScript(a=>localStorage.setItem('pangyo-google-session-v1',JSON.stringify({access_token:a.jwt,refresh_token:'fixture',token_type:'bearer',expires_at:4102444800,expires_in:3600,user:{id:a.id}})),a);
  const page=await context.newPage(), errors=[], reads=[];
  page.on('pageerror',e=>errors.push(e.message));
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
      else if(url.pathname==='/rest/v1/rpc/festival_ops_read') { if(p.p_kind==='reviews') reads.push(p.p_query?.booth); value=await call('festival_ops_read',[p.p_kind,p.p_query]); }
      else if(url.pathname==='/rest/v1/rpc/festival_ops_write') value=await call('festival_ops_write',[p.p_action,p.p_payload,p.p_request_id]);
      else if(url.pathname==='/auth/v1/logout') return route.fulfill({status:204});
      else return route.fulfill({status:404,json:{code:'PGRST202',message:'Missing optional function'}});
      return route.fulfill({json:value});
    } catch(e) { return route.fulfill({status:400,json:{code:e.code || 'TEST_ERROR',message:e.message}}); }
  });
  await page.goto(pathToFileURL(path.join(root,'index.html')).href);
  await page.waitForFunction(()=>festivalOpsUI.snapshot()?.ready);
  return {page,context,errors,reads};
}
const detail=(page,key)=>page.evaluate(key=>goDetail(state.db.booths.find(b=>boothKeyFor(b)===key).id),key);
async function screenshot(page,width,name) {
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`overflow ${width} ${name}`);
  await page.screenshot({path:path.join(output,`${width}-${name}.png`),fullPage:true});
}
try {
  for(const width of [320,390,430]) {
    const v=await pageFor(viewer,width);
    await detail(v.page,booth);
    const link=v.page.locator('[data-open-booth-reviews]'); await link.waitFor();
    await v.page.locator('[data-review-count-link]').getByText('4개').waitFor();
    await screenshot(v.page,width,'detail-review-button');
    const before=v.reads.length;
    await link.click();
    const summary=v.page.locator('.booth-review-summary'); await summary.waitFor();
    assert.ok(v.reads.length>before,'opening the review screen refreshes from the server');
    assert.match(await v.page.locator('.top-title strong').innerText(),/매커니즘 리뷰/);
    assert.equal(await v.page.locator('.booth-review-score strong').innerText(),'3.8');
    assert.match(await v.page.locator('.booth-review-score small').innerText(),/리뷰 4개/);
    assert.equal(await v.page.locator('.booth-review-stars .star.on').count(),4);
    const bars=await v.page.locator('.booth-review-bar-count').allInnerTexts();
    assert.deepEqual(bars,['1','2','0','1','0']);
    const items=v.page.locator('.booth-review-list .review');
    assert.equal(await items.count(),4);
    const text=await v.page.locator('.booth-review-list').innerText();
    for(const [,name,,content] of people) { assert.match(text,new RegExp(name)); if(content) assert.match(text,new RegExp(content)); }
    assert.equal(await v.page.locator('.booth-review-list .review.mine').count(),1);
    assert.match(await v.page.locator('.booth-review-list .review.mine').innerText(),/\(나\)/);
    await screenshot(v.page,width,'booth-reviews');
    await v.page.locator('[data-booth-review-filter=written]').click();
    assert.equal(await v.page.locator('.booth-review-list .review').count(),2);
    assert.equal(await v.page.locator('[data-booth-review-filter=written]').getAttribute('aria-pressed'),'true');
    await v.page.locator('[data-booth-review-filter=all]').click();
    assert.equal(await v.page.locator('.booth-review-list .review').count(),4);
    assert.equal(await v.page.locator('.bottom-nav .nav-btn.active').innerText(),'부스 지도');
    await v.page.locator('[data-history-back="detail"]').click();
    await v.page.locator('[data-open-booth-reviews]').waitFor();
    assert.equal(await v.page.evaluate(()=>state.route),'detail');
    // A booth without reviews explains the empty state.
    await detail(v.page,quiet);
    await v.page.locator('[data-open-booth-reviews]').click();
    await v.page.locator('.booth-review-list').getByText('아직 등록된 리뷰가 없어요').waitFor();
    assert.match(await v.page.locator('.booth-review-score small').innerText(),/리뷰 0개/);
    await screenshot(v.page,width,'booth-reviews-empty');
    assert.deepEqual(v.errors,[]);
    reports.push({width,passed:true,flows:['detail button with count','server refresh','average and stars','distribution','all reviewers and texts','mine highlighted','written filter','map tab active','back to detail','empty booth']});
    await v.context.close();
  }
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(reports,null,2));
  console.log(JSON.stringify(reports));
} finally { await browser.close(); }
