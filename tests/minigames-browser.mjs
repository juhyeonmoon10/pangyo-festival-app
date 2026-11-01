// 미니게임 (1.37, 1.38 matching count and rematch) browser check. Harness copied from voucher-manager-browser.mjs; orbit_* calls are stubbed.
// Real browser and festival operations SQL in local PGlite. ORBIT's orbit_* functions and the stock_price_history
// and news tables are answered by a synthetic market and a scripted blackjack opponent (gameStub).
// Covers: 5-tab bottom navigation, games reachable only from it, 가상주식 list/search/favorites/detail/trade/retry, 블랙잭 flow.
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
for(const file of ['review-identity.draft','reward-visits','reward-fixed-milestones','voucher-unlimited-and-reset','review-identity-self','voucher-short-code','review-distribution-self-redeem','nfc-tag-registry','claim-guard','booth-bulk-and-tag-register','notices','operator-identity-and-scoped-reset','self-identity-and-own-club-stamps','student-number-display','student-number-only','operator-self-actions','sun-nfc','booth-managers','notice-images','booth-profile','manual-voucher-issue','voucher-managers','voucher-approval-and-manual-issue'])
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
const output=path.join(root,'artifacts/minigames'); fs.mkdirSync(output,{recursive:true});
const cameraFile=path.join(output,'camera.y4m');
fs.writeFileSync(cameraFile,'');
const browser=await chromium.launch({headless:true,channel:process.env.CHROME_PATH?undefined:'msedge',executablePath:process.env.CHROME_PATH,
  args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream',`--use-file-for-fake-video-capture=${cameraFile}`]});
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
      const stub=globalThis.gameStub && await globalThis.gameStub(url,p,a);
      if(stub) return route.fulfill(stub);
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
// The fake camera shows this voucher's current QR (the student's screen), drawn as a Y4M video.
const {createRequire:req}=await import('node:module');
const qrcode=req(import.meta.url)('../assets/vendor/qrcode-1.4.4.js');
async function showOnCamera(id) {
  const q=qrcode(0,'M'); q.addData(await codeOf(id)); q.make();
  const W=640,H=480,n=q.getModuleCount(),cell=Math.floor(360/(n+8)),size=cell*(n+8),x0=(W-size)/2|0,y0=(H-size)/2|0;
  const y=Buffer.alloc(W*H,235);
  for(let r=0;r<n;r++) for(let c=0;c<n;c++) if(q.isDark(r,c))
    for(let dy=0;dy<cell;dy++) y.fill(16,(y0+(r+4)*cell+dy)*W+x0+(c+4)*cell,(y0+(r+4)*cell+dy)*W+x0+(c+5)*cell);
  const uv=Buffer.alloc(W*H/2,128), frame=Buffer.concat([Buffer.from('FRAME\n'),y,uv]);
  fs.writeFileSync(cameraFile,Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`),frame,frame]));
}
// The popup after an approval: voucher, owner name, 학번 and the approval date and time.
async function popup(page,title) {
  const list=page.locator('.voucher-approved-list');
  await list.waitFor();
  const rows=Object.fromEntries(await list.locator('div').evaluateAll(ds=>ds.map(d=>[d.querySelector('dt').textContent,d.querySelector('dd').textContent])));
  assert.equal(rows['바우처'],title); assert.equal(rows['이름'],'가상방문'); assert.equal(rows['학번'],'21001');
  assert.match(rows['승인 일시'],/^\d{4}년 \d{1,2}월 \d{1,2}일 (오전|오후) \d{2}:\d{2}$/);
  assert.match(await page.locator('.voucher-scan-dialog .ops-voucher-done strong').innerText(),/사용 승인이 완료되었어요/);
  return async()=>{ await page.locator('[data-voucher-approved-ok]').click(); await page.waitForFunction(()=>!document.querySelector('.voucher-scan-dialog')); };
}


// ---- 미니게임 (1.37). ORBIT's functions are not part of the festival SQL, so orbit_* calls and the two
// public ORBIT tables are answered by a small synthetic market and a scripted blackjack opponent.
const NAMES=['창업특허연구소','아트 캔버스','심장박동','다이나믹스','방송부','모멘트','월드 스코프','네온','인벨릭스','레브','케미스트','패러다임','글빛누리','건축학부','배구사랑','인사이트','티치스트','리켐','머큐리','매커니즘'];
const t0=Date.now();
const market={eventId:'orbit-event',status:'open',eventStatus:'open',startsAt:new Date(t0-30*60000).toISOString(),endsAt:new Date(t0+90*60000).toISOString(),priceVersion:5,securityReady:true,configApproved:true,maxPriceAgeSeconds:600};
const stockRows=NAMES.map((name,i)=>({id:String(i+1),eventId:'orbit-event',boothId:name,name,price:3000+i*300,previousPrice:3000+i*300+(i%3-1)*60,priceVersion:5,updatedAt:new Date(t0-60000).toISOString(),tradingStatus:i===4?'halted':'open',recentNfcCount:0,purchaseRate:0,minPrice:1,maxPrice:100000}));
const wallet={money:100000,holdings:[],trades:[],receipts:new Map()};
const calls=[];
let bjGame=null, bjVersion=0, lobbyWaiting=2, rmMe='waiting', rmOpp='waiting';
const rmChoices=[];
const bjView=()=>bjGame&&JSON.parse(JSON.stringify(bjGame));
globalThis.gameStub=async(url,p)=>{
  const name=url.pathname.replace('/rest/v1/rpc/','');
  if(/^(orbit_|festival_blackjack_)/.test(name)) calls.push(name);
  if(name==='festival_blackjack_lobby') return {json:{waiting:lobbyWaiting}};
  if(name==='festival_blackjack_rematch') {
    rmChoices.push(p.p_choice);
    if(p.p_choice==='accept') {
      rmMe='accept';
      if(rmOpp==='accept') { wallet.money-=300; bjGame={id:randomUUID(),status:'playing',stake:300,version:++bjVersion,createdAt:new Date().toISOString(),myCards:[1,2],myTotal:5,myDone:false,opponentName:'가ㅇ방',opponentCards:[30,null],opponentTotal:null,opponentDone:false,turn:'opponent',turnDeadline:new Date(Date.now()+10000).toISOString(),result:null,payout:null}; return {json:{me:'accept',opponent:'accept',game:bjView()}}; }
    } else if(p.p_choice==='decline') rmMe='decline';
    else if(rmMe==='decline') rmMe='waiting';
    return {json:{me:rmMe,opponent:rmOpp,game:null}};
  }
  if(name==='orbit_stock_snapshot') return {json:{userId:'7',pointBalance:wallet.money,active:true,market,stocks:stockRows,holdings:wallet.holdings,trades:wallet.trades}};
  if(name==='orbit_trade_stock') {
    if(wallet.receipts.has(p.p_idempotency_key)) return {json:wallet.receipts.get(p.p_idempotency_key)};
    const s=stockRows.find(x=>x.id===String(p.p_stock_id)), total=s.price*p.p_quantity;
    if(p.p_side==='buy'&&total>wallet.money) return {status:400,json:{code:'P0001',message:'INSUFFICIENT_POINTS'}};
    let h=wallet.holdings.find(x=>x.stockId===s.id);
    if(!h) wallet.holdings.push(h={id:'h'+s.id,eventId:'orbit-event',userId:'7',stockId:s.id,quantity:0,averageBuyPrice:s.price,updatedAt:new Date().toISOString()});
    h.quantity+=p.p_side==='buy'?p.p_quantity:-p.p_quantity; wallet.money+=p.p_side==='buy'?-total:total;
    const receipt={id:randomUUID(),eventId:'orbit-event',userId:'7',stockId:s.id,side:p.p_side,quantity:p.p_quantity,unitPrice:s.price,totalPoints:total,priceVersion:5,pointBalanceAfter:wallet.money,holdingQuantityAfter:h.quantity,createdAt:new Date().toISOString()};
    wallet.receipts.set(p.p_idempotency_key,receipt); wallet.trades.unshift(receipt);
    return {json:receipt};
  }
  if(url.pathname==='/rest/v1/stock_price_history') {
    if(url.searchParams.get('select')==='price') return {json:[{price:stockRows[0].price-200}]};
    return {json:Array.from({length:7},(_,i)=>({created_at:new Date(t0-30*60000+i*5*60000).toISOString(),price:2800+i*40,version:i+1})).reverse()};
  }
  if(url.pathname==='/rest/v1/news') return {json:[{id:1,title:'창업특허연구소 시제품 공개',content:'오후 2시에 시제품을 공개해요.',stock_id:1,created_at:new Date(t0-600000).toISOString()}]};
  if(name==='orbit_blackjack_state') return {json:bjView()};
  if(name==='festival_blackjack_join') { wallet.money-=300; bjGame={id:randomUUID(),status:'waiting',stake:300,version:++bjVersion,createdAt:new Date().toISOString(),myCards:[],myTotal:0,myDone:false,opponentName:'가ㅇ방',opponentCards:[],opponentTotal:null,opponentDone:false,turn:null,turnDeadline:null,result:null,payout:null}; return {json:bjView()}; }
  if(name==='orbit_blackjack_cancel') { wallet.money+=300; Object.assign(bjGame,{status:'cancelled',version:++bjVersion}); return {json:bjView()}; }
  if(name==='festival_blackjack_action') {
    if(p.p_action==='hit') Object.assign(bjGame,{myCards:[...bjGame.myCards,2],myTotal:bjGame.myTotal+3,version:++bjVersion});
    else { wallet.money+=600; Object.assign(bjGame,{status:'finished',myDone:true,opponentDone:true,opponentCards:[12,6],opponentTotal:17,result:'win',payout:600,turn:null,turnDeadline:null,version:++bjVersion}); }
    return {json:bjView()};
  }
  return undefined;
};
const shot=async(page,name,width=390)=>{
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`overflow ${width}-${name}`);
  await page.screenshot({path:path.join(output,`${width}-${name}.png`),fullPage:true});
};
const navCheck=async(page,active)=>{
  const nav=await page.evaluate(()=>[...document.querySelectorAll('.bottom-nav .nav-btn')].map(b=>({route:b.dataset.route,label:b.textContent.trim(),current:b.getAttribute('aria-current'),w:Math.round(b.getBoundingClientRect().width)})));
  assert.deepEqual(nav.map(n=>n.label),['홈','부스 지도','스탬프','미니게임','MY']);
  assert.deepEqual(nav.filter(n=>n.current==='page').map(n=>n.route),[active]);
  return nav;
};
try {
  const {page,errors}=await pageFor(visitor);
  // Only the bottom navigation leads to the games.
  for(const r of ['home','map','stamps','vouchers','reviews','profile','notices','identity']) {
    await routeTo(page,r); await page.waitForTimeout(250);
    const outside=await page.evaluate(()=>[...document.querySelectorAll('[data-route^="games"]')].filter(b=>!b.closest('.bottom-nav')).length);
    assert.equal(outside,0,`games link outside the bottom bar on ${r}`);
    await navCheck(page,{vouchers:'stamps',reviews:'profile',identity:'profile',notices:'home'}[r]||r);
  }
  const widths=await navCheck(page,'profile');
  assert.ok(widths.every(n=>n.w>=74),'five equal tabs fit at 390px');
  await shot(page,'profile-nav');
  // Hub
  await page.locator('.bottom-nav [data-route="games"]').click();
  await page.waitForSelector('.game-list'); await page.waitForFunction(()=>/100,000P/.test(document.querySelector('.game-wallet').textContent));
  await navCheck(page,'games');
  assert.equal(await page.locator('.game-list button').count(),2);
  // 1.38: matching count beside 1대1 블랙잭, refreshed without a re-render
  await page.waitForFunction(()=>document.querySelector('[data-game-matching]:not([hidden])')?.textContent.trim()==='2명 매칭중');
  assert.equal(await page.locator('[data-game-matching]').evaluate(e=>e.classList.contains('success')),true);
  lobbyWaiting=0;
  await page.waitForFunction(()=>document.querySelector('[data-game-matching]')?.textContent.trim()==='0명 매칭중',null,{timeout:8000});
  assert.equal(await page.locator('[data-game-matching]').evaluate(e=>e.closest('[data-route]')?.dataset.route),'gamesBlackjack');
  lobbyWaiting=3;
  await shot(page,'games-hub');
  // Stock list, tabs, search (DOM filter keeps focus), sort
  await page.locator('[data-route="gamesStock"]').click();
  await page.waitForSelector('.game-stock-list li'); await page.waitForSelector('.game-news-list li');
  await navCheck(page,'games');
  assert.equal(await page.locator('.game-stock-list li').count(),20);
  await shot(page,'stock-list');
  const search=page.locator('[data-game-search]');
  await search.fill('인'); assert.equal(await page.evaluate(()=>document.activeElement?.matches('[data-game-search]')),true);
  assert.equal(await page.locator('.game-stock-list li:not([hidden])').count(),2);
  await search.fill('없는종목'); assert.equal(await page.locator('[data-game-no-match]').isVisible(),true);
  await search.fill('');
  await page.selectOption('[data-game-sort]','gain'); await page.waitForTimeout(150);
  await page.locator('[data-game-favorite="13"]').click();
  await page.locator('[data-game-tab="favorites"]').click();
  assert.equal(await page.locator('.game-stock-list li').count(),1);
  await page.locator('[data-game-tab="portfolio"]').click(); await page.waitForSelector('.festival-empty');
  await page.locator('[data-game-tab="market"]').click();
  // Detail + chart + trade
  await page.locator('[data-game-stock="1"]').click();
  await page.waitForSelector('.game-chart .line');
  await navCheck(page,'games');
  assert.match(await page.locator('.game-change').textContent(),/시작가 대비/);
  await shot(page,'stock-detail');
  await page.locator('[data-game-trade="buy"]').click();
  await page.waitForSelector('dialog.game-trade-dialog[open]');
  await page.locator('[data-trade-step="1"]').click(); await page.locator('[data-trade-step="1"]').click();
  assert.match(await page.locator('[data-trade-confirm]').textContent(),/매수 확정 · 9,000P/);
  await shot(page,'trade-dialog');
  await page.locator('[data-trade-confirm]').click();
  await page.waitForFunction(()=>!document.querySelector('dialog.game-trade-dialog'));
  await page.waitForFunction(()=>document.querySelector('[data-spot="game-trade"]')?.dataset.tone==='success');
  assert.match(await page.locator('[data-spot="game-trade"]').textContent(),/3주 매수가 3,000P에 확정됐어요/);
  assert.equal(wallet.money,91000);
  assert.match(await page.locator('.game-holding').textContent(),/3주/);
  assert.equal(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('pangyo-games-pending-trade')).length),0,'settled trade leaves no pending key');
  await shot(page,'trade-done');
  // Halted stock cannot be traded
  await page.evaluate(()=>{state.gameStockId='5';navigateTo('gamesStockDetail');});
  await page.waitForSelector('.game-quote');
  assert.equal(await page.locator('[data-game-trade="buy"]').isDisabled(),true);
  assert.match(await page.locator('.game-quote-status').textContent(),/거래 중지/);
  // Retry of an unresolved trade reuses its key and is answered once
  await page.evaluate(()=>{state.route='gamesStock';render();});
  await page.locator('[data-game-tab="history"]').click(); await page.waitForSelector('.game-trade-list li');
  await page.locator('[data-game-retry]').click();
  await page.waitForFunction(()=>/확인할 이전 거래가 없어요/.test(document.querySelector('[data-spot="game-retry"]')?.textContent||''));
  await shot(page,'stock-history');
  // Blackjack: lobby, waiting, table, reveal, result
  await page.evaluate(()=>navigateTo('gamesBlackjack'));
  await page.waitForSelector('.game-rules'); await navCheck(page,'games');
  // 1.39: the lobby shows the matching count above "300P 걸고 상대 찾기" and keeps it fresh
  await page.waitForFunction(()=>document.querySelector('.game-blackjack [data-game-matching]:not([hidden])')?.textContent.trim()==='3명 매칭중');
  assert.ok(await page.evaluate(()=>document.querySelector('[data-game-matching]').compareDocumentPosition(document.querySelector('[data-bj="join"]'))&Node.DOCUMENT_POSITION_FOLLOWING),'count sits above the button');
  lobbyWaiting=1;
  await page.waitForFunction(()=>document.querySelector('[data-game-matching]')?.textContent.trim()==='1명 매칭중',null,{timeout:8000});
  await shot(page,'bj-lobby');
  await page.locator('[data-bj="join"]').click();
  await page.waitForSelector('.game-bj-waiting');
  await shot(page,'bj-waiting');
  Object.assign(bjGame,{status:'playing',myCards:[0,9],myTotal:21-10,opponentCards:[25,null],turn:'me',turnDeadline:new Date(Date.now()+10000).toISOString(),version:++bjVersion});
  bjGame.myCards=[9,8]; bjGame.myTotal=19;
  await page.waitForSelector('.game-bj-table', {timeout:5000});
  await page.waitForSelector('[data-bj-timer]');
  assert.equal(await page.locator('[data-bj="hit"]').isEnabled(),true);
  await shot(page,'bj-table');
  // 1.40: going bust does not stand; the player can keep hitting until they stand
  await page.locator('[data-bj="hit"]').click();
  await page.waitForFunction(()=>/22/.test(document.querySelectorAll('.game-bj-total')[0]?.textContent||'') && /버스트/.test(document.querySelector('.game-bj-badge')?.textContent||''));
  assert.match(await page.locator('.game-bj-turn').textContent(),/버스트예요. 카드를 더 받거나 스탠드할 수 있어요/);
  assert.equal(await page.locator('[data-bj="hit"]').isEnabled(),true,'hit stays available after a bust');
  assert.equal(await page.locator('[data-bj="stand"]').isEnabled(),true);
  await shot(page,'bj-bust-keep-hitting');
  await page.locator('[data-bj="hit"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('.game-bj-seat')[1]?.querySelectorAll('.game-card').length===4);
  assert.equal(await page.locator('[data-bj="hit"]').isEnabled(),true);
  // 1.39: during the final reveal only the card just turned over animates (at most one .flip at a time)
  await page.evaluate(()=>{ window.__flips=[]; new MutationObserver(()=>window.__flips.push(document.querySelectorAll('.game-card.flip').length)).observe(document.body,{childList:true,subtree:true}); });
  await page.locator('[data-bj="stand"]').click();
  await page.waitForSelector('.game-bj-outcome.win',{timeout:8000});
  const flips=await page.evaluate(()=>window.__flips);
  assert.ok(Math.max(...flips)===1,`one flipping card at a time: ${JSON.stringify(flips)}`);
  await shot(page,'bj-outcome');
  await page.locator('[data-bj-ok]').click();
  await page.waitForSelector('.game-bj-result.win');
  // 1.38: the last opponent's rematch answer above "한 판 더 하기"
  await page.waitForFunction(()=>document.querySelector('[data-bj-rematch]')?.textContent.trim()==='상대 : 대기중');
  assert.match(await page.locator('[data-bj="rematch"]').textContent(),/한 판 더 하기/);
  assert.ok(await page.evaluate(()=>document.querySelector('.game-bj-rematch').compareDocumentPosition(document.querySelector('[data-bj="rematch"]'))&Node.DOCUMENT_POSITION_FOLLOWING),'status sits above the button');
  assert.equal(await page.locator('[data-game-matching]').count(),0,'same-opponent rematch hides the random matching count');
  await shot(page,'bj-result');
  rmOpp='decline';
  await page.waitForFunction(()=>document.querySelector('[data-bj-rematch]')?.textContent.trim()==='상대 : 거부');
  assert.match(await page.locator('[data-bj="join"]').textContent(),/한 판 더 하기/,'declined opponent: the button finds a new random opponent');
  assert.equal(await page.locator('.game-blackjack [data-game-matching]').count(),1,'random matching shows the count');
  await shot(page,'bj-rematch-declined');
  rmOpp='waiting';
  await page.waitForSelector('[data-bj="rematch"]');
  await page.locator('[data-bj="rematch"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-bj="rematch"]')?.disabled===true && /같은 상대와 바로 시작/.test(document.body.textContent));
  rmOpp='accept';
  await page.waitForFunction(()=>document.querySelector('[data-bj-rematch]')?.textContent.trim()==='상대 : 수락');
  await shot(page,'bj-rematch-accepted');
  // Leaving the blackjack screen tells the opponent "거부"
  await page.evaluate(()=>navigateTo('games')); await page.waitForSelector('.game-list');
  await page.waitForFunction(()=>document.querySelector('[data-game-matching]')?.textContent.trim()==='1명 매칭중');
  assert.equal(rmChoices.at(-1),'decline');
  // Coming back and both accepting starts a new game with the same opponent
  rmMe='decline';
  await page.evaluate(()=>navigateTo('gamesBlackjack'));
  await page.waitForFunction(()=>document.querySelector('[data-bj-rematch]')?.textContent.trim()==='상대 : 수락' && document.querySelector('[data-bj="rematch"]')?.disabled===false);
  const before=wallet.money;
  await page.locator('[data-bj="rematch"]').click();
  await page.waitForSelector('.game-bj-table');
  assert.equal(wallet.money,before-300);
  assert.match(await page.locator('.game-bj-turn').textContent(),/상대가 고르는 중/);
  await shot(page,'bj-rematch-table');
  // Narrow and wide screens
  for(const width of [320,1024]) {
    const narrow=await pageFor(visitor,width);
    for(const r of ['games','gamesStock','gamesBlackjack','home']) { await routeTo(narrow.page,r); await narrow.page.waitForTimeout(600); await shot(narrow.page,r,width); }
    await narrow.page.evaluate(()=>{state.gameStockId='1';state.route='gamesStockDetail';render();}); await narrow.page.waitForSelector('.game-chart .line'); await shot(narrow.page,'gamesStockDetail',width);
    await narrow.context.close();
  }
  // Demo (local) mode explains instead of calling the server
  assert.ok(calls.includes('orbit_trade_stock') && calls.includes('festival_blackjack_join') && calls.includes('festival_blackjack_action') && !calls.includes('orbit_blackjack_join') && !calls.includes('orbit_blackjack_action') && calls.includes('festival_blackjack_lobby') && calls.includes('festival_blackjack_rematch'));
  console.log(JSON.stringify({calls:[...new Set(calls)],errors:pages.map(p=>p.errors).flat(),artifacts:path.relative(root,output)}));
  assert.deepEqual(pages.map(p=>p.errors).flat(),[]);
} finally { await browser.close(); }
