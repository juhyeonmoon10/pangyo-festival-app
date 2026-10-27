// The real bundled SDK runs against synthetic responses; no shared server is contacted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(process.env.AUTH_TEST_ROOT || path.join(__dirname, '..'));
const output = path.resolve(process.env.AUTH_TEST_OUTPUT || path.join(__dirname, '../artifacts/auth-session-lifecycle'));
const { PROJECT_URL, CLUB_IDS } = require(path.join(root, 'supabase-catalog.js'));
const origin = process.env.AUTH_TEST_URL || 'http://127.0.0.1:19994';
const uid = 'a0000000-0000-4000-8000-000000000001';
const encode = x => Buffer.from(JSON.stringify(x)).toString('base64url');
const jwt = `${encode({alg:'HS256',typ:'JWT'})}.${encode({sub:uid,exp:4102444800,role:'authenticated'})}.fixture`;
const session = {access_token:jwt,refresh_token:'fixture',token_type:'bearer',expires_at:4102444800,expires_in:3600,user:{id:uid}};
const event = {name:'Fixture festival',state:'open',review_points:10,version:1};
const catalog = {event,items:[{key:'글빛누리',name:'글빛누리',status:'open',floor:2,location:'2층 1-1',description:'Fixture',version:1}]};
const mime = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.webp':'image/webp','.json':'application/json'};
const captureClient = `\n;(() => { const sdk = window.supabase; window.__authEvents = [];
  window.supabase = {...sdk, createClient(...args) { const c = sdk.createClient(...args);
    window.__testClient = c; c.auth.onAuthStateChange(e => window.__authEvents.push(e)); return c; }}; })();`;

