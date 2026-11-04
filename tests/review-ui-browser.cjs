const {chromium}=require('playwright');
const {openOperatorTool}=require('./operator-navigation.cjs');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const out=path.resolve(__dirname,'../artifacts/review-identity');
const base=process.env.PREVIEW_URL || 'http://127.0.0.1:5195';
fs.mkdirSync(out,{recursive:true});
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const results=[];
  try {
    for(const width of [320,390,430]) for(const mode of ['own','allowed','unknown']) {
      const context=await browser.newContext({viewport:{width,height:844},deviceScaleFactor:1});
      await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
      const page=await context.newPage(),errors=[];
      page.on('pageerror',e=>errors.push(e.message));
      await page.goto(`${base}/tests/review-ui-preview.html?demo=1&mode=${mode}`);
      const section=page.locator('#boothReviewSection');
      await section.scrollIntoViewIfNeeded();
      if(mode==='own') {
        // Own-club booths show no rating form at all, only the explanation.
        assert.equal(await page.locator('#boothReviewSection .review-compose,#submitReview,#reviewContent,[data-rating]').count(),0);
        assert.match(await section.innerText(),/본인 동아리 부스에는 별점을 남길 수 없어요/);
      } else {
        assert.equal(await page.locator('#submitReview').isDisabled(),mode!=='allowed');
        assert.equal(await page.locator('#reviewContent').isDisabled(),mode!=='allowed');
      }
      if(mode==='unknown') assert.match(await section.innerText(),/본인 소속을 먼저 확인/);
      if(mode==='allowed') {
        assert.match(await section.innerText(),/김하늘 이름으로 공개/);
        await page.locator('[data-rating="5"]').click();
        await page.locator('#reviewContent').fill('동아리 체험이 즐거웠어요.');
      }
      const layout=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,
        fields:[...document.querySelectorAll('#boothReviewSection button,#boothReviewSection textarea')].filter(e=>!e.hidden).map(e=>{const r=e.getBoundingClientRect();return{x:r.x,right:r.right,width:r.width};})}));
      assert.ok(layout.scroll<=width+1,`horizontal overflow at ${width}`);
      assert.ok(layout.fields.every(r=>r.x>=-1&&r.right<=width+1),`review fields overflow at ${width}`);
      await section.screenshot({path:path.join(out,`${mode}-${width}.png`)});
      if(mode==='allowed') {
        await page.locator('#submitReview').click();
        await page.locator('.review-list .review').waitFor();
        assert.match(await page.locator('.review-list').innerText(),/김하늘/);
        assert.doesNotMatch(await page.locator('.review-list').innerText(),/표시용 별명|@/);
      }
      assert.deepEqual(errors,[]);
      results.push({width,mode,ok:true});await context.close();
    }
    for(const width of [320,390,430]) {
      const context=await browser.newContext({viewport:{width,height:844}});
      await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
      const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.goto(`${base}/tests/review-ui-preview.html?mode=admin`);
      await openOperatorTool(page,'participants');
      await page.locator('#reviewRosterLookup button').click();
      const form=page.locator('#reviewRosterForm');
      await form.getByLabel('명단 학번').fill('11001');
      await form.getByRole('button',{name:'명단 조회',exact:true}).click();
      await form.getByText('명단 대조 완료',{exact:true}).waitFor();
      await form.locator('[name=confirmed]').check();
      await form.getByLabel('처리 사유').fill('학교 확인 명단 대조');
      await form.getByRole('button',{name:'계정에 연결'}).click();
      await page.getByText('명단과 계정을 연결했어요.',{exact:true}).waitFor();
      assert.deepEqual(await page.evaluate(()=>({studentNumber:window.fixtureLastSave.studentNumber,confirmed:window.fixtureLastSave.confirmed,rosterVersion:window.fixtureLastSave.rosterVersion})),{studentNumber:'11001',confirmed:true,rosterVersion:1});
      assert.equal(await page.evaluate(()=>('realName' in window.fixtureLastSave)||('boothKeys' in window.fixtureLastSave)),false);
      const bounds=await page.locator('.ops-dialog').boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width+1);
      await page.locator('.ops-dialog').screenshot({path:path.join(out,`admin-${width}.png`)});
      assert.deepEqual(errors,[]);results.push({width,mode:'admin roster',ok:true});await context.close();
    }
    fs.writeFileSync(path.join(out,'browser.json'),JSON.stringify({at:new Date().toISOString(),environment:'isolated fixture, network blocked except localhost',results},null,2));
    console.log(`${results.length}/12 mobile cases passed`);
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
