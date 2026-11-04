const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const { PROJECT_URL, CLUB_IDS } = require('../supabase-catalog.js');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.vercel/output/static');
const reports = path.join(root, 'artifacts/personal-integrated-1.63');
const config = JSON.parse(fs.readFileSync(path.join(root, '.vercel/output/config.json')));
const headers = config.routes[0].headers;
const allowed = new Set(require('../tools/build-web.cjs').publicFiles());
allowed.add('deployment-info.json');
const types = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp' };
const server = http.createServer((req, res) => {
  const route = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  let file = route.slice(1);
  if (/^\/nfc-cards\/?$/.test(route)) file = 'nfc-cards/index.html';
  else if (new RegExp(`^${require('../festival-router.js').pagePattern}$`).test(route)) file = 'index.html';
  if (!allowed.has(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { ...headers, 'Content-Type': (types[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8' });
  res.end(fs.readFileSync(path.join(output, file)));
});
const uid = '10000000-0000-4000-8000-000000000001';
const enc = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = `${enc({alg:'HS256',typ:'JWT'})}.${enc({sub:uid,exp:4102444800,role:'authenticated'})}.fixture`;
const event = {id:'fixture-event',name:'화면 검증 축제',state:'open',review_points:10,version:1};
const clubs = Object.entries(CLUB_IDS).map(([id,name],i)=>({id,name,key:name,status:'open',floor:i<8?2:i<16?3:4,location:`${i<8?2:i<16?3:4}층`,description:'',version:1}));
const identity = {version:1,eventId:event.id,result:null,verified:false,locked:false,eligible:true,selfRegistered:false,realName:null,studentNumber:'21001',clubs:[],boothKeys:[]};
const profile = {id:1,authUserId:uid,name:'샘플 학생',email:'fixture@example.invalid',studentNumber:'21001',needsProfile:false,isAdmin:true,completedBooths:[]};
const checks = [], errors = [], unexpected = [];
(async () => {
  fs.mkdirSync(reports,{recursive:true});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin = process.env.FESTIVAL_DEPLOYED_URL || `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({channel:'msedge',headless:true});
  try {
    for (const width of [320,390,430,1024]) {
      const context = await browser.newContext({viewport:{width,height:844},reducedMotion:'reduce'});
      await context.addInitScript(({uid,token})=>localStorage.setItem('pangyo-google-session-v1',JSON.stringify({access_token:token,refresh_token:'fixture',token_type:'bearer',expires_at:4102444800,expires_in:3600,user:{id:uid}})),{uid,token});
      await context.route('**/*',route=>{
        const req=route.request(),url=new URL(req.url());
        if(url.origin===origin) return route.continue();
        if(url.origin!==PROJECT_URL) {unexpected.push(url.href);return route.abort();}
        let data;
        if(url.pathname==='/auth/v1/user') data={id:uid,email:profile.email,user_metadata:{full_name:profile.name}};
        if(url.pathname==='/rest/v1/booths') data=clubs.map(c=>({id:c.id,name:c.name,rating:0,position:''}));
        if(url.pathname.endsWith('/festival_nfc_profile')) data=profile;
        if(url.pathname.endsWith('/festival_my_reviews')) data=[];
        if(url.pathname.endsWith('/festival_reward_read')) data={version:2,eventId:event.id,ready:false,count:0,firstTarget:3,secondTarget:6,issuedCount:0,firstChoice:null,secondIssued:false,canChoose:false,options:[]};
        if(url.pathname.endsWith('/festival_notices')) data={items:[]};
        if(url.pathname.endsWith('/festival_waiting') && req.postDataJSON().p_action==='mine') data={items:[]};
        if(url.pathname.endsWith('/festival_booth_stamp_counts')) data={items:[]};
        if(['/rest/v1/rpc/festival_booth_manager','/rest/v1/rpc/festival_voucher_redeem'].includes(url.pathname) && req.postDataJSON().p_action==='status') data={items:[],roles:[]};
        if(url.pathname.endsWith('/festival_review_identity_self') && req.postDataJSON().p_action==='status') data=identity;
        if(url.pathname.endsWith('/festival_ops_read')) {
          const kind=req.postDataJSON().p_kind;
          data=kind==='catalog'?{event,items:clubs}:kind==='me'?{ready:true,points:0,reviews:[],visits:[],vouchers:[],rules:[],event}:kind==='reward_status'?{version:2,eventId:event.id,ready:false,count:0,firstTarget:3,secondTarget:6,issuedCount:0,firstChoice:null,secondIssued:false,canChoose:false,options:[]}:kind==='dashboard'?{participants:1,visits:0,reviews:0,issued:0,used:0}:{items:[]};
        }
        if(data!==undefined) return route.fulfill({json:data});
        unexpected.push(url.pathname);return route.abort();
      });
      const page=await context.newPage();page.setDefaultTimeout(12000);
      page.setDefaultNavigationTimeout(45000);
      page.on('pageerror',e=>errors.push(e.message));
      await page.goto(origin+'/');
      await page.waitForFunction(()=>state.user && festivalOpsUI.snapshot()?.ready);
      await page.waitForFunction(()=>festivalOpsUI.identity());
      for (const route of ['home','map','stamps','vouchers','profile','identity','notices','admin']) {
        await page.evaluate(r=>{navigateTo(r);if(r==='map'){state.floor=2;render();}},route);
        if(route==='identity') {
          const name=page.locator('[name=realName]');assert.equal(await name.inputValue(),'샘플 학생');
          await name.fill('');await page.evaluate(()=>render());assert.equal(await name.inputValue(),'');
          await page.locator('[name=realName]').fill('샘플 학생');
        }
        if(route==='home') {assert.equal(await page.locator('.web-brand [data-route=profile]').count(),0);assert.equal(await page.locator('[data-home-menu],.festival-identity-prompt').count(),0);}
        if(route==='map') {
          assert.ok((await page.locator('.plan-club-name').allTextContents()).includes('글빛누리'));
          const search=page.locator('#searchScreenInput');await search.fill('1학년 1반');const before=await page.locator('#floorBoothList').innerText();
          await search.fill('1학년1반');assert.equal(await page.locator('#floorBoothList').innerText(),before);
          await search.evaluate(el=>{window.imeInput=el;el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));el.value='인벨릭스';el.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));});
          assert.ok(await search.evaluate(el=>el===window.imeInput));
          await search.evaluate(el=>el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})));
          await page.locator('#clearSearchScreen').click();await page.locator('#mapZoomIn').click();assert.ok(await page.evaluate(()=>state.mapZoom>1));
          await page.locator('#resetMapView').click();
          const box=await page.locator('#mapCard').boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+20,box.y+box.height/2,{steps:8});await page.mouse.up();
          assert.ok(await page.evaluate(()=>Math.abs(state.mapOffsetX)>0));
          assert.equal(await page.evaluate(()=>repo.stampsForUser(state.user.id).length),0);
        }
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,`${width}/${route} overflow`);
        assert.doesNotMatch(await page.locator('main').innerText(),/바우처|축제 소식/);
        await page.screenshot({path:path.join(reports,`${width}-${route}.png`)});
        checks.push({width,route,passed:true});
      }
      await page.goto(origin+'/nfc-cards/');await page.waitForFunction(()=>document.querySelectorAll('.nfc-print-card').length===20);
      await page.evaluate(()=>Promise.all([...document.images].map(i=>i.decode())));
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
      await page.screenshot({path:path.join(reports,`${width}-cards.png`)});
      await page.selectOption('#clubSelect','17');assert.equal(await page.locator('.nfc-print-card').count(),1);
      assert.match(await page.locator('.nfc-print-card').innerText(),/심장박동/);
      checks.push({width,route:'cards',passed:true});
      await context.close();
      const loginContext=await browser.newContext({viewport:{width,height:844}});
      await loginContext.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
      const login=await loginContext.newPage();await login.goto(origin+'/');await login.locator('#googleLogin').waitFor();
      assert.equal(await login.locator('#adminLogin,#switchMode').count(),0);
      await login.screenshot({path:path.join(reports,`${width}-login.png`)});
      checks.push({width,route:'login',passed:true});await loginContext.close();
    }
    assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
    const report={checks,errors,unexpected,origin,liveDatabaseRequests:0,actualGoogleLoginTested:false};
    fs.writeFileSync(path.join(reports,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
