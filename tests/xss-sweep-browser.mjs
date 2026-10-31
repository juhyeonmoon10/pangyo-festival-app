// Real browser and operations SQL in local PGlite. Every text a student, booth manager or operator can
// store is set to an HTML payload, then every student, manager and operator screen is opened.
// Passes only when no payload runs and no payload element reaches the page.
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
for(const file of ['nfc-server/isolated-test/shim.sql','nfc-server/install.sql','nfc-server/admin-issue.sql','nfc-server/updates/20260930-nonexpiring-tags.sql','nfc-server/reviews.sql','operations-server/install.sql']) await db.exec(fs.readFileSync(path.join(root,file),'utf8'));
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
// Each payload breaks out of text, double-quoted and single-quoted attributes. 31 and 33 characters,
// so they fit the 40-character tag and card memo limits.
const X=`"'><img src=x onerror=__xss=1>`, Y=`'"><svg onload=__xss=2></svg>`;
async function account(admin,studentNumber,name) {
  const a={id:randomUUID(),session:randomUUID()};
  await db.query(`insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data) values($1,$2,now(),'{"provider":"google"}',$3)`,[a.id,`${a.id}@example.invalid`,{full_name:name,festival_name:name,festival_student_number:studentNumber}]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[a.session,a.id]);
  a.uid=(await rpc(a,'select public.festival_nfc_profile() value')).id;
  if(admin) await db.query('update public.users set admin=true where id=$1',[a.uid]);
  const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
  a.jwt=`${enc({alg:'HS256',typ:'JWT'})}.${enc({sub:a.id,session_id:a.session,exp:4102444800,role:'authenticated'})}.fixture`;
  return a;
}
const admin=await account(true,'29999',`운영${Y}`);
const write=(a,k,p)=>rpc(a,'select public.festival_ops_write($1,$2,$3) value',[k,p,randomUUID()]);
await write(admin,'event_save',{name:'XSS 점검',state:'open',reviewPoints:10,version:0});
for(const file of ['review-identity.draft','reward-visits','reward-fixed-milestones','voucher-unlimited-and-reset','review-identity-self','voucher-short-code','review-distribution-self-redeem','nfc-tag-registry','claim-guard','booth-bulk-and-tag-register','notices','operator-identity-and-scoped-reset','self-identity-and-own-club-stamps','student-number-display','student-number-only','operator-self-actions','sun-nfc','booth-managers','notice-images','booth-profile','manual-voucher-issue','booth-stamp-counts'])
  await db.exec(fs.readFileSync(path.join(root,`operations-server/${file}.sql`),'utf8'));
for(const {key} of (await db.query('select key from festival_ops.booths')).rows) await write(admin,'booth_save',{booth:key,name:key,status:'open',floor:1,version:1});
const eventId=(await db.query('select id from festival_ops.events where current')).rows[0].id;
const catalog=(await db.query('select key from festival_ops.booths order by key collate "C"')).rows.map(r=>r.key);
const CLUB='인벨릭스', OTHER=catalog.find(k=>k!==CLUB);
await db.query('select festival_ops.import_review_roster($1,$2,$3)',[eventId,{format:1,sourceSha256:'a'.repeat(64),catalogKeys:catalog,records:[
  {studentNumber:'11001',realName:`담당${X}`,clubs:[CLUB],boothKeys:[CLUB],status:'ready',issues:[],sourceCells:['Synthetic!A1']},
  {studentNumber:'21001',realName:`방문${Y}`,clubs:[`동아리${X}`],boothKeys:[],status:'ready',issues:[],sourceCells:['Synthetic!A2']}]},admin.uid]);
const lead=await account(false,'11001',`담당${X}`), visitor=await account(false,'21001',`방문${Y}`);
await rpc(lead,'select public.festival_review_identity_self($1,$2) value',['confirm',{eventId,realName:`담당${X}`}]);
await rpc(visitor,'select public.festival_review_identity_self($1,$2) value',['confirm',{eventId,realName:`방문${Y}`}]);
await rpc(admin,'select public.festival_booth_manager_admin($1,$2) value',['grant',{account:{studentNumber:'11001'},booth:CLUB,canApprove:true}]);

