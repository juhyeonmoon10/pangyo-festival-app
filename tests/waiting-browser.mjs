// Real browser and operations SQL; all remote requests terminate in local PGlite (storage is mocked).
// Covers 웨이팅 (1.59): manager settings, online and QR registration, postpone, call, enter, cancel with a reason, walk-ins.
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
await write(admin,'event_save',{name:'부스 담당자 격리 검증',state:'open',reviewPoints:10,version:0});
for(const file of ['review-identity.draft','reward-visits','reward-fixed-milestones','voucher-unlimited-and-reset','review-identity-self','voucher-short-code','review-distribution-self-redeem','nfc-tag-registry','claim-guard','booth-bulk-and-tag-register','notices','operator-identity-and-scoped-reset','self-identity-and-own-club-stamps','student-number-display','student-number-only','operator-self-actions','sun-nfc','booth-managers','notice-images','booth-profile','manual-voucher-issue','waiting'])
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
const output=path.join(root,'artifacts/waiting'); fs.mkdirSync(output,{recursive:true});
const browser=await chromium.launch({headless:true,channel:process.env.CHROME_PATH?undefined:'msedge',executablePath:process.env.CHROME_PATH});
const pages=[], uploads=[], boothUploads=[], removed=[];
const IPHONE_CHROME='Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1';
async function pageFor(a,width=390,userAgent) {
  const context=await browser.newContext({viewport:{width,height:850},isMobile:true,hasTouch:true,...(userAgent?{userAgent}:{})});
  await context.addInitScript(a=>localStorage.setItem('pangyo-google-session-v1',JSON.stringify({access_token:a.jwt,refresh_token:'fixture',token_type:'bearer',expires_at:4102444800,expires_in:3600,user:{id:a.id}})),a);
  const page=await context.newPage(), errors=[];
  page.on('pageerror',e=>errors.push(e.message)); page.on('dialog',d=>d.accept(d.type()==='prompt'?'재료 소진으로 오늘 운영을 마쳐요':undefined));
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
      else if(url.pathname==='/rest/v1/rpc/festival_waiting') value=await call('festival_waiting','$1,$2',[p.p_action,p.p_payload]);
      else if(url.pathname==='/rest/v1/rpc/festival_waiting_manage') value=await call('festival_waiting_manage','$1,$2',[p.p_action,p.p_payload]);
      else if(url.pathname==='/auth/v1/logout') return route.fulfill({status:204});
      else return route.fulfill({status:404,json:{code:'PGRST202',message:'Missing optional function'}});
      return route.fulfill({json:value});
    } catch(e) { return route.fulfill({status:400,json:{code:e.code || 'TEST_ERROR',message:e.message}}); }
  });
  await page.goto(pathToFileURL(path.join(root,'index.html')).href);
  await page.waitForFunction(()=>festivalOpsUI.snapshot()?.ready).catch(e=>{ throw Error('page did not load: '+(errors.join(' | ') || e.message)); });
  pages.push({page,errors});
  return {page,context,errors};
}
const routeTo=(page,route)=>page.evaluate(r=>{state.route=r;render();},route);
async function check(page,name,width=390) {
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`overflow ${name}`);
  await page.screenshot({path:path.join(output,`${width}-${name}.png`),fullPage:true});
}
const flows=[];
const s2=await account(false,'21002','가상둘'), s3=await account(false,'21003','가상셋');
try {
  // The manager turns waiting on from 부스 관리 → 웨이팅 관리 → 설정.
  const m=await pageFor(admin);
  await routeTo(m.page,'manage');
  await m.page.locator('[data-manager-booth]').selectOption(CLUB);
  const open=m.page.locator('[data-manager-waiting]');
  await open.waitFor();
  assert.match(await open.innerText(),/웨이팅 관리\s*사용 안 함/);
  await open.click();
  await m.page.locator('.waiting-admin-screen .waiting-admin-head h2',{hasText:CLUB}).waitFor();
  await m.page.locator('[data-wm-tab=settings]').click();
  const settings=m.page.locator('[data-wm-settings]');
  await settings.locator('[name=enabled]').check();
  await settings.locator('[name=maxParty]').fill('4');
  await settings.locator('[name=durationMinutes]').fill('5');
  await settings.locator('[name=postponeMaxTeams]').fill('2');
  await check(m.page,'manager-settings');
  await settings.locator('button[type=submit]').click();
  await m.page.getByText('설정을 저장했어요.',{exact:false}).waitFor();
  const saved=(await db.query('select enabled,online,qr,max_party from festival_ops.waiting_settings where booth_key=$1',[CLUB])).rows[0];
  assert.deepEqual(saved,{enabled:true,online:true,qr:true,max_party:4});
  assert.equal((await db.query('select duration_minutes from festival_ops.booths where key=$1',[CLUB])).rows[0].duration_minutes,5);
  flows.push('manager settings');

  // A student registers online from the booth page with a party of 2.
  const v=await pageFor(visitor);
  const id=await v.page.evaluate(k=>state.db.booths.find(b=>boothKeyFor(b)===k)?.id,CLUB);
  await v.page.evaluate(id=>goDetail(id),id);
  const panel=v.page.locator('.waiting-panel');
  await panel.waitFor();
  assert.match(await panel.innerText(),/접수 중[\s\S]*현재 대기\s*0\s*팀[\s\S]*곧 입장/);
  await panel.locator('[data-waiting-join]').click();
  const sheet=v.page.locator('.waiting-sheet');
  await sheet.waitFor();
  await sheet.locator('[data-waiting-party="1"]').click();
  assert.equal(await sheet.locator('.waiting-stepper output strong').innerText(),'2');
  await check(v.page,'join-sheet');
  await sheet.locator('button[type=submit]').click();
  await v.page.locator('.waiting-ticket h1',{hasText:'웨이팅 등록 완료'}).waitFor();
  const ticket=await v.page.locator('.waiting-ticket').innerText();
  assert.match(ticket,/대기번호\s*1\s*번/); assert.match(ticket,/현재 대기순번\s*1\s*번째/); assert.match(ticket,/현재 대기\s*1\s*팀/); assert.match(ticket,/곧 입장/);
  assert.match(ticket,/2명 · 온라인 등록/);
  await v.page.locator('[data-waiting-alert]').waitFor();
  await check(v.page,'join-success');
  flows.push('online registration','success screen');

  // Two more teams; the third sees 2 teams ahead × 5 minutes.
  const w2=await pageFor(s2), w3=await pageFor(s3);
  for(const w of [w2,w3]) {
    await w.page.evaluate(id=>goDetail(id),id);
    await w.page.locator('[data-waiting-join]').click();
    await w.page.locator('.waiting-sheet button[type=submit]').click();
    await w.page.locator('.waiting-ticket').waitFor();
  }
  assert.match(await w3.page.locator('.waiting-ticket').innerText(),/현재 대기순번\s*3\s*번째[\s\S]*현재 대기\s*3\s*팀[\s\S]*약 10분/);
  // 순서 미루기: within 3 teams of the front, 1~2 teams (the booth's limit), from 2nd to 3rd.
  const box=w2.page.locator('[data-waiting-postpone]');
  await box.waitFor();
  assert.equal(await box.locator('[name=postponeTeams]').count(),1);
  assert.match(await box.locator('[data-postpone-preview]').innerText(),/2번째\s*3번째/);
  await check(w2.page,'postpone');
  await box.locator('[data-waiting-postpone-go]').click();
  await w2.page.getByText('입장 순서를 2번째에서 3번째로 미뤘어요.',{exact:false}).waitFor();
  flows.push('postpone');

  // The board: names, student numbers and party; call the first team.
  await m.page.locator('[data-wm-tab=queue]').click();
  const rows=m.page.locator('.waiting-queue .waiting-row');
  await m.page.waitForFunction(()=>document.querySelectorAll('.waiting-queue .waiting-row').length===3);
  assert.match(await rows.nth(0).innerText(),/가상방문\s*21001[\s\S]*2명 · 온라인/);
  assert.match(await rows.nth(1).innerText(),/가상셋\s*21003/);
  await check(m.page,'manager-queue');
  await rows.nth(0).locator('[data-wm-act=call]').click();
  await m.page.getByText('대기번호 1번 호출했어요.',{exact:false}).waitFor();
  const outbox=async uid=>(await db.query('select kind,body from festival_ops.push_outbox where user_id=$1 order by id',[uid])).rows;
  assert.deepEqual((await outbox(visitor.uid)).map(r=>r.kind),['called']);
  await v.page.locator('[data-waiting-refresh]').click();
  await v.page.locator('.waiting-ticket.is-called h1',{hasText:'입장할 차례예요'}).waitFor();
  // Entering the called team moves everyone up and queues their pushes.
  await m.page.locator('.waiting-queue .waiting-row').nth(0).locator('[data-wm-act=enter]').click();
  await m.page.getByText('입장 처리했어요.',{exact:false}).waitFor();
  const third=(await outbox(s3.uid)).filter(r=>r.kind==='ahead');
  assert.match(third.at(-1).body,/현재 대기순번 1번째 · 현재 대기 2팀 · 예상 대기시간 곧 입장/);
  flows.push('call','enter','ahead push');

  // The booth cancels with a reason; the student sees the whole reason.
  await m.page.locator('.waiting-queue .waiting-row').nth(1).locator('[data-wm-act=cancel]').click();
  await m.page.getByText('취소했어요.',{exact:false}).waitFor();
  assert.match((await outbox(s2.uid)).at(-1).body,/취소 사유: 재료 소진으로 오늘 운영을 마쳐요/);
  await w2.page.locator('[data-waiting-refresh]').click();
  await w2.page.locator('.waiting-reason',{hasText:'재료 소진으로 오늘 운영을 마쳐요'}).waitFor();
  await check(w2.page,'cancelled-by-booth');
  flows.push('cancel with reason');

  // Walk-in and the 완료 tab.
  await m.page.locator('[data-wm-walkin-open]').click();
  await m.page.locator('[data-wm-walkin] [name=name]').fill('파란 모자');
  await m.page.locator('[data-wm-walkin] [name=party]').fill('3');
  await m.page.locator('[data-wm-walkin] button[type=submit]').click();
  await m.page.getByText('대기번호 4번으로 추가했어요.',{exact:false}).waitFor();
  await m.page.locator('[data-wm-tab=done]').click();
  const doneText=await m.page.locator('.waiting-done').innerText();
  assert.match(doneText,/가상둘 21002[\s\S]*사유: 재료 소진/); assert.match(doneText,/가상방문 21001[\s\S]*입장/);
  flows.push('walk-in','done tab');

  // On-site QR: fixed QR shown to the manager; the QR page registers with its token.
  await m.page.locator('[data-wm-tab=qr]').click();
  await m.page.locator('.waiting-qr-code svg').waitFor();
  await check(m.page,'manager-qr');
  const token=(await db.query('select festival_ops.waiting_qr_token(s) t from festival_ops.waiting_settings s where booth_key=$1',[CLUB])).rows[0].t;
  // This one is an iPhone in Chrome: registering pops up the home-screen steps, naming no browser.
  const q=await pageFor(lead,390,IPHONE_CHROME);
  await q.page.evaluate(([booth,token])=>{sessionStorage.setItem('pangyo-waiting-qr-v1',JSON.stringify({booth,token,at:Date.now()}));state.waitingBooth=booth;navigateTo('waitingJoin');},[CLUB,token]);
  await q.page.locator('.waiting-join-card [data-waiting-join-form]').waitFor();
  await check(q.page,'qr-join');
  await q.page.locator('.waiting-join-card button[type=submit]').click();
  await q.page.locator('.waiting-ticket h1',{hasText:'웨이팅 등록 완료'}).waitFor();
  assert.match(await q.page.locator('.waiting-ticket').innerText(),/현장 QR 등록/);
  const popup=q.page.locator('dialog.waiting-apple-dialog[open]');
  await popup.waitFor();
  const popupText=await popup.innerText();
  assert.match(popupText,/지금 이대로는 알림이 오지 않아요[\s\S]*홈 화면에 추가[\s\S]*브라우저의[\s\S]*공유[\s\S]*같은 계정으로 로그인/);
  assert.doesNotMatch(popupText,/Safari/);
  await q.page.waitForTimeout(350);
  await check(q.page,'iphone-popup');
  await popup.locator('[data-waiting-apple-ok]').click();
  await popup.waitFor({state:'detached'});
  const card=await q.page.locator('[data-waiting-alert].is-apple').innerText();
  assert.match(card,/브라우저의/); assert.doesNotMatch(card,/Safari/);
  flows.push('qr registration','iphone popup');

  // Home banner and 내 정보 list.
  await routeTo(w3.page,'home');
  await w3.page.locator('.waiting-banner').waitFor();
  assert.match(await w3.page.locator('.waiting-banner').innerText(),new RegExp(`${CLUB} 웨이팅[\\s\\S]*1번째`));
  await check(w3.page,'home-banner');
  await routeTo(w3.page,'profile');
  await w3.page.locator('[data-waiting-list] .waiting-list li').first().waitFor();
  flows.push('home banner','profile list');

  for(const {errors} of pages) assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,flows}));
} finally { await browser.close(); }
