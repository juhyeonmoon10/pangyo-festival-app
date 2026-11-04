// 미니게임 (1.37, 1.38 matching count and rematch) browser check. Harness copied from voucher-manager-browser.mjs; orbit_* calls are stubbed.
// Real browser and festival operations SQL in local PGlite. ORBIT's orbit_* functions and the stock_price_history
// and news tables are answered by a synthetic market and a scripted blackjack opponent (gameStub).
// Covers: 5-tab bottom navigation, games reachable only from it, 가상주식 list/search/visited tab/detail/trade/retry, 블랙잭 flow.
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
  page.on('pageerror',e=>errors.push(e.message)); page.on('dialog',d=>{ dialogs.push(d.message()); return dialogAnswers.length&&!dialogAnswers.shift()?d.dismiss():d.accept(); });
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
const market={eventId:'orbit-event',status:'open',eventStatus:'open',startsAt:new Date(t0-30*60000).toISOString(),endsAt:new Date(t0+90*60000).toISOString(),priceVersion:5,securityReady:true,configApproved:true,maxPriceAgeSeconds:600,
  decayBps:30,visitStep:10,visitBonusBps:500};
// 1.51: visitors per club, and whether this student visited it (심장박동, id 3, not visited).
const stockRows=NAMES.map((name,i)=>({id:String(i+1),eventId:'orbit-event',boothId:name,name,price:3000+i*300,previousPrice:3000+i*300+(i%3-1)*60,priceVersion:5,updatedAt:new Date(t0-60000).toISOString(),tradingStatus:i===4?'halted':'open',recentNfcCount:0,purchaseRate:0,minPrice:1,maxPrice:100000,
  visitors:i===0?13:i,visited:i!==2}));
const wallet={money:100000,holdings:[],trades:[],receipts:new Map()};
const calls=[];
let bjGame=null, bjVersion=0, lobbyWaiting=2, rmMe='waiting', rmOpp='waiting', rmStart=false, bjRules={maxDraws:null}, bjActions=[], forfeits=[];
// 1.49 simultaneous rounds, answered in memory: bjOppChoice is the opponent's hidden choice for this round.
let bjOppChoice=null;
// The server's reveal: both choices at once, one card per hit, a stand stops that player, both stopped settles.
function resolveRound() {
  const me=bjGame.myDone?null:bjGame.myChoice, them=bjGame.opponentDone?null:bjOppChoice;
  if(me==='hit') { bjGame.myCards=[...bjGame.myCards,2]; bjGame.myTotal+=3; }
  if(them==='hit') bjGame.opponentCards=[...bjGame.opponentCards,null];
  Object.assign(bjGame,{myDone:bjGame.myDone||me==='stand',opponentDone:bjGame.opponentDone||them==='stand',
    lastRound:{round:bjGame.round,me,opponent:them},round:bjGame.round+1,myChoice:null,opponentReady:false,version:++bjVersion});
  bjOppChoice=null;
  if(bjGame.myDone&&bjGame.opponentDone) { wallet.money+=600; Object.assign(bjGame,{status:'finished',opponentCards:[12,6],opponentTotal:17,result:'win',payout:600,roundDeadline:null}); }
}
// The opponent chooses: revealed now if I have chosen (or stopped), otherwise only "선택 완료" shows.
function opponentChooses(choice) {
  bjOppChoice=choice;
  if(bjGame.myChoice||bjGame.myDone) resolveRound(); else Object.assign(bjGame,{opponentReady:true});
}
// A match from the festival queue: a new game id, both stakes, round 1.
function startTable(extra={}) {
  wallet.money-=300;
  bjGame={id:randomUUID(),status:'playing',stake:300,version:++bjVersion,createdAt:new Date().toISOString(),myCards:[9,8],myTotal:19,myDone:false,
    opponentName:'21001가상방',opponentCards:[25,null],opponentTotal:null,opponentDone:false,turn:null,turnDeadline:null,result:null,payout:null,
    round:1,roundDeadline:new Date(Date.now()+60000).toISOString(),myChoice:null,opponentReady:false,lastRound:null,...extra};
  bjOppChoice=null;
}
// Browser dialogs: accepted unless dialogAnswers holds false for the next one (1.42 leaving a game asks first).
var dialogs=[], dialogAnswers=[];
// 관리 마법사 → 미니게임 관리 (1.41): ORBIT's stock admin functions and festival_blackjack_admin, answered in memory.
const adminCalls=[], auditLogs=[], adminEvents=[], adminNews=[]; let failNextMutate=false;
const adminDashboard=()=>({market:{...market,updatedAt:new Date(t0).toISOString()},
  instruments:stockRows.map(s=>({stockId:s.id,stockName:s.name,status:s.tradingStatus,price:s.price,eventId:'orbit-event'})),events:adminEvents,news:adminNews});
