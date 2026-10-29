const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..'),out=path.join(root,'artifacts/visit-sync');
fs.mkdirSync(out,{recursive:true});
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true}),reports=[];
  try {
    for(const width of [320,390,430]) {
      const context=await browser.newContext({viewport:{width,height:844}});
      await context.route('**/*',r=>new URL(r.request().url()).protocol==='file:'?r.continue():r.abort());
      const page=await context.newPage(),errors=[];
      page.on('pageerror',e=>errors.push(e.message));
      await page.goto(pathToFileURL(path.join(__dirname,'reward-server-preview.html')).href+'?mode=missing&count=2&stamps=1');
      await page.waitForFunction(()=>festivalOpsUI.snapshot()?.ready && state.route==='stamps');
      await page.evaluate(async()=>{
        const read=festivalAccount.operations.read;
        window.syncFixture={fail:false,visits:1,writes:0};
        festivalAccount={...festivalAccount,savePending(){},claim:async()=>{
          syncFixture.writes++;return {ok:true,result:'EARNED',boothKey:'synthetic-1',completedBooths:['synthetic-0','synthetic-1']};
        },operations:{...festivalAccount.operations,read:async(kind,query)=>{
          if(kind==='me' && syncFixture.fail)return {ok:false,code:'NETWORK_ERROR',message:'격리 조회 실패'};
          const value=await read(kind,query);
          return kind==='me'?{...value,data:{...value.data,visits:value.data.visits.slice(0,syncFixture.visits),reviews:[]}}:value;
        }}};
        await festivalOpsUI.refresh(false);render();
        syncFixture.fail=true;
        await nfcAdapter.scan({nfcToken:'isolated-token',idempotencyKey:crypto.randomUUID()});
      });
      await page.locator('#nfcFeedback [data-visit-sync-retry]').waitFor();
      assert.equal(await page.evaluate(()=>state.pendingNfcClaim),null);
      assert.equal(await page.locator('[data-visit-sync-notice]').count(),1);
      await page.screenshot({path:path.join(out,`${width}-saved-refresh-failed.png`),fullPage:true});
      await page.locator('#nfcFeedback .feedback-close').click();
      await page.evaluate(()=>{navigateTo('home');navigateTo('stamps');});
      await page.locator('[data-visit-sync-notice] button').waitFor();
      await page.evaluate(()=>{syncFixture.fail=false;syncFixture.visits=2;});
      await page.locator('[data-visit-sync-notice] button').click();
      await page.waitForFunction(()=>!festivalOpsUI.visitSyncPending() && festivalWeb.completed().length===2);
      assert.equal(await page.evaluate(()=>syncFixture.writes),1,'Retry must only read, never resubmit claim');
      assert.equal(await page.locator('[data-visit-sync-notice]').count(),0);
      assert.equal(await page.locator('.stamp-path-step.is-earned').count(),2);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      assert.deepEqual(errors,[]);
      await page.screenshot({path:path.join(out,`${width}-refreshed.png`),fullPage:true});
      reports.push({width,passed:true,claimWrites:1,stamps:2});
      await context.close();
    }
  } finally {await browser.close();fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({sharedDatabaseAccess:false,reports},null,2));}
  console.log(JSON.stringify(reports));
})().catch(e=>{console.error(e);process.exitCode=1;});