// Text a booth manager saves (location, room, description, every program field).
const program=Object.fromEntries(['title','description','hours','duration','participation','materials'].map(k=>[k,`${k}${X}`]));
const status=await rpc(lead,"select public.festival_booth_manager('status','{}',null) value");
const version=status.items.find(b=>b.key===CLUB).version;
await rpc(lead,'select public.festival_booth_manager($1,$2,$3) value',['save',{booth:CLUB,version,status:'open',description:`소개${X}\n${Y}`,program,location:`위치${X}`,room:`방${Y}`.slice(0,40),floor:2},null]);
// Text an operator saves (booth name, notices, rules, reasons, tag and card memos).
const other=(await db.query('select version from festival_ops.booths where key=$1',[OTHER])).rows[0].version;
await write(admin,'booth_save',{booth:OTHER,name:`부스${X}`,status:'open',floor:1,location:`교실${Y}`,description:`설명${X}`,version:other});
await rpc(admin,'select public.festival_notice_admin($1,$2) value',['save',{title:`공지${X}`,body:`본문${Y}\n${X}`,important:true,published:true,images:[]}]);
const rule=await write(admin,'rule_save',{title:`쿠폰${X}`,target:1,stock:10,enabled:true,expiresAt:'2099-01-01T00:00:00Z'});
const student=(k,p)=>rpc(admin,'select public.festival_ops_write_student($1,$2,$3) value',[k,{studentNumber:'21001',...p},randomUUID()]);
for(const booth of [OTHER,catalog.find(k=>![CLUB,OTHER].includes(k))]) await student('visit_approve',{booth,reason:`승인${X}`});
await student('points_adjust',{delta:30,reason:`조정${Y}`});
await student('voucher_issue',{ruleId:rule.id,reason:`발급${X}`});
// A written review from a confirmed student, shown under the student's roster name.
await write(visitor,'review_save',{booth:OTHER,rating:4,content:`후기${X}\n${Y}`});
// A paused booth shows the status badge on the map and the booth page.
await db.query(`update festival_ops.booths set status='paused' where key=$1`,[OTHER]);
let tagMemo=true;
try { await rpc(admin,'select public.festival_nfc_tag_admin($1,$2) value',['issue',{booth:CLUB,label:X}]); } catch { tagMemo=false; }
await db.query(`insert into festival_nfc_private.sun_cards(uid,booth,label,last_counter,registered_by) values('04A1B2C3D4E5F6',$1,$2,0,$3)`,[CLUB,X,admin.uid]);
// Names the public catalog serves.
await db.query(`update public.booths set name=$1, position=$2 where id::text=$3`,[`카탈로그${X}`,`자리${Y}`,OTHER]);
const noticeId=(await db.query('select id from festival_ops.notices')).rows[0].id;