const bjAdmin={settings:{maxDraws:null,updatedAt:null,updatedBy:null},waiting:1,playing:2,finishedToday:5,stakedToday:3000,
  recent:[{id:randomUUID(),status:'playing',stake:300,result:null,playerA:'10101홍길동',playerB:'10102김철수',cardsA:3,cardsB:2,totalA:null,totalB:null,createdAt:new Date(t0).toISOString(),finishedAt:null},
    {id:randomUUID(),status:'finished',stake:300,result:'a',playerA:'10103이영희',playerB:'10104박민수',cardsA:4,cardsB:3,totalA:20,totalB:23,rounds:7,createdAt:new Date(t0-60000).toISOString(),finishedAt:new Date(t0-30000).toISOString()},
    {id:randomUUID(),status:'finished',stake:300,result:'b',forfeit:'a',playerA:'10105최도윤',playerB:'10106정하늘',cardsA:3,cardsB:2,totalA:15,totalB:12,createdAt:new Date(t0-120000).toISOString(),finishedAt:new Date(t0-100000).toISOString()}]};
const startRematch=()=>{ rmStart=false; startTable({myCards:[1,2],myTotal:5,opponentCards:[30,null]}); return {json:{me:'accept',opponent:'accept',game:bjView()}}; };
const rmChoices=[];
const bjView=()=>bjGame&&JSON.parse(JSON.stringify(bjGame));
globalThis.gameStub=async(url,p)=>{
  const name=url.pathname.replace('/rest/v1/rpc/','');
  if(/^(orbit_|festival_blackjack_)/.test(name)) calls.push(name);
  if(name==='festival_blackjack_lobby') return {json:{waiting:lobbyWaiting,matchSeconds:60,...bjRules}};
  if(name==='orbit_admin_stock_dashboard') { adminCalls.push([name]); return {json:adminDashboard()}; }
  if(name==='orbit_admin_stock_audit_log') { adminCalls.push([name]); return {json:auditLogs}; }
  if(name==='orbit_admin_stock_mutate') {
    adminCalls.push([name,p]);
    if(failNextMutate) { failNextMutate=false; return {status:504,json:{message:'upstream timeout'}}; }
    if(auditLogs.some(l=>l.requestId===p.p_idempotency_key)) return {json:{ok:true,reason:null,replayed:true}};
    const q=p.p_payload;
    if(p.p_action==='MARKET_SET') market.status=q.status;
    if(p.p_action==='INSTRUMENT_SET') stockRows.find(s=>s.id===q.stockId).tradingStatus=q.status;
    if(p.p_action==='CREATE_EVENT') adminEvents.unshift({id:randomUUID(),...q,stockName:q.stockId?stockRows.find(s=>s.id===q.stockId).name:null,createdAt:new Date().toISOString()});
    if(p.p_action==='CREATE_NEWS') adminNews.unshift({id:String(adminNews.length+1),...q,stockName:null,createdAt:new Date().toISOString()});
    auditLogs.unshift({id:randomUUID(),actorId:'1',action:p.p_action,target:'MARKET',requestId:p.p_idempotency_key,previousState:{},newState:{},result:'SUCCESS',failureReason:null,createdAt:new Date().toISOString()});
    return {json:{ok:true,reason:null,replayed:false}};
  }
  if(name==='orbit_admin_publish_stock_price') { adminCalls.push([name,p]); const s=stockRows.find(x=>x.id===String(p.p_stock_id)); s.price=p.p_price; return {json:{stockId:s.id,price:s.price,priceVersion:6}}; }
  if(name==='festival_blackjack_admin') {
    adminCalls.push([name,p]);
    if(p.p_action==='save') bjAdmin.settings={...p.p_payload,updatedAt:new Date().toISOString(),updatedBy:'격리 운영자'};
    return {json:bjAdmin};
  }
  if(name==='festival_blackjack_rematch') {
    rmChoices.push(p.p_choice);
    if(p.p_choice==='accept') {
      rmMe='accept';
      if(rmOpp==='accept') return startRematch();
    } else if(p.p_choice==='decline') rmMe='decline';
    else if(rmStart && rmMe==='accept') return startRematch(); // the opponent's accept started the game
    else if(rmMe==='decline') rmMe='waiting';
    return {json:{me:rmMe,opponent:rmOpp,game:null}};
  }
  if(name==='orbit_stock_snapshot') return {json:{userId:'7',pointBalance:wallet.money,active:true,market,stocks:stockRows,holdings:wallet.holdings,trades:wallet.trades}};
  if(name==='orbit_trade_stock') {
    if(wallet.receipts.has(p.p_idempotency_key)) return {json:wallet.receipts.get(p.p_idempotency_key)};
    const s=stockRows.find(x=>x.id===String(p.p_stock_id)), total=s.price*p.p_quantity;
    if(!s.visited) return {status:400,json:{code:'P0001',message:'STOCK_NOT_VISITED'}};
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
  if(name==='festival_blackjack_state') return {json:bjView()};
  // 1.49: the festival queue takes no stake while waiting; the stake goes at the match (startTable).
  if(name==='festival_blackjack_join') { bjGame={id:randomUUID(),status:'waiting',queued:true,stake:300,version:0,createdAt:new Date().toISOString(),myCards:[],myTotal:0,myDone:false,opponentName:null,opponentCards:[],opponentTotal:null,opponentDone:false,turn:null,turnDeadline:null,result:null,payout:null}; return {json:bjView()}; }
  if(name==='festival_blackjack_cancel') { Object.assign(bjGame,{status:'cancelled',ended:'cancelled'}); return {json:bjView()}; }
  if(name==='festival_blackjack_forfeit') { forfeits.push(p.p_game_id); Object.assign(bjGame,{status:'finished',myDone:true,opponentDone:true,opponentCards:[12,6],opponentTotal:17,result:'lose',payout:0,forfeit:'me',roundDeadline:null,version:++bjVersion}); return {json:bjView()}; }
  if(name==='festival_blackjack_action') {
    bjActions.push(p.p_action);
    if('p_count' in p) return {status:400,json:{code:'P0001',message:'INVALID_ACTION'}};
    // A choice is final for the round; it is revealed once the opponent has chosen too (or has stopped).
    if(p.p_version!==bjGame.version || bjGame.myChoice) return {json:bjView()};
    bjGame.myChoice=p.p_action;
    if(bjOppChoice||bjGame.opponentDone) resolveRound();
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
  // 1.51: the rule line, visitors per club, and "방문 전" on a club not visited
  assert.match(await page.locator('.game-rule-note').textContent(),/방문한 동아리만 사고팔 수 있어요[.] 가격은 1분마다 0[.]3%씩 내려가고, 방문 학생이 10명 늘 때마다 5% 올라요/);
  assert.match(await page.locator('[data-game-stock="1"]').textContent(),/방문 13명/);
  assert.match(await page.locator('[data-game-stock="3"]').textContent(),/방문 2명 · 방문 전/);
  assert.doesNotMatch(await page.locator('[data-game-stock="2"]').textContent(),/방문 전/);
  await shot(page,'stock-list');
  const search=page.locator('[data-game-search]');
  await search.fill('인'); assert.equal(await page.evaluate(()=>document.activeElement?.matches('[data-game-search]')),true);
  assert.equal(await page.locator('.game-stock-list li:not([hidden])').count(),2);
  await search.fill('없는종목'); assert.equal(await page.locator('[data-game-no-match]').isVisible(),true);
  await search.fill('');
  await page.selectOption('[data-game-sort]','gain'); await page.waitForTimeout(150);
  // 1.51: tabs are 종목 · 방문한 동아리 · 보유 (관심 and 거래 내역 removed, no star buttons)
  assert.deepEqual(await page.locator('[data-game-tab]').allTextContents().then(t=>t.map(x=>x.trim().replace(/\s+/g,' '))),['종목 20','방문한 동아리 19','보유 0']);
  assert.equal(await page.locator('.game-favorite').count(),0);
  await page.locator('[data-game-tab="visited"]').click();
  assert.equal(await page.locator('.game-stock-list li').count(),19);
  assert.equal(await page.locator('[data-game-stock="3"]').count(),0,'the club not visited is not in the tab');
  await shot(page,'stock-visited-tab');
  for(const s of stockRows) s.visited=false;
  await page.locator('[data-game-refresh]').click();
  await page.waitForFunction(()=>/아직 방문한 동아리가 없어요/.test(document.querySelector('.festival-empty')?.textContent||''));
  assert.equal(await page.locator('.festival-empty [data-route="map"]').count(),1);
  await shot(page,'stock-visited-empty');
  stockRows.forEach((s,i)=>{ s.visited=i!==2; });
  await page.locator('[data-game-refresh]').click();
  await page.waitForFunction(()=>document.querySelectorAll('.game-stock-list li').length===19);
  await page.locator('[data-game-tab="portfolio"]').click(); await page.waitForSelector('.festival-empty');
  await page.locator('[data-game-tab="market"]').click();
  // Detail + chart + trade
  await page.locator('[data-game-stock="1"]').click();
  await page.waitForSelector('.game-chart .line');
  await navCheck(page,'games');
  assert.match(await page.locator('.game-change').textContent(),/시작가 대비/);
  // 1.51: 13 visitors → 7 more for the next 5 %
  assert.match(await page.locator('.game-holding').textContent(),/방문 학생 7명 더 오면 5% 상승\s*13명/);
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
  // 1.51: a club not visited shows its price but cannot be bought or sold
  await page.evaluate(()=>{state.gameStockId='3';navigateTo('gamesStockDetail');});
  await page.waitForFunction(()=>/심장박동/.test(document.querySelector('.game-quote')?.textContent||''));
  assert.match(await page.locator('.game-quote-status').textContent(),/방문 전/);
  assert.equal(await page.locator('[data-game-trade="buy"]').isDisabled(),true);
  assert.equal(await page.locator('[data-game-trade="sell"]').isDisabled(),true);
  assert.match(await page.locator('.game-stock-detail').textContent(),/이 동아리 부스를 방문하면 사고팔 수 있어요/);
  await shot(page,'stock-not-visited');
  // Retry of an unresolved trade reuses its key and is answered once
  await page.evaluate(()=>{state.route='gamesStock';render();});
  await page.waitForSelector('[data-game-retry]');
  await page.locator('[data-game-retry]').click();
  await page.waitForFunction(()=>/확인할 이전 거래가 없어요/.test(document.querySelector('[data-spot="game-retry"]')?.textContent||''));
  await shot(page,'stock-history');
  // Blackjack: lobby, waiting, table, reveal, result
  bjRules={maxDraws:2}; // the per-game card limit from 관리 마법사 (1.49: no per-turn limit)
  await page.evaluate(()=>navigateTo('gamesBlackjack'));
  await page.waitForSelector('.game-rules'); await navCheck(page,'games');
  await page.waitForFunction(()=>/처음 2장 외에 최대 2장까지/.test(document.querySelector('.game-rules').textContent));
  assert.match(await page.locator('.game-rules').textContent(),/게임 도중 화면을 나가면 몰수패/);
  // 1.49: simultaneous rounds; the stake is taken at the match
  assert.match(await page.locator('.game-rules').textContent(),/매 라운드 두 사람이 동시에 히트/);
  assert.match(await page.locator('.game-rules').textContent(),/한 번 고르면 바꿀 수 없어요/);
  assert.match(await page.locator('.game-rules').textContent(),/판돈 300P는 짝이 지어질 때 빠져요[.] 1분 안에 상대를 찾지 못하면 매칭이 취소돼요/);
  assert.match(await page.locator('.game-rules').textContent(),/같은 상대에게 다시 하자고/);
  assert.doesNotMatch(await page.locator('.game-rules').textContent(),/차례/);
  assert.doesNotMatch(await page.locator('.festival-games').textContent(),/3분/);
  // 1.39: the lobby shows the matching count above "300P 걸고 상대 찾기" and keeps it fresh
  await page.waitForFunction(()=>document.querySelector('.game-blackjack [data-game-matching]:not([hidden])')?.textContent.trim()==='3명 매칭중');
  assert.ok(await page.evaluate(()=>document.querySelector('[data-game-matching]').compareDocumentPosition(document.querySelector('[data-bj="join"]'))&Node.DOCUMENT_POSITION_FOLLOWING),'count sits above the button');
  lobbyWaiting=1;
  await page.waitForFunction(()=>document.querySelector('[data-game-matching]')?.textContent.trim()==='1명 매칭중',null,{timeout:8000});
  await shot(page,'bj-lobby');
  const waitMoney=wallet.money;
  await page.locator('[data-bj="join"]').click();
  await page.waitForSelector('.game-bj-waiting');
  assert.doesNotMatch(await page.locator('.game-bj-waiting').textContent(),/분 안에|돌려받/);
  assert.match(await page.locator('.game-bj-waiting').textContent(),/기다린 시간 0:0[0-9]/);
  assert.match(await page.locator('[data-bj="cancel"]').textContent(),/대기 취소/);
  assert.equal(wallet.money,waitMoney,'waiting takes no stake (1.49)');
  await shot(page,'bj-waiting');
  // Cancelling says so; a matching that timed out on the server says it was not matched. Nothing to give back.
  await page.locator('[data-bj="cancel"]').click();
  await page.waitForFunction(()=>/대기를 취소했어요[.]/.test(document.querySelector('.festival-games').textContent));
  assert.doesNotMatch(await page.locator('.festival-games').textContent(),/돌려받았어요/);
  await page.locator('[data-bj="join"]').click();
  await page.waitForSelector('.game-bj-waiting');
  Object.assign(bjGame,{status:'cancelled',ended:'expired'});
  await page.waitForFunction(()=>/1분 안에 상대를 찾지 못해 매칭이 취소됐어요[.]/.test(document.querySelector('.festival-games').textContent),null,{timeout:5000});
  assert.doesNotMatch(await page.locator('.festival-games').textContent(),/돌려받았어요/);
  await shot(page,'bj-match-timeout');
  await page.locator('[data-bj="join"]').click();
  await page.waitForSelector('.game-bj-waiting');
  startTable();
  assert.equal(wallet.money,waitMoney-300,'the stake goes at the match');
  await page.waitForSelector('.game-bj-table', {timeout:5000});
  await page.waitForSelector('[data-bj-timer]');
  assert.equal(await page.locator('[data-bj="hit"]').isEnabled(),true);
  // 1.41: the opponent's whole name. 1.49: round 1, both choose; only the per-game limit is shown
  assert.equal(await page.locator('.game-bj-seat-head strong').first().textContent(),'21001가상방');
  assert.equal((await page.locator('.game-bj-round').textContent()).trim(),'라운드 1');
  assert.match(await page.locator('.game-bj-turn').textContent(),/히트나 스탠드를 골라 주세요[.] 둘 다 고르면 함께 공개돼요/);
  assert.match(await page.locator('.game-bj-ready').textContent(),/고르는 중/);
  assert.match(await page.locator('.game-bj-draw').textContent(),/이번 판에 더 받을 수 있는 카드 2장/);
  assert.doesNotMatch(await page.locator('.game-bj-table').textContent(),/차례/);
  assert.deepEqual(await page.locator('.game-trade-actions button').allTextContents().then(t=>t.map(x=>x.trim())),['히트','스탠드']);
  await shot(page,'bj-table');
  // My choice waits for the opponent and cannot be changed
  await page.locator('[data-bj="hit"]').click();
  await page.waitForFunction(()=>/선택 완료 · 상대를 기다려요/.test(document.querySelector('.game-bj-turn')?.textContent||''));
  assert.equal(await page.locator('[data-bj="hit"]').isEnabled(),false);
  assert.equal(await page.locator('[data-bj="stand"]').isEnabled(),false);
  assert.equal(await page.locator('[data-bj="hit"].is-chosen').count(),1);
  assert.equal(await page.locator('.game-bj-seat').nth(1).locator('.game-card').count(),2,'no card before the reveal');
  await shot(page,'bj-chosen');
  // The opponent chooses: both choices are revealed together. 1.40: going bust does not stand.
  opponentChooses('hit');
  await page.waitForFunction(()=>document.querySelectorAll('.game-bj-badge').length===2,null,{timeout:5000});
  assert.deepEqual(await page.locator('.game-bj-badge').allTextContents(),['히트!','버스트!']);
  assert.match(await page.locator('.game-bj-total').first().textContent(),/22/);
  assert.equal(await page.locator('.game-bj-seat').first().locator('.game-card').count(),3);
  assert.equal((await page.locator('.game-bj-round').textContent()).trim(),'라운드 2');
  assert.match(await page.locator('.game-bj-turn').textContent(),/버스트예요[.] 히트나 스탠드를 골라 주세요/);
  assert.equal(await page.locator('[data-bj="hit"]').isEnabled(),true,'hit stays available after a bust');
  assert.match(await page.locator('.festival-games .sr-only[aria-live]').textContent(),/버스트! 22점[.] 상대가 히트했어요/);
  await shot(page,'bj-reveal');
  // The opponent is ready first: "선택 완료" shows, never what they chose
  opponentChooses('stand');
  await page.waitForFunction(()=>document.querySelector('.game-bj-ready')?.textContent.trim()==='선택 완료',null,{timeout:5000});
  assert.equal(await page.locator('.game-bj-ready.is-ready').count(),1);
  await shot(page,'bj-opponent-ready');
  // My choice reveals the round at once; the per-game limit is then used up
  await page.locator('[data-bj="hit"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('.game-bj-seat')[1]?.querySelectorAll('.game-card').length===4);
  assert.match(await page.locator('.game-bj-ready').textContent(),/멈춤/);
  assert.match(await page.locator('.game-bj-badge').first().textContent(),/스탠드/);
  assert.equal(await page.locator('[data-bj="hit"]').isEnabled(),false,'no more cards after the per-game limit');
  assert.match(await page.locator('.game-bj-turn').textContent(),/더 받을 수 있는 카드가 없어요/);
  assert.match(await page.locator('.game-bj-draw').textContent(),/이번 판에 더 받을 수 있는 카드 0장/);
  assert.deepEqual(bjActions,['hit','hit']);
  await shot(page,'bj-card-limit');
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
  // The opponent accepts second: the new game with the same opponent starts on this screen
  const before=wallet.money;
  rmStart=true;
  await page.waitForSelector('.game-bj-table');
  assert.equal(wallet.money,before-300);
  assert.equal((await page.locator('.game-bj-round').textContent()).trim(),'라운드 1');
  assert.equal(await page.locator('.game-bj-badge').count(),0,'a rematch starts without the last badges');
  await shot(page,'bj-rematch-table');
  // 1.41: after the game ends, leaving and coming back shows the first screen, not the result
  rmMe='waiting'; rmOpp='waiting';
  Object.assign(bjGame,{opponentDone:true,version:++bjVersion});
  await page.waitForFunction(()=>/멈춤/.test(document.querySelector('.game-bj-ready')?.textContent||''));
  await page.locator('[data-bj="stand"]').click();
  await page.waitForSelector('[data-bj-ok]',{timeout:10000});
  await page.locator('[data-bj-ok]').click();
  await page.waitForFunction(()=>document.querySelector('[data-bj-rematch]')?.textContent.trim()==='상대 : 대기중');
  // Leaving the blackjack screen tells the opponent "거부"
  await page.evaluate(()=>navigateTo('games')); await page.waitForSelector('.game-list');
  await page.waitForFunction(()=>document.querySelector('[data-game-matching]')?.textContent.trim()==='1명 매칭중');
  assert.equal(rmChoices.at(-1),'decline');
  await page.evaluate(()=>navigateTo('gamesBlackjack'));
  await page.waitForSelector('.game-rules');
  await page.waitForTimeout(1500);
  assert.equal(await page.locator('.game-bj-result').count(),0,'the last result is not shown again');
  assert.equal(await page.locator('[data-bj-rematch]').count(),0);
  assert.match(await page.locator('[data-bj="join"]').textContent(),/300P 걸고 상대 찾기/);
  assert.equal(await page.locator('.game-blackjack [data-game-matching]').count(),1);
  await shot(page,'bj-return-first-screen');
  // 1.42: a new game shows nothing from the last one (it ended with a "스탠드" badge)
  await page.locator('[data-bj="join"]').click();
  await page.waitForSelector('.game-bj-waiting');
  startTable();
  await page.waitForSelector('.game-bj-table',{timeout:5000});
  assert.equal(await page.locator('.game-bj-badge').count(),0,'no badge from the last game');
  assert.equal(await page.locator('.festival-games .sr-only[aria-live]').textContent(),'');
  // 1.42: leaving during a game asks first; staying keeps the table (header back, browser back, bottom tab)
  dialogAnswers.push(false);
  await page.locator('.web-header [data-history-back]').click();
  await page.waitForTimeout(400);
  assert.match(dialogs.at(-1),/몰수패/);
  assert.equal(await page.evaluate(()=>state.route),'gamesBlackjack');
  assert.equal(await page.locator('.game-bj-table').count(),1);
  dialogAnswers.push(false);
  await page.evaluate(()=>history.back());
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(()=>state.route),'gamesBlackjack');
  assert.equal(await page.evaluate(()=>history.state?.route),'gamesBlackjack','the address is put back');
  dialogAnswers.push(false);
  await page.locator('.bottom-nav [data-route="home"]').click();
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(()=>state.route),'gamesBlackjack');
  assert.equal(forfeits.length,0,'staying does not forfeit');
  // Leaving with the browser back button forfeits
  const dialogCount=dialogs.length;
  await page.evaluate(()=>history.back());
  await page.waitForFunction(()=>state.route!=='gamesBlackjack');
  await page.waitForTimeout(400);
  assert.equal(dialogs.length,dialogCount+1);
  assert.deepEqual(forfeits,[bjGame.id]);
  await page.evaluate(()=>navigateTo('gamesBlackjack'));
  await page.waitForSelector('.game-rules');
  await page.waitForTimeout(1200);
  assert.equal(await page.locator('.game-bj-result').count(),0,'the forfeited game is not shown again');
  assert.equal(await page.locator('.game-bj-table').count(),0);
  // The other player sees why they won
  await page.locator('[data-bj="join"]').click();
  await page.waitForSelector('.game-bj-waiting');
  startTable();
  await page.waitForSelector('.game-bj-table',{timeout:5000});
  wallet.money+=600;
  Object.assign(bjGame,{status:'finished',myDone:true,opponentDone:true,opponentCards:[25,4],opponentTotal:18,result:'win',payout:600,forfeit:'opponent',roundDeadline:null,version:++bjVersion});
  await page.waitForSelector('.game-bj-outcome.win',{timeout:10000});
  assert.match(await page.locator('.game-bj-outcome').textContent(),/상대가 게임을 나가 몰수패했어요/);
  await shot(page,'bj-forfeit-win');
  await page.locator('[data-bj-ok]').click();
  await page.waitForSelector('.game-bj-result.win');
  assert.match(await page.locator('.game-bj-result').textContent(),/상대가 게임을 나가 몰수패했어요/);
  await page.evaluate(()=>navigateTo('games')); await page.waitForSelector('.game-list');
  // 1.41 관리 마법사 → 미니게임 관리
  const ops=await pageFor(admin);
  await routeTo(ops.page,'admin'); await openOperatorTool(ops.page,'minigames');
  await ops.page.waitForSelector('.games-admin-tiles');
  assert.match(await ops.page.locator('.games-admin-tiles').textContent(),/개장/);
  await shot(ops.page,'admin-minigames-stock');
  // halt one stock (the confirm dialog is accepted by the harness)
  await ops.page.locator('[data-instrument="1"]').click();
  await ops.page.waitForFunction(()=>/거래를 정지했어요/.test(document.querySelector('[data-games-admin]').textContent));
  assert.deepEqual(adminCalls.filter(c=>c[0]==='orbit_admin_stock_mutate').map(c=>[c[1].p_action,c[1].p_payload]),[['INSTRUMENT_SET',{stockId:'1',status:'halted'}]]);
  assert.equal(stockRows[0].tradingStatus,'halted');
  // publish a new price
  await ops.page.locator('[data-price="2"]').evaluate(f=>{ f.closest('details').open=true; });
  await ops.page.locator('[data-price="2"] input[name="price"]').fill('4321');
  await ops.page.locator('[data-price="2"] button[type="submit"]').click();
  await ops.page.waitForFunction(()=>/4,321P로 발행했어요/.test(document.querySelector('[data-games-admin]').textContent));
  const published=adminCalls.find(c=>c[0]==='orbit_admin_publish_stock_price')[1];
  assert.equal(published.p_stock_id,2); assert.equal(published.p_price,4321); assert.ok(published.p_idempotency_key.length>=8);
  // a lost answer is asked again with the same request key
  failNextMutate=true;
  await ops.page.locator('[data-market="paused"]').click();
  await ops.page.waitForSelector('[data-games-pending]');
  const lost=adminCalls.filter(c=>c[0]==='orbit_admin_stock_mutate').at(-1)[1];
  await shot(ops.page,'admin-minigames-pending');
  await ops.page.locator('[data-games-pending]').click();
  await ops.page.waitForFunction(()=>!document.querySelector('[data-games-pending]') && /일시정지 상태로 바꿨어요/.test(document.querySelector('[data-games-admin]').textContent));
  assert.equal(adminCalls.filter(c=>c[0]==='orbit_admin_stock_mutate').at(-1)[1].p_idempotency_key,lost.p_idempotency_key);
  assert.equal(market.status,'paused');
  // 호재·악재 for one stock
  await ops.page.locator('[data-games-view="event"]').click();
  await ops.page.waitForSelector('[data-stock-event]');
  assert.equal(await ops.page.locator('[data-stock-event] [data-stock-field]').isHidden(),true);
  await ops.page.locator('[data-stock-event] select[name="eventType"]').selectOption('BAD');
  await ops.page.locator('[data-stock-event] select[name="targetScope"]').selectOption('STOCK');
  await ops.page.locator('[data-stock-event] select[name="stockId"]').selectOption('3');
  await ops.page.locator('[data-stock-event] input[name="title"]').fill('심장박동 부스 일시 휴식');
  await ops.page.locator('[data-stock-event] textarea[name="description"]').fill('30분 동안 운영을 쉬어요.');
  await ops.page.locator('[data-stock-event] button[type="submit"]').click();
  await ops.page.waitForFunction(()=>/이벤트를 등록했어요/.test(document.querySelector('[data-games-admin]').textContent));
  const ev=adminCalls.filter(c=>c[0]==='orbit_admin_stock_mutate').at(-1)[1];
  assert.equal(ev.p_action,'CREATE_EVENT'); assert.equal(ev.p_payload.stockId,'3'); assert.equal(ev.p_payload.eventType,'BAD'); assert.equal(ev.p_payload.impact,10);
  assert.equal(Date.parse(ev.p_payload.endsAt)-Date.parse(ev.p_payload.startsAt),3600000);
  assert.match(await ops.page.locator('.games-admin-list').textContent(),/심장박동 부스 일시 휴식/);
  await shot(ops.page,'admin-minigames-event');
  // 뉴스 without a linked event sends no effect fields
  await ops.page.locator('[data-games-view="news"]').click();
  await ops.page.waitForSelector('[data-stock-news]');
  assert.equal(await ops.page.locator('[data-stock-news] [data-effect]').isHidden(),true);
  await ops.page.locator('[data-stock-news] select[name="priority"]').selectOption('URGENT');
  await ops.page.locator('[data-stock-news] input[name="title"]').fill('거래 일시 중단 안내');
  await ops.page.locator('[data-stock-news] textarea[name="content"]').fill('점검으로 잠시 거래를 멈춰요.');
  await ops.page.locator('[data-stock-news] button[type="submit"]').click();
  await ops.page.waitForFunction(()=>/뉴스를 등록했어요/.test(document.querySelector('[data-games-admin]').textContent));
  const nw=adminCalls.filter(c=>c[0]==='orbit_admin_stock_mutate').at(-1)[1];
  assert.deepEqual([nw.p_action,nw.p_payload.priority,nw.p_payload.effectType,nw.p_payload.targetScope,nw.p_payload.impact],['CREATE_NEWS','URGENT','NONE',null,null]);
  await shot(ops.page,'admin-minigames-news');
  await ops.page.locator('[data-games-view="audit"]').click();
  await ops.page.waitForFunction(()=>document.querySelectorAll('.games-admin-list li').length===4);
  assert.match(await ops.page.locator('.games-admin-list').textContent(),/뉴스·공지 등록/);
  await shot(ops.page,'admin-minigames-audit');
  // 블랙잭: tables and card limits
  await ops.page.locator('[data-games-section="blackjack"]').click();
  await ops.page.waitForSelector('[data-bj-limits]');
  assert.match(await ops.page.locator('.games-admin-list').textContent(),/10101홍길동 vs 10102김철수/);
  assert.match(await ops.page.locator('.games-admin-list').textContent(),/뒤 사람 승 · 앞 사람 몰수패/);
  assert.match(await ops.page.locator('.games-admin-list').textContent(),/7라운드/);
  // 1.49: only the per-game limit is left; there is no per-turn choice
  assert.doesNotMatch(await ops.page.locator('[data-bj-limits]').textContent(),/한 차례/);
  assert.equal(await ops.page.locator('[data-bj-limits] select').count(),1);
  await ops.page.locator('[data-bj-limits] select[name="maxDraws"]').selectOption('6');
  await ops.page.locator('[data-bj-limits] button[type="submit"]').click();
  await ops.page.waitForFunction(()=>/카드 제한을 저장했어요/.test(document.querySelector('[data-games-admin]').textContent));
  assert.deepEqual(adminCalls.filter(c=>c[0]==='festival_blackjack_admin' && c[1].p_action==='save').map(c=>c[1].p_payload),[{maxDraws:6}]);
  assert.match(await ops.page.locator('[data-bj-limits]').textContent(),/지금: 한 판에 6장/);
  await shot(ops.page,'admin-minigames-blackjack');
  for(const width of [320]) {
    const narrow=await pageFor(admin,width);
    await routeTo(narrow.page,'admin'); await openOperatorTool(narrow.page,'minigames');
    await narrow.page.waitForSelector('.games-admin-tiles'); await shot(narrow.page,'admin-minigames-stock',width);
    await narrow.page.locator('[data-games-section="blackjack"]').click(); await narrow.page.waitForSelector('[data-bj-limits]'); await shot(narrow.page,'admin-minigames-blackjack',width);
    await narrow.context.close();
  }
  // Narrow and wide screens
  for(const width of [320,1024]) {
    const narrow=await pageFor(visitor,width);
    for(const r of ['games','gamesStock','gamesBlackjack','home']) { await routeTo(narrow.page,r); await narrow.page.waitForTimeout(600); await shot(narrow.page,r,width); }
    await narrow.page.evaluate(()=>{state.gameStockId='1';state.route='gamesStockDetail';render();}); await narrow.page.waitForSelector('.game-chart .line'); await shot(narrow.page,'gamesStockDetail',width);
    await narrow.context.close();
  }
  // Demo (local) mode explains instead of calling the server
  assert.ok(calls.includes('orbit_trade_stock') && calls.includes('festival_blackjack_join') && calls.includes('festival_blackjack_action') && !calls.includes('orbit_blackjack_join') && !calls.includes('orbit_blackjack_action') && calls.includes('festival_blackjack_lobby') && calls.includes('festival_blackjack_rematch') && calls.includes('festival_blackjack_forfeit'));
  console.log(JSON.stringify({calls:[...new Set(calls)],errors:pages.map(p=>p.errors).flat(),artifacts:path.relative(root,output)}));
  assert.deepEqual(pages.map(p=>p.errors).flat(),[]);
} finally { await browser.close(); }
