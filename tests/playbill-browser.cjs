const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const root = path.resolve(__dirname, '..');
  const out = path.join(root, 'test-results/playbill');
  fs.mkdirSync(out, {recursive:true});
  try {
    for (const width of [320,390,1024]) {
      const p = await browser.newPage({viewport:{width,height:844}});
      await p.route(/^https?:/, route => route.abort());
      await p.goto(pathToFileURL(path.join(root,'index.html')).href+'?demo=1');
      await p.evaluate(() => {
        state.user = {...state.db.users[0], id:'stage-test', name:'테스트', role:'admin'};
        navigateTo('home');
      });
      const sheet = p.locator('festival-playbill');
      const fits = () => sheet.evaluate(el => el.scrollWidth <= el.clientWidth + 1);
      assert.equal(await sheet.locator('.stage-day h3').count(),1);
      assert.equal(await sheet.locator('time').count(),3);
      assert.ok(await fits());
      await sheet.screenshot({path:path.join(out,width+'-schedule.png')});
      await sheet.locator('summary').click();
      for (const i of [1,2,3]) await sheet.locator('[name=rank'+i+']').selectOption('demo-stage-'+i);
      await sheet.getByRole('button',{name:'최종 투표'}).click();
      assert.equal(await sheet.locator('.stage-receipt li').count(),3);
      await p.evaluate(()=>navigateTo('admin'));
      await sheet.locator('select[name=id]').selectOption('demo-stage-2');
      await sheet.locator('[name=start]').fill('2026-01-01T10:05');
      await sheet.getByRole('button',{name:'저장',exact:true}).click();
      await sheet.getByText('저장했어요.').waitFor();
      assert.ok(await fits());
      assert.ok(await sheet.getByText('10:05',{exact:true}).isVisible());
      await sheet.screenshot({path:path.join(out,width+'-admin.png')});
      await p.close();
      console.log(width+': schedule, ranked vote and operator edit passed');
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
