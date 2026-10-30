// Real browser and operations SQL; all remote requests terminate in local PGlite.
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
await write(admin,'event_save',{name:'운영자 복구 격리 검증',state:'open',reviewPoints:10,version:0});
await db.exec(fs.readFileSync(path.join(root,'operations-server/review-identity.draft.sql'),'utf8'));
await db.exec(fs.readFileSync(path.join(root,'operations-server/voucher-short-code.sql'),'utf8'));
const eventId=(await db.query('select id from festival_ops.events where current')).rows[0].id;
const catalog=(await db.query('select key from festival_ops.booths order by key collate "C"')).rows.map(r=>r.key);
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
      else if(url.pathname==='/rest/v1/rpc/festival_voucher_code') {
        value=await rpc(a,'select public.festival_voucher_code($1) value',[p.p_voucher]); control.qrToken=value.code;
      }
      else if(url.pathname==='/rest/v1/rpc/festival_voucher_redeem') {
        calls.push(p); value=await rpc(a,'select public.festival_voucher_redeem($1,$2,$3) value',[p.p_action,p.p_payload,p.p_request_id ?? null]);
      }
      else if(url.pathname==='/rest/v1/rpc/festival_review_identity_admin') {
        calls.push(p); value=await rpc(a,'select public.festival_review_identity_admin($1,$2) value',[p.p_action,p.p_payload]);
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
  await openOperatorTool(page,name);
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
    const studentNumber=`11${width}`;
    await db.query('select festival_ops.import_review_roster($1,$2,$3)',[eventId,{format:1,sourceSha256:'a'.repeat(64),catalogKeys:catalog,
      records:[{studentNumber,realName:'가상학생',clubs:['인벨릭스'],boothKeys:['인벨릭스'],status:'ready',issues:[],sourceCells:['Synthetic!A1']}]},admin.uid]);
    await routeTo(a.page,'admin');
    await a.page.getByText('운영 중인 부스가 없어 방문 인증이 중지돼 있어요.',{exact:true}).waitFor();
    await screenshot(a.page,width,'single-festival-dashboard');
    await openOperatorTool(a.page,'settings');
    await a.page.locator('[data-ops-form=event_save]').waitFor();
    assert.equal(await a.page.getByRole('heading',{name:'축제 운영 설정',exact:true}).count(),1);
    const settings=a.page.locator('[data-ops-form=event_save]');
    const version=await settings.locator('[name=version]').inputValue();
    const writesBefore=a.calls.length;
    await settings.locator('[name=version]').evaluate(input=>input.value='0');
    await settings.locator('button[type=submit]').click();
    await a.page.getByText('축제 정보를 다시 불러온 뒤 저장해 주세요.',{exact:true}).waitFor();
    assert.equal(a.calls.length,writesBefore,'Version zero must never reach the server creation path');
    await settings.locator('[name=version]').evaluate((input,value)=>input.value=value,version);
    await openOperatorTool(a.page,'catalog');
    await a.page.getByRole('heading',{name:'부스 수정',exact:true}).waitFor();
    assert.notEqual(await a.page.locator('#opsBoothSelect').inputValue(),'');
    const menus={dashboard:'.ops-stats',settings:'[data-ops-form=event_save]',catalog:'[data-ops-form=booth_save]',participants:'#reviewRosterLookup',visits:'[data-ops-form=visit_approve]',ledger:'[data-ops-form=points_adjust]',rules:'[data-ops-form=rule_save]',vouchers:'#opsRedeem',audit:'.ops-paging',nfc:'.nfc-manager-heading'};
    for(const [name,selector] of Object.entries(menus)) {
      await tab(a.page,name,selector);
      await screenshot(a.page,width,`tool-${name}`);
    }
    await a.page.locator('.festival-ops-tabs [data-ops-tab=tools]').click();
    await a.page.locator('.festival-ops-tools').waitFor();
    assert.equal(await a.page.locator('.festival-ops-tools button').count(),9);
    await screenshot(a.page,width,'tool-menu');
    await a.page.locator('.festival-ops-tools [data-ops-tab=ledger]').click();
    await a.page.locator('[data-ops-form=points_adjust]').waitFor();

    await tab(a.page,'participants','#reviewRosterLookup');
    const lookup=a.page.locator('#reviewRosterLookup');
    await lookup.locator('[name=userId]').selectOption(String(student.uid));
    await lookup.locator('button[type=submit]').click();
    const roster=a.page.locator('#reviewRosterForm'); await roster.waitFor();
    assert.equal(await roster.locator('[name=realName],[name=boothKeys]').count(),0);
    assert.equal(await roster.locator('button[type=submit]').isDisabled(),true);
    await roster.locator('[name=studentNumber]').fill(studentNumber);
    await roster.locator('[data-roster-find]').click();
    await roster.getByText('명단 대조 완료',{exact:true}).waitFor();
    await screenshot(a.page,width,'official-roster-link');
    const dimensions=await roster.evaluate(f=>({width:f.clientWidth,scroll:f.scrollWidth}));
    assert.ok(dimensions.scroll<=dimensions.width+1,'Roster dialog must not overflow');
    await roster.locator('[name=studentNumber]').fill('19999');
    assert.equal(await roster.locator('button[type=submit]').isDisabled(),true);
    await roster.locator('[data-roster-find]').click();
    await roster.getByText('명단에 없는 학번이에요.',{exact:true}).waitFor();
    await roster.locator('[name=studentNumber]').fill(studentNumber);
    await roster.locator('[data-roster-find]').click();
    await roster.getByText('명단 대조 완료',{exact:true}).waitFor();
    await roster.locator('[name=confirmed]').check();
    await roster.locator('[name=reason]').fill('합성 계정 본인 확인');
    const beforeLink=a.calls.filter(c=>c.p_action==='save').length;
    await roster.evaluate(f=>{f.requestSubmit();f.requestSubmit();});
    await roster.getByText('명단과 계정을 연결했어요.',{exact:true}).waitFor();
    assert.equal(a.calls.filter(c=>c.p_action==='save').length,beforeLink+1);
    const policy=await rpc(student,'select public.festival_ops_read($1,$2) value',['reviews',{booth:'인벨릭스'}]);
    assert.equal(policy.reviewPolicy.reason,'OWN_CLUB_REVIEW');
    await a.page.locator('.ops-dialog [aria-label=닫기]').click();

    // Manual selection and NFC use the real RPC contract, without touching shared data.
    await db.query("update festival_ops.booths set status='open' where event_id=$1 and key in ('인벨릭스','글빛누리','모멘트')",[eventId]);
    await assert.rejects(write(admin,'visit_approve',{userId:999999,booth:'인벨릭스',reason:'unknown internal ID'}),/NOT_FOUND/);
    await tab(a.page,'visits','[data-ops-form=visit_approve]');
    const approval=a.page.locator('[data-ops-form=visit_approve]');
    assert.equal(await approval.locator('input[type=number]').count(),0);
    await approval.locator('[name=booth]').selectOption('인벨릭스');
    await approval.locator('[name=reason]').fill('현장 학생 본인 확인');
    const beforeApproval=a.calls.filter(c=>c.p_action==='visit_approve').length;
    await approval.locator('button[type=submit]').click();
    await approval.getByText('처리할 참여자를 선택해 주세요.',{exact:true}).waitFor();
    assert.equal(a.calls.filter(c=>c.p_action==='visit_approve').length,beforeApproval);
    await approval.locator('[data-pick-participant]').click();
    const picker=a.page.locator('.ops-participant-dialog');
    await picker.locator(`[data-participant-id="${student.uid}"]`).waitFor();
    assert.equal(await picker.locator(`[data-participant-id="${admin.uid}"]`).isDisabled(),true);
    const searchBox=picker.getByRole('textbox',{name:'참여자 이름'});
    await searchBox.fill('없는이름'); await picker.getByRole('button',{name:'참여자 검색',exact:true}).click();
    await picker.getByText('검색 결과가 없어요. 이름을 다시 확인해 주세요.',{exact:true}).waitFor();
    await searchBox.fill('격리 학생');
    await searchBox.dispatchEvent('keydown',{key:'Enter',isComposing:true});
    assert.equal(await searchBox.inputValue(),'격리 학생');
    await picker.getByRole('button',{name:'참여자 검색',exact:true}).click();
    await picker.locator(`[data-participant-id="${student.uid}"]`).click();
    await picker.locator('[data-confirm-participant]').waitFor();
    await screenshot(a.page,width,'manual-visit-participant');
    await picker.locator('[data-confirm-participant]').click();
    assert.equal(await approval.locator('[name=reason]').inputValue(),'현장 학생 본인 확인');
    await approval.evaluate(f=>{f.requestSubmit();f.requestSubmit();});
    await a.page.getByText('격리 학생님에게 스탬프 1개를 적립했어요.',{exact:true}).waitFor();
    assert.equal(a.calls.filter(c=>c.p_action==='visit_approve').length,beforeApproval+1);
    assert.equal(a.calls.filter(c=>c.p_action==='visit_approve').at(-1).p_payload.userId,student.uid);
    await approval.locator('[name=booth]').selectOption('인벨릭스');
    await approval.locator('[name=reason]').fill('동일 방문 재확인');
    await approval.locator('button[type=submit]').click();
    await a.page.getByText('이미 적립한 부스예요. 스탬프는 1개만 유지돼요.',{exact:true}).waitFor();
    await approval.locator('[name=reason]').fill('대상 변경 후 재확인');
    await db.query('update public.users set auth_user_id=null where id=$1',[student.uid]);
    await approval.locator('button[type=submit]').click();
    await approval.getByText('선택한 참여자 또는 처리 대상을 찾지 못했어요. 새로고침 후 다시 선택해 주세요.',{exact:true}).waitFor();
    assert.equal(await approval.locator('[name=userId]').inputValue(),'');
    await db.query('update public.users set auth_user_id=$1 where id=$2',[student.id,student.uid]);
    await s.page.evaluate(async()=>{await festivalOpsUI.refresh(false);state.route='stamps';render();});
    assert.equal(await s.page.evaluate(()=>festivalWeb.completed().length),1,'Own-club stamp counts without a review');
    assert.equal((await rpc(student,'select public.festival_ops_read($1,$2) value',['reviews',{booth:'인벨릭스'}])).reviewPolicy.reason,'OWN_CLUB_REVIEW');
    for(const [booth,expected] of [['글빛누리',2],['글빛누리',2],['모멘트',3]]) {
      const token=(await db.query("select festival_nfc_private.issue_tag($1::public.booth_enum, now()+interval '1 hour') as token",[booth])).rows[0].token;
      const result=await s.page.evaluate(token=>nfcAdapter.scan({nfcToken:token,idempotencyKey:crypto.randomUUID()}),token);
      assert.equal(result.ok,true,JSON.stringify(result));
      assert.equal(await s.page.evaluate(()=>festivalWeb.completed().length),expected);
      assert.equal(await s.page.locator('.stamp-path-step.is-earned').count(),expected);
      await s.page.locator('#nfcFeedback .feedback-close').click();
    }
    const visitsOnly=await rpc(student,'select public.festival_ops_read($1,$2) value',['me',{}]);
    assert.equal(visitsOnly.visits.length,3); assert.equal(visitsOnly.reviews.length,0);
    await s.page.reload(); await s.page.waitForFunction(()=>festivalOpsUI.snapshot()?.ready);
    await routeTo(s.page,'stamps'); assert.equal(await s.page.locator('.stamp-path-step.is-earned').count(),3);
    await screenshot(s.page,width,'stamps-without-reviews');
    await db.query("update festival_ops.booths set status='paused' where event_id=$1",[eventId]);
    await tab(a.page,'participants','#reviewRosterLookup');
    await lookup.locator('[name=userId]').selectOption(String(student.uid));
    await lookup.locator('button[type=submit]').click();
    await roster.locator('[data-roster-revoke]').waitFor();
    await roster.locator('[name=reason]').fill('합성 계정 확인 취소');
    await roster.locator('[data-roster-revoke]').click();
    await roster.getByText('확인을 취소했어요.',{exact:true}).waitFor();
    await a.page.locator('.ops-dialog [aria-label=닫기]').click();

    a.control.slowKind='participants';
    const started=new Promise(r=>{a.control.waitStarted=r;});
    await openOperatorTool(a.page,'participants'); await started;
    await openOperatorTool(a.page,'ledger');
    assert.equal(await a.page.locator('.ops-body h1').innerText(),'포인트');
    await openOperatorTool(a.page,'rules');
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
    await issue.locator('button[type=submit]').click();
    await issue.getByText('처리할 참여자를 선택해 주세요.',{exact:true}).waitFor();
    assert.equal(await issue.locator('input[type=number]').count(),0);
    await issue.locator('[data-pick-participant]').click();
    await picker.locator(`[data-participant-id="${student.uid}"]`).click();
    await picker.locator('[data-confirm-participant]').click();
    assert.equal(await issue.locator('[name=reason]').inputValue(),'격리 발급 검증');
    const before=a.calls.filter(x=>x.p_action==='voucher_issue').length;
    await issue.evaluate(f=>{f.requestSubmit();f.requestSubmit();});
    await a.page.getByText('바우처를 발급했어요.',{exact:true}).waitFor();
    assert.equal(a.calls.filter(x=>x.p_action==='voucher_issue').length-before,1);
    const mine=await rpc(student,'select public.festival_ops_read($1,$2) value',['me',{}]);
    assert.equal(mine.vouchers.length,1); assert.equal(mine.vouchers[0].state,'available');
    await screenshot(a.page,width,'issued');

    await s.page.evaluate(async()=>{await festivalOpsUI.refresh(false);state.route='vouchers';render();});
    await s.page.locator('[data-voucher-filter="available"]').click();
    await s.page.locator('[data-ops-qr]').click(); await s.page.locator('.ops-qr svg').waitFor();
    assert.match(s.control.qrToken,/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);
    assert.equal((await s.page.locator('.ops-voucher-code').innerText()).replace(/\s/g,''),s.control.qrToken);
    assert.match(await s.page.locator('.ops-code-timer').innerText(),/초 후 새 인증키로 바뀌어요/);
    // The async clipboard is commonly blocked in in-app browsers; the selection fallback must still copy.
    await s.page.evaluate(()=>{window.__copied=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>Promise.reject(new Error('blocked'))}});
      document.addEventListener('copy',e=>window.__copied.push(document.getSelection().toString() || e.target?.value || document.activeElement?.value));});
    await s.page.locator('[data-copy-code]').click();
    await s.page.locator('.ops-copy-status').getByText('인증키를 복사했어요.').waitFor();
    assert.deepEqual(await s.page.evaluate(()=>window.__copied),[s.control.qrToken]);
    await screenshot(s.page,width,'voucher-code');
    // Manual entry tolerates lowercase and a separating space.
    await a.page.locator('#opsRedeem [name=token]').fill(`${s.control.qrToken.slice(0,4).toLowerCase()} ${s.control.qrToken.slice(4)}`);
    await a.page.locator('#opsRedeem button[type=submit]').click();
    await a.page.waitForFunction(()=>document.querySelector('#opsRedeem [name=token]')?.value==='');
    assert.equal((await rpc(student,'select public.festival_ops_read($1,$2) value',['me',{}])).vouchers[0].state,'used');
    await screenshot(a.page,width,'redeemed');

    await tab(a.page,'ledger','[data-ops-form=points_adjust]');
    const adjustment=a.page.locator('[data-ops-form=points_adjust]');
    assert.equal(await adjustment.locator('input[name=userId][type=number]').count(),0);
    await adjustment.locator('[name=delta]').fill('10');
    await adjustment.locator('[name=reason]').fill('합성 포인트 조정');
    await adjustment.locator('[data-pick-participant]').click();
    await picker.locator(`[data-participant-id="${student.uid}"]`).click();
    await picker.locator('[data-confirm-participant]').click();
    const beforePoints=a.calls.filter(c=>c.p_action==='points_adjust').length;
    await adjustment.evaluate(f=>{f.requestSubmit();f.requestSubmit();});
    await a.page.getByText('저장했어요.',{exact:true}).waitFor();
    assert.equal(a.calls.filter(c=>c.p_action==='points_adjust').length,beforePoints+1);
    assert.equal(a.calls.filter(c=>c.p_action==='points_adjust').at(-1).p_payload.userId,student.uid);

    for(const mode of ['unknown','legacy']) {
      a.control.reward=mode; await tab(a.page,'rules','.ops-alert');
      assert.equal(await a.page.locator('[data-ops-form=rule_save],[data-ops-form=reward_config]').count(),0);
    }
    a.control.reward='missing'; a.control.failKind='participants';
    await tab(a.page,'participants','.ops-alert'); assert.equal(await a.page.locator('#reviewRosterLookup').count(),0);
    a.control.failKind=null; await a.page.locator('[data-ops-refresh]').click();
    await a.page.locator('#reviewRosterLookup').waitFor();
    a.control.noEvent=true; await tab(a.page,'vouchers','.ops-unavailable');
    assert.equal(await a.page.locator('[data-ops-form=event_save]').count(),0);
    await tab(a.page,'dashboard','.ops-unavailable');
    assert.equal(await a.page.locator('[data-ops-form]').count(),0,'Missing event offers no creation or write form');
    await screenshot(a.page,width,'single-festival-unavailable');
    const writesWhileMissing=a.calls.length;
    a.control.noEvent=false; await a.page.locator('.ops-unavailable [data-ops-refresh]').click();
    await tab(a.page,'settings','[data-ops-form=event_save]');
    await a.page.locator('[data-ops-form=event_save]').waitFor();
    assert.equal(a.calls.length,writesWhileMissing,'Reload must be read-only');
    await routeTo(s.page,'admin'); assert.equal(await s.page.locator('[data-ops-tab]').count(),0);
    assert.deepEqual(a.errors,[]); assert.deepEqual(s.errors,[]);
    reports.push({width,passed:true,menus:9,flows:['single festival settings','no creation on missing event','version-zero write rejected','paused booth readiness','immediate tab changes','delayed response race','participant picker and Korean search','missing recipient rejected','own account disabled','manual approval double-submit','NOT_FOUND recovery','NFC one visit one stamp without rating','NFC duplicate guard','stamp persistence after reload','own-club review still denied','legacy rule save','manual issue','double-submit guard','student QR','redemption','missing/unknown API distinction','permission failure retry','empty event','student denied']});
    await a.context.close(); await s.context.close();
  }
} catch(e) { reports.push({passed:false,error:e.stack}); console.error(e); process.exitCode=1; }
finally {
  await browser.close(); await db.close();
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({environment:'Edge + local PostgreSQL shim; no shared DB access',reports},null,2));
  console.log(JSON.stringify(reports));
}
