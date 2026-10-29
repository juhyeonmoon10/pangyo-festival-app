const { chromium } = require('playwright');
const {openOperatorTool}=require('./operator-navigation.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = `http://127.0.0.1:${Number(process.env.STAMP_SIM_PORT || 5194)}`;
const out = path.resolve(__dirname, '../artifacts/stamp-simulator');
fs.mkdirSync(out, { recursive: true });

(async () => {
  const browser = await chromium.launch({channel:'msedge',headless:true});
  const results=[];
  try {
    for(const width of [320,390,430,1024]) for(const demo of [false,true]) {
      const context=await browser.newContext({viewport:{width,height:844}});
      await context.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
      const page=await context.newPage(),errors=[];
      page.on('pageerror',e=>errors.push(e.message));
      const response=await page.goto(`${base}/tests/stamp-simulator-preview.html${demo?'?demo=1':''}`);
      assert.equal(response.status(),200);
      if(!demo) {
        await page.waitForFunction(()=>festivalOpsUI.snapshot()?.ready);
        await openOperatorTool(page,'stamp-simulator');
      }
      await page.locator('#stampSimIssueForm').waitFor();
      const before=await page.evaluate(()=>JSON.stringify(state.db));
      const writesBefore=await page.evaluate(()=>fixtureCalls.filter(c=>c.type==='write').length);
      const readsBefore=await page.evaluate(()=>fixtureCalls.filter(c=>c.type==='read').length);
      const ids=await page.locator('#stampSimBooth option').evaluateAll(options=>options.slice(0,12).map(o=>o.value));
      assert.equal(ids.length,12);
      const issue=async i=>{
        await page.locator('#stampSimBooth').selectOption(ids[i]);
        await page.locator('#stampSimIssue').click();
        assert.equal(await page.locator('#stampSimIssue').isDisabled(),true);
      };
      for(let i=0;i<3;i++)await issue(i);
      assert.equal(await page.evaluate(id=>festivalStampSimulator.issue(id).ok,ids[0]),false);
      assert.equal(await page.evaluate(()=>festivalStampSimulator.snapshot().visits.length),3);
      await page.locator('#stampSimRewardForm [value=photo]').check();
      await page.locator('#stampSimRewardForm button').click();
      for(let i=3;i<6;i++)await issue(i);
      assert.equal(await page.locator('.stamp-sim-vouchers li').count(),2);
      for(let i=6;i<9;i++)await issue(i);
      await page.locator('#stampSimRewardForm [value=food]').check();
      await page.locator('#stampSimRewardForm button').click();
      for(let i=9;i<12;i++)await issue(i);
      assert.equal(await page.locator('.stamp-sim-vouchers li').count(),4);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));
      await page.screenshot({path:path.join(out,`${demo?'demo':'server'}-${width}.png`)});
      await page.locator('[data-stamp-sim-preview]').click();
      const dialog=page.locator('.stamp-sim-dialog'); await dialog.waitFor();
      assert.equal(await dialog.locator('.stamp-path-step.is-earned').count(),12);
      assert.equal(await dialog.locator('.stamp-path-step.is-issued').count(),4);
      assert.equal(await dialog.locator('[data-route],[data-list-select],[data-voucher]').count(),0);
      assert.ok(await dialog.evaluate(el=>el.scrollHeight>el.clientHeight));
      const box=await dialog.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width);
      await page.screenshot({path:path.join(out,`${demo?'demo':'server'}-board-${width}.png`)});
      await page.keyboard.press('Escape');
      assert.equal(await dialog.count(),0);
      assert.equal(await page.locator('[data-stamp-sim-preview]').evaluate(el=>el===document.activeElement),true);
      assert.equal(await page.evaluate(()=>JSON.stringify(state.db)),before);
      assert.equal(await page.evaluate(()=>fixtureCalls.filter(c=>c.type==='write').length),writesBefore);
      assert.equal(await page.evaluate(()=>fixtureCalls.filter(c=>c.type==='read').length),readsBefore);
      page.once('dialog',d=>d.accept());
      await page.locator('[data-stamp-sim-reset]').click();
      assert.equal(await page.evaluate(()=>festivalStampSimulator.snapshot().visits.length),0);
      assert.equal(await page.locator('.stamp-sim-vouchers li').count(),0);
      assert.equal(await page.evaluate(()=>JSON.stringify(state.db)),before);
      await issue(0);
      await page.reload();
      if(!demo){await page.waitForFunction(()=>festivalOpsUI.snapshot()?.ready);await openOperatorTool(page,'stamp-simulator');}
      assert.equal(await page.evaluate(()=>festivalStampSimulator.snapshot().visits.length),0);
      await issue(0);
      await page.evaluate(()=>{state.user.role='user';render();});
      assert.equal(await page.locator('[data-stamp-simulator]').count(),0);
      assert.equal(await page.evaluate(()=>festivalStampSimulator.issue('test-2').ok),false);
      assert.equal(await page.evaluate(()=>festivalStampSimulator.snapshot()),null);
      assert.deepEqual(errors,[]);
      results.push({width,demo,passed:true,realDataUnchanged:true,writes:0});
      await context.close();
    }
    for(const demo of [false,true]) {
      const context=await browser.newContext({viewport:{width:390,height:844}});
      await context.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
      const page=await context.newPage();
      await page.goto(`${base}/tests/stamp-simulator-preview.html?role=user${demo?'&demo=1':''}`);
      await page.waitForFunction(()=>state.user?.role==='user');
      assert.equal(await page.locator('#stampSimIssueForm').count(),0);
      assert.equal(await page.evaluate(()=>festivalStampSimulator.issue('test-1').ok),false);
      results.push({studentBlocked:true,demo,passed:true});
      await context.close();
    }
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({results,externalRequests:'blocked',realDatabaseAccess:0},null,2));
    console.log(`${results.length} simulator scenarios passed`);
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
