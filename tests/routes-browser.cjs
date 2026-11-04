// Real HTTP pages and bundled auth SDK; all external requests are intercepted.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('playwright');
const {createPreviewServer}=require('../tools/preview-ui.cjs');
const {PROJECT_URL,CLUB_IDS}=require('../supabase-catalog.js');
const out=path.join(__dirname,'../artifacts/routes');
const uid='a0000000-0000-4000-8000-000000000001';
const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
const token=`${encode({alg:'HS256',typ:'JWT'})}.${encode({sub:uid,exp:4102444800,role:'authenticated'})}.fixture`;
const session={access_token:token,refresh_token:'fixture',token_type:'bearer',expires_at:4102444800,expires_in:3600,user:{id:uid}};
const event={id:'b0000000-0000-4000-8000-000000000001',name:'Synthetic festival',state:'open',review_points:10,version:1};
const catalog={event,items:Object.values(CLUB_IDS).map(key=>({key,name:key,status:'open',floor:2,location:'',description:'Synthetic program',version:1}))};
catalog.items.push({key:'extra-booth',name:'Synthetic extra booth',status:'open',floor:1,location:'Synthetic hall',description:'Additional booth',version:1});
const results=[];

(async()=>{
  fs.mkdirSync(out,{recursive:true});
  const server=createPreviewServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({channel:'msedge',headless:true});
  async function fixture(width,{admin=false,signedIn=true}={}) {
    const context=await browser.newContext({viewport:{width,height:844},reducedMotion:'reduce'});
    if(signedIn) await context.addInitScript(session=>{
      if(!sessionStorage.getItem('fixture-seeded')) {
        localStorage.setItem('pangyo-google-session-v1',JSON.stringify(session));
        sessionStorage.setItem('fixture-seeded','1');
      }
    },session);
    const page=await context.newPage(),errors=[],calls=[],unexpected=[];
    page.on('pageerror',e=>errors.push(e.message));
    await context.route('**/*',async route=>{
      const req=route.request(),url=new URL(req.url());
      if(url.origin===origin) return route.continue();
      if(url.origin!==PROJECT_URL) {unexpected.push(url.origin);return route.abort();}
      const body=req.method()==='POST'?req.postDataJSON():null;
      calls.push({path:url.pathname,body});
      if(url.pathname==='/auth/v1/authorize') {
        assert.equal(url.searchParams.get('redirect_to'),origin+'/');
        return route.fulfill({status:302,headers:{location:origin+'/?code=fixture'}});
      }
      if(url.pathname==='/auth/v1/token') return route.fulfill({json:session});
      if(url.pathname==='/auth/v1/logout') return route.fulfill({status:204});
      let data;
      if(url.pathname==='/rest/v1/booths') data=Object.entries(CLUB_IDS).map(([id,name])=>({id,name,rating:0,position:''}));
      if(url.pathname==='/rest/v1/rpc/festival_nfc_profile') data={id:1,authUserId:uid,name:'Synthetic student',email:'fixture@example.invalid',studentNumber:'21001',needsProfile:false,isAdmin:admin,completedBooths:[]};
      if(url.pathname==='/rest/v1/rpc/festival_reward_read') data={version:2,ready:false};
      if(url.pathname==='/rest/v1/rpc/festival_booth_stamp_counts') data={items:[]};
      if(url.pathname==='/rest/v1/rpc/festival_notices') data={items:[]};
      if(url.pathname==='/rest/v1/rpc/festival_review_identity_self') data={version:1,eventId:event.id,result:null,studentNumber:'21001',eligible:true,verified:false,locked:false,selfRegistered:false,realName:null,clubs:[],boothKeys:[]};
      if(url.pathname==='/rest/v1/rpc/festival_ops_read') {
        const kind=body.p_kind;
        data=kind==='catalog'?catalog:kind==='me'?{ready:true,points:0,reviews:[],visits:[],vouchers:[],rules:[],event}
          :kind==='dashboard'?{participants:1,visits:0,reviews:0,issued:0,used:0}
          :kind==='reviews'?{boothKey:body.p_query.booth,count:0,average:null,myRating:null,reviews:[],reviewPolicy:{version:1,allowed:false,reason:'REVIEW_IDENTITY_REQUIRED',authorName:null}}
          :{items:[]};
      }
      if(url.pathname==='/rest/v1/rpc/festival_ops_write' && body.p_action==='claim') return route.fulfill({status:400,json:{message:'NFC_TAG_INVALID'}});
      if(data!==undefined) return route.fulfill({json:data});
      unexpected.push(url.pathname);return route.fulfill({status:404,json:{message:'Fixture endpoint missing'}});
    });
    const screen=async(route,pathname)=>{
      await page.waitForFunction(route=>typeof state!=='undefined' && state.route===route && !!state.user,route);
      await page.waitForURL(url=>url.pathname===pathname);
      await page.waitForFunction(()=>!state.loginBusy);
    };
    const capture=async name=>{
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No horizontal overflow');
      await page.screenshot({path:path.join(out,`${width}-${name}.png`)});
    };
    return {page,context,screen,capture,errors,calls,unexpected};
  }
  try {
    for(const width of [320,390,430]) {
      const f=await fixture(width);
      for(const [route,url] of [['map','/map'],['stamps','/stamp'],['vouchers','/voucher'],['profile','/my'],['reviews','/reviews'],['identity','/identity']]) {
        assert.equal((await f.page.goto(origin+url)).status(),200);await f.screen(route,url);
        await f.page.reload();await f.screen(route,url);
        if(['map','stamps'].includes(route)) await f.capture(route);
      }
      await f.page.goto(origin+'/map/');await f.screen('map','/map');
      await f.page.locator('[data-floor="3"]').first().click();
      await f.page.locator('[data-route="stamps"]').first().click();await f.screen('stamps','/stamp');
      await f.page.goBack();await f.screen('map','/map');
      assert.equal(await f.page.evaluate(()=>state.floor),3);
      await f.page.reload();await f.screen('map','/map');
      assert.equal(await f.page.evaluate(()=>state.floor),3);
      await f.page.goForward();await f.screen('stamps','/stamp');
      const id=await f.page.evaluate(()=>state.db.booths.find(b=>b.officialClubId).id);
      await f.page.evaluate(id=>goDetail(id),id);
      const detail='/booth/'+encodeURIComponent(id);await f.screen('detail',detail);
      await f.page.reload();await f.screen('detail',detail);
      assert.equal(await f.page.evaluate(()=>state.selectedBoothId),id);
      await f.page.evaluate(id=>openBoothReviews(id),id);await f.screen('boothReviews',detail+'/reviews');
      await f.page.reload();await f.screen('boothReviews',detail+'/reviews');
      assert.equal(await f.page.locator('base').getAttribute('href'),'/');
      assert.ok(await f.page.evaluate(()=>!!document.querySelector('.ui-icon')));
      await f.page.goto(origin+'/booth/extra-booth');await f.screen('detail','/booth/extra-booth');
      await f.page.getByText('Synthetic extra booth',{exact:true}).first().waitFor();
      await f.page.waitForFunction(()=>serverReviews.get('extra-booth')?.status==='ready');
      await f.page.goto(origin+'/admin');await f.screen('admin','/admin');
      await f.page.getByText('운영자 전용',{exact:true}).waitFor();
      assert.equal(f.calls.some(c=>c.body?.p_kind==='dashboard'),false);
      await f.page.goto(origin+'/booth/missing-booth');await f.screen('detail','/booth/missing-booth');
      await f.page.getByText('부스를 찾을 수 없어요',{exact:true}).waitFor();
      assert.deepEqual(f.errors,[]);assert.deepEqual(f.unexpected,[]);
      results.push({width,passed:true,checks:'direct pages, reload, trailing slash, tabs, back/forward, nested assets, booth/reviews, admin denied, missing booth'});
      await f.context.close();
    }
    const admin=await fixture(390,{admin:true});
    await admin.page.goto(origin+'/admin');await admin.screen('admin','/admin');
    await admin.page.locator('.ops-stats').waitFor();await admin.capture('admin');
    await admin.page.reload();await admin.screen('admin','/admin');
    await admin.page.evaluate(()=>navigateTo('profile'));await admin.screen('profile','/my');
    await admin.page.locator('[data-route="login"]').click();
    await admin.page.waitForURL(url=>url.pathname==='/login');
    await admin.page.goBack();await admin.page.locator('#googleLogin').waitFor();
    assert.equal(await admin.page.evaluate(()=>state.user),null);
    assert.deepEqual(admin.errors,[]);assert.deepEqual(admin.unexpected,[]);
    await admin.context.close();
    results.push({width:390,passed:true,checks:'admin direct/reload, logout, back does not restore access'});

    for(const target of ['/map','/stamp','/admin']) {
      const f=await fixture(390,{signedIn:false,admin:target==='/admin'});
      await f.page.goto(origin+target);await f.page.locator('#googleLogin:not([disabled])').waitFor();
      assert.equal(new URL(f.page.url()).pathname,'/login');assert.equal(new URL(f.page.url()).searchParams.get('next'),target);
      await f.page.reload();await f.page.locator('#googleLogin:not([disabled])').waitFor();
      assert.equal(new URL(f.page.url()).searchParams.get('next'),target);
      await f.page.locator('#googleLogin').click();
      await f.page.waitForURL(url=>url.pathname===target && !url.searchParams.has('code'));
      await f.page.waitForFunction(()=>!!state.user);
      assert.deepEqual(f.errors,[]);assert.deepEqual(f.unexpected,[]);
      await f.context.close();results.push({passed:true,checks:'login callback returns to '+target});
    }
    const nfc=await fixture(390,{signedIn:false});
    const tag='nf1.e30.'+'a'.repeat(64);
    await nfc.page.goto(origin+'/nfc#t='+tag);await nfc.page.locator('#googleLogin:not([disabled])').waitFor();
    assert.equal(new URL(nfc.page.url()).hash,'');assert.equal(new URL(nfc.page.url()).searchParams.get('next'),'/nfc');
    await nfc.page.locator('#googleLogin').click();
    await nfc.screen('scan','/nfc');
    await nfc.page.waitForFunction(()=>state.scanResult?.type==='error');
    assert.equal(nfc.calls.filter(c=>c.body?.p_action==='claim').length,1);
    assert.deepEqual(nfc.errors,[]);assert.deepEqual(nfc.unexpected,[]);
    await nfc.context.close();results.push({passed:true,checks:'NFC fragment consumed before redirect, single resumed claim'});
    for(const url of ['/api/debug','/operations-server/install.sql','/.env','/not-a-page']) assert.equal((await fetch(origin+url)).status,404);
  } catch(error) {results.push({passed:false,error:error.stack});process.exitCode=1;}
  finally {
    await browser.close();await new Promise(resolve=>server.close(resolve));
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(results,null,2));
    console.log(JSON.stringify(results,null,2));
  }
})();