(async()=>{
  fs.mkdirSync(output,{recursive:true});
  const browser = await chromium.launch({channel:'msedge',headless:true});
  const results = [];
  try {
    for (const width of (process.env.AUTH_TEST_BASELINE ? [390] : [320,390,430,1024])) {
      const context = await browser.newContext({viewport:{width,height:844}});
      await context.addInitScript(session=>{
        localStorage.setItem('pangyo-google-session-v1',JSON.stringify(session));
        window.__testVisibility = 'visible';
        Object.defineProperty(document,'visibilityState',{get:()=>window.__testVisibility,configurable:true});
      },session);
      const errors=[], unexpected=[], calls=[];
      const page = await context.newPage();
      page.on('pageerror',e=>errors.push(e.message));
      page.on('dialog',d=>d.accept());
      await context.route('**/*',async route=>{
        const request=route.request(), url=new URL(request.url());
        if (url.origin===origin) {
          const file=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1));
          if (process.env.AUTH_TEST_URL) {
            if (file!=='assets/vendor/supabase-2.116.0.js') return route.continue();
            const response=await route.fetch();
            return route.fulfill({response,body:(await response.text())+captureClient});
          }
          const resolved=path.resolve(root,file);
          if (!resolved.startsWith(root+path.sep) || !fs.existsSync(resolved)) return route.fulfill({status:404});
          let bytes=fs.readFileSync(resolved);
          if (file==='festival-account.js' && process.env.AUTH_TEST_BASELINE) bytes=fs.readFileSync(process.env.AUTH_TEST_BASELINE);
          if (file==='assets/vendor/supabase-2.116.0.js') bytes=Buffer.concat([bytes,Buffer.from(captureClient)]);
          return route.fulfill({body:bytes,contentType:mime[path.extname(file)]||'application/octet-stream'});
        }
        let data;
        if (url.origin===PROJECT_URL) {
          calls.push({path:url.pathname,body:request.postDataJSON()});
          if (url.pathname==='/rest/v1/booths') data=Object.values(CLUB_IDS).map(id=>({id,name:id,rating:0,position:''}));
          if (url.pathname==='/rest/v1/rpc/festival_nfc_profile') data={id:1,authUserId:uid,name:'Fixture operator',email:'fixture@example.invalid',studentNumber:'21001',needsProfile:false,isAdmin:true,completedBooths:[]};
          if (url.pathname==='/rest/v1/rpc/festival_my_reviews') data=[];
          if (url.pathname==='/rest/v1/rpc/festival_reward_read') data={version:2,ready:false};
          if (url.pathname==='/rest/v1/rpc/festival_ops_read') {
            const kind=request.postDataJSON().p_kind;
            data=kind==='catalog'?catalog:kind==='me'?{ready:true,points:10,reviews:[],visits:[],vouchers:[],rules:[],event}
              :kind==='dashboard'?{participants:100,visits:200,reviews:50,issued:10,used:2}
              :kind==='participants'?{items:[{id:1,name:'Fixture operator',visits:2,points:10}]}:{items:[]};
          }
          if (url.pathname==='/rest/v1/rpc/festival_ops_write') data={saved:true};
          if (url.pathname==='/auth/v1/token') data=session;
          if (url.pathname==='/auth/v1/logout') return route.fulfill({status:204});
        }
        if (data!==undefined) return route.fulfill({json:data});
        unexpected.push(url.pathname);return route.abort();
      });
      await page.goto(origin);
      await page.waitForFunction(()=>typeof festivalOpsUI!=='undefined' && festivalOpsUI.snapshot()?.ready);
      await page.evaluate(()=>navigateTo('admin'));
      await page.locator('[data-ops-form="event_save"]').waitFor();
      await page.waitForFunction(()=>document.querySelector('.ops-stats')?.textContent.includes('100'));
      const name=page.locator('[data-ops-form="event_save"] input[name="name"]');
      await name.fill('Keep my unsaved draft');
      const refocus=async()=>{
        const previous=await page.evaluate(()=>__authEvents.filter(x=>x==='SIGNED_IN').length);
        await page.evaluate(()=>{window.__testVisibility='hidden';window.dispatchEvent(new Event('visibilitychange'));});
        await page.evaluate(()=>{window.__testVisibility='visible';window.dispatchEvent(new Event('visibilitychange'));});
        await page.waitForFunction(previous=>__authEvents.filter(x=>x==='SIGNED_IN').length>previous,previous);
      };
      for(let i=0;i<3;i++) await refocus();
      assert.equal(await name.inputValue(),'Keep my unsaved draft');
      assert.equal(await page.evaluate(()=>document.activeElement?.name),'name');
      assert.equal((await page.evaluate(()=>festivalAccount.operations.read('dashboard'))).ok,true,'Refocusing must preserve operator access');
      const refresh=await page.evaluate(async()=>{const result=await __testClient.auth.refreshSession();return {error:result.error?.message||null};});
      assert.equal(refresh.error,null);
      assert.equal((await page.evaluate(()=>festivalAccount.operations.read('participants'))).ok,true);
      const saved=page.waitForResponse(r=>r.url().includes('/rpc/festival_ops_write'));
      await page.locator('[data-ops-form="event_save"] button[type="submit"]').click();
      await saved;
      await page.waitForFunction(()=>!document.querySelector('[data-ops-form="event_save"] button')?.disabled);
      assert.equal(calls.filter(c=>c.path==='/rest/v1/rpc/festival_ops_write').length,1,'Operator save reaches only the mock RPC');
      for(const tab of ['participants','catalog','rules','dashboard']) {
        await page.selectOption('#opsTab',tab);
        await page.waitForFunction(tab=>document.querySelector('#opsTab')?.value===tab,tab);
        await refocus();
        assert.equal((await page.evaluate(()=>festivalAccount.operations.read('dashboard'))).ok,true);
      }
      assert.ok(!/다시 로그인/.test(await page.locator('body').innerText()));
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      await page.screenshot({path:path.join(output,`admin-refocus-${width}.png`),fullPage:true});
      await page.evaluate(()=>__testClient.auth.signOut());
      await page.waitForSelector('#googleLogin');
      assert.equal((await page.evaluate(()=>festivalAccount.operations.read('dashboard'))).code,'AUTH_REQUIRED');
      assert.deepEqual(errors,[]);
      assert.deepEqual(unexpected,[]);
      results.push({width,passed:true,refocusEvents:7,tokenRefresh:true,draftPreserved:true,operatorSave:true,logoutBlocked:true,remoteRequests:0});
      await context.close();
    }
  } catch(error) {results.push({passed:false,error:error.stack});process.exitCode=1;}
  finally {
    await browser.close();
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({mode:'real SDK with intercepted synthetic auth/RPC',results},null,2)+'\n');
    console.log(JSON.stringify(results,null,2));
  }
})();