const output=path.join(root,'artifacts/xss-sweep'); fs.mkdirSync(output,{recursive:true});
const browser=await chromium.launch({headless:true,channel:process.env.CHROME_PATH?undefined:'msedge',executablePath:process.env.CHROME_PATH});
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==','base64');
async function pageFor(a) {
  const context=await browser.newContext({viewport:{width:390,height:850},isMobile:true,hasTouch:true});
  await context.addInitScript(a=>localStorage.setItem('pangyo-google-session-v1',JSON.stringify({access_token:a.jwt,refresh_token:'fixture',token_type:'bearer',expires_at:4102444800,expires_in:3600,user:{id:a.id}})),a);
  const page=await context.newPage(), errors=[];
  page.on('pageerror',e=>errors.push(e.message)); page.on('dialog',d=>d.dismiss());
  await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());
    if(url.protocol==='file:') return route.continue();
    if(url.origin!==PROJECT_URL) return route.abort();
    try {
      if(url.pathname.startsWith('/storage/v1/object/public/')) return route.fulfill({status:200,contentType:'image/png',body:PNG});
      if(url.pathname==='/rest/v1/booths') return route.fulfill({json:(await db.query('select id,name,rating,position from public.booths')).rows});
      if(url.pathname==='/auth/v1/logout') return route.fulfill({status:204});
      const fn=/^\/rest\/v1\/rpc\/(festival_[a-z_]+)$/.exec(url.pathname)?.[1];
      if(!fn) return route.fulfill({status:404,json:{code:'PGRST202',message:'Missing optional function'}});
      const p=req.method()==='POST'?(req.postDataJSON()||{}):{}, keys=Object.keys(p).filter(k=>/^p_[a-z_]+$/.test(k));
      const value=await rpc(a,`select public.${fn}(${keys.map((k,i)=>`${k}=>$${i+1}`).join(',')}) value`,keys.map(k=>p[k]));
      return route.fulfill({json:value});
    } catch(e) { return route.fulfill({status:400,json:{code:e.code || 'TEST_ERROR',message:e.message}}); }
  });
  await page.goto(pathToFileURL(path.join(root,'index.html')).href);
  await page.waitForFunction(()=>festivalOpsUI.snapshot()?.ready);
  return {page,errors};
}
const seen=[];
async function sweep(page,name) {
  await page.waitForTimeout(150);
  const found=await page.evaluate(()=>({ran:window.__xss,nodes:document.querySelectorAll('img[src="x"],svg[onload],[onerror],[onload]').length,
    text:document.body.innerText.includes('onerror=__xss')}));
  assert.equal(found.ran,undefined,`payload ran on ${name}`);
  assert.equal(found.nodes,0,`payload element on ${name}`);
  seen.push(found.text?name:`${name}(no payload text)`);
}
const go=(page,route,extra={})=>page.evaluate(([r,x])=>{Object.assign(state,x);state.route=r;render();},[route,extra]);
const bad=[];
try {
  // Student screens.
  const v=await pageFor(visitor);
  const otherId=await v.page.evaluate(k=>state.db.booths.find(b=>boothKeyFor(b)===k)?.id,OTHER);
  const clubId=await v.page.evaluate(k=>state.db.booths.find(b=>boothKeyFor(b)===k)?.id,CLUB);
  for(const route of ['home','stamps','vouchers','profile','reviews','identity','notices']) { await go(v.page,route); await sweep(v.page,`student ${route}`); }
  await go(v.page,'notice',{noticeId}); await sweep(v.page,'student notice');
  await go(v.page,'map'); await v.page.evaluate(()=>{setSheetLevel('full');render();}); await sweep(v.page,'student map list');
  for(const id of [otherId,clubId]) {
    await v.page.evaluate(id=>goDetail(id),id); await sweep(v.page,`student detail ${id}`);
    await go(v.page,'boothReviews',{selectedBoothId:id}); await sweep(v.page,`student reviews ${id}`);
    await go(v.page,'map',{selectedBoothId:id}); await v.page.evaluate(id=>{state.selectedBoothId=id;render();},id); await sweep(v.page,`student map card ${id}`);
  }
  for(const floor of [1,2,3,4]) { await v.page.evaluate(f=>{state.route='map';state.floor=f;render();},floor); await sweep(v.page,`student map floor ${floor}`); }
  await v.page.screenshot({path:path.join(output,'student.png'),fullPage:true});
  bad.push(...v.errors.map(e=>`student: ${e}`));

  // Booth manager screens.
  const m=await pageFor(lead);
  await go(m.page,'profile'); await sweep(m.page,'manager profile');
  await go(m.page,'manage'); await m.page.locator('[data-manager-save]').waitFor(); await sweep(m.page,'manager manage');
  await m.page.locator('[data-manager-lookup] [name=studentNumber]').fill('21001');
  await m.page.locator('[data-manager-lookup] button[type=submit]').click();
  await m.page.locator('[data-manager-approve]').waitFor(); await sweep(m.page,'manager lookup');
  await m.page.screenshot({path:path.join(output,'manager.png'),fullPage:true});
  bad.push(...m.errors.map(e=>`manager: ${e}`));

  // Operator screens: every tool, plus the lookups that print student records.
  const a=await pageFor(admin);
  await go(a.page,'admin'); await sweep(a.page,'admin home');
  for(const tool of ['dashboard','audit','catalog','nfc','sun','visits','participants','identity_overview','booth_managers','ledger','rules','vouchers','claim_guard','notice_admin','stamp-simulator','settings']) {
    await openOperatorTool(a.page,tool); await a.page.waitForTimeout(250); await sweep(a.page,`admin ${tool}`);
  }
  await openOperatorTool(a.page,'booth_managers');
  await a.page.locator('[data-bm-find] [name=studentNumber]').fill('11001');
  await a.page.locator('[data-bm-find] button[type=submit]').click();
  await a.page.waitForTimeout(400); await sweep(a.page,'admin booth manager find');
  await openOperatorTool(a.page,'participants');
  const finder=a.page.locator('form[data-identity-find], [data-ops-form=identity_find], form:has([name=studentNumber])').first();
  if(await finder.count()) { await finder.locator('[name=studentNumber]').fill('21001'); await finder.locator('button[type=submit]').click(); await a.page.waitForTimeout(400); await sweep(a.page,'admin identity find'); }
  await a.page.screenshot({path:path.join(output,'admin.png'),fullPage:true});
  bad.push(...a.errors.map(e=>`admin: ${e}`));
  assert.deepEqual(bad,[]);
  console.log(JSON.stringify({passed:true,tagMemo,screens:seen.length,withoutPayloadText:seen.filter(s=>s.endsWith('(no payload text)'))}));
} finally { await browser.close(); }
