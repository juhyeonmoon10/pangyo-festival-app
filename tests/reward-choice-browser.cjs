const {chromium}=require('playwright');
const {openOperatorTool}=require('./operator-navigation.cjs');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const out=path.resolve(__dirname,'../artifacts/reward-choice');fs.mkdirSync(out,{recursive:true});
const base=`http://127.0.0.1:${Number(process.env.REWARD_PREVIEW_PORT||5193)}`;
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true}),results=[];
  try {
    for(const width of [320,390,430,1024]) for(const count of [0,3,6,9,12]) {
      const context=await browser.newContext({viewport:{width,height:844}});
      await context.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
      const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.goto(`${base}/tests/stamp-ui-preview.html?demo=1&completed=${count}`);
      assert.equal(await page.locator('.reward-choice-section,#rewardChoiceForm').count(),0);
      assert.equal(await page.locator('.stamp-path-list').count(),1);
      assert.equal(await page.locator('.stamp-path-step.is-earned').count(),count);
      const button=page.locator('.stamp-voucher-shortcut'),bounds=await button.boundingBox();
      assert.ok(bounds.height>=44&&bounds.y+bounds.height<844);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      assert.ok(await page.evaluate(()=>document.documentElement.scrollHeight>innerHeight));
      assert.equal(await page.locator('.stamp-board-header h1').innerText(),'스탬프');
      await page.screenshot({path:path.join(out,`stamps-${count}-${width}.png`),fullPage:true});
      await page.evaluate(()=>scrollTo({top:document.documentElement.scrollHeight,behavior:'instant'}));
      await page.waitForFunction(()=>scrollY>0);
      const last=await page.locator('.stamp-path-step').nth(14).locator('.stamp-path-node').boundingBox();
      const nav=await page.locator('.bottom-nav').boundingBox();
      assert.ok(last.y>=0&&last.y+last.height<nav.y);
      await page.screenshot({path:path.join(out,`board-scroll-${count}-${width}.png`)});
      await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));
      await button.scrollIntoViewIfNeeded();
      await button.click();
      const panel=page.locator('.reward-choice-section');await panel.waitFor();
      assert.equal(await panel.locator('button[type=submit]').isDisabled(),count<3);
      await panel.screenshot({path:path.join(out,`choice-${count}-${width}.png`)});
      if(count>=3) {
        const kind=count===3?'photo':'food';
        let previous=0;
        while(previous<Math.min(2,Math.floor(count/3))) {
          await page.locator('[data-voucher-filter="claim"]').click();
          const target=Number(await panel.locator('[name=firstTarget]').inputValue());
          await panel.locator(`input[value=${target===3?kind:'photo'}]`).check();
          await panel.locator('button[type=submit]').click();
          await page.waitForFunction(n=>document.querySelectorAll('.festival-ticket').length>n,previous).catch(async error=>{
            await page.screenshot({path:path.join(out,`failure-${count}-${width}.png`),fullPage:true});
            console.error({width,count,previous,errors,body:await page.locator('body').innerText()});throw error;
          });
          previous=await page.locator('.festival-ticket').count();
        }
        assert.equal(await page.locator('.festival-ticket').count(),Math.min(2,Math.floor(count/3)));
        const titles=await page.locator('.festival-ticket h2').allTextContents();
        assert.ok(titles.includes(kind==='photo'?'포토부스 이용권':'푸드트럭 교환권'));
        if(count>=6) assert.equal(new Set(titles).size,2);
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
        await page.screenshot({path:path.join(out,`issued-${count}-${width}.png`),fullPage:true});
        await page.locator('.bottom-nav [data-route=stamps]').click();
        assert.equal(await page.locator('.reward-choice-section,#rewardChoiceForm').count(),0);
        await page.locator('.stamp-voucher-shortcut').click();
        await page.locator('[data-voucher-filter="available"]').click();
        assert.equal(await page.locator('.festival-ticket').count(),Math.min(2,Math.floor(count/3)));
      }
      await page.locator('[data-history-back]').click();
      await page.locator('.stamp-path-track').waitFor();
      assert.equal(await page.locator('.reward-choice-section,#rewardChoiceForm').count(),0);
      assert.deepEqual(errors,[]);results.push({width,count,ok:true});await context.close();
    }
    for(const width of [320,390,430,1024]) for(const mode of ['student','missing','legacy','admin']) {
      const context=await browser.newContext({viewport:{width,height:844}});
      await context.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
      const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.goto(`${base}/tests/reward-server-preview.html?mode=${mode}&count=6&retry=1`);
      if(mode==='student') {
        const form=page.locator('#rewardChoiceForm');await form.waitFor();await form.locator('[value=food]').check();
        await form.locator('button[type=submit]').click();
        assert.equal(await form.locator('button[type=submit]').isDisabled(),true);
        await page.waitForFunction(()=>document.querySelector('.reward-choice-status')?.textContent.includes('다시 시도'));
        assert.equal(await page.locator('.festival-ticket').count(),0);
        assert.equal(await form.locator('[value=food]').isChecked(),true);
        await form.locator('button[type=submit]').click();await page.waitForFunction(()=>document.querySelectorAll('.festival-ticket').length===2);
        assert.equal(await page.locator('.festival-ticket').count(),2);
        const calls=await page.evaluate(()=>fixtureCalls);
        assert.equal(calls.length,2);assert.equal(calls[0].p_request_id,calls[1].p_request_id);
        assert.ok(calls.every(c=>c.name==='festival_reward_write'&&c.p_payload.kind==='food'&&!('userId' in c.p_payload)));
        assert.ok(calls.every(c=>c.p_payload.firstTarget===3));
        await page.locator('[data-voucher-filter="claim"]').click();
        assert.equal(await form.count(),0);
      } else if(mode==='missing'||mode==='legacy') {
        await page.locator('[data-voucher-filter="available"]').click();
        await page.getByText('보유한 바우처가 없어요',{exact:true}).waitFor();
        assert.equal(await page.locator('#rewardChoiceForm,[data-ops-claim]').count(),0);
      } else {
        await openOperatorTool(page,'rules');
        const form=page.locator('[data-ops-form=reward_config]');await form.waitFor();
        await form.locator('[name=photoStock]').fill('30');await form.locator('[name=foodStock]').fill('40');
        page.on('dialog',d=>d.accept());await form.locator('button[type=submit]').click();
        await page.waitForFunction(()=>document.querySelector('.ops-form-status')?.textContent.includes('다시 시도'));
        await form.locator('button[type=submit]').click();
        await page.waitForFunction(()=>document.querySelector('[name=photoVersion]')?.value==='1');
        const calls=await page.evaluate(()=>fixtureCalls);assert.equal(calls.length,2);
        assert.equal(calls[0].p_request_id,calls[1].p_request_id);
        assert.equal(calls[1].p_action,'reward_config');assert.equal(calls[1].p_payload.photoStock,30);assert.equal(calls[1].p_payload.foodStock,40);
        assert.equal(calls[1].p_payload.expiresAt,'2099-12-31T06:00:00.000Z');
      }
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual(errors,[]);
      await page.screenshot({path:path.join(out,`server-${mode}-${width}.png`),fullPage:true});
      results.push({width,mode,ok:true});await context.close();
    }
    fs.writeFileSync(path.join(out,'browser.json'),JSON.stringify({at:new Date().toISOString(),externalRequests:'blocked',results},null,2));
    console.log(`${results.length}/36 browser scenarios passed`);
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
