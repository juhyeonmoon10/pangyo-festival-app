const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'artifacts/bright-ui');
fs.mkdirSync(out, { recursive: true });
const results = [];
const url = (file, query = '') => pathToFileURL(path.join(root, file)).href + query;

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const width of [320, 390, 430, 1024]) {
      const context = await browser.newContext({ viewport: { width, height: 844 }, reducedMotion: 'reduce' });
      await context.route('**/*', route => new URL(route.request().url()).protocol === 'file:' ? route.continue() : route.abort());
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(url('tests/stamp-ui-preview.html', '?demo=1&completed=9&pending=1'));
      await page.evaluate(async () => { await festivalWeb.chooseReward('photo', 3); render(); });
      assert.equal(await page.locator('.stamp-path-step.is-claimable').count(), 1);
      async function capture(name) {
        await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
        await page.waitForFunction(() => [...document.images].filter(i => { const r=i.getBoundingClientRect(); return r.width && r.bottom>0 && r.top<innerHeight; }).every(i => i.complete && i.naturalWidth));
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}: document overflow at ${width}`);
        assert.ok(await page.evaluate(() => [...document.images].filter(i => { const r=i.getBoundingClientRect(); return r.width && r.bottom>0 && r.top<innerHeight; }).every(i => i.complete && i.naturalWidth)), `${name}: broken image`);
        await page.screenshot({ path: path.join(out, `${width}-${name}.png`) });
        results.push({ width, screen: name, passed: true });
      }
      await capture('stamps');
      for (const name of ['home', 'map', 'vouchers', 'reviews', 'profile']) {
        await page.evaluate(route => navigateTo(route), name);
        await capture(name);
      }
      await page.evaluate(() => navigateTo('home'));
      assert.match(await page.locator('.festival-wallet-link').innerText(), /받을 바우처 1/);
      assert.equal(await page.locator('.bottom-nav .nav-btn').count(), 4);
      await page.locator('.web-map-action').click();
      const nav = await page.locator('.bottom-nav').boundingBox();
      const sheet = await page.locator('#sheet').boundingBox();
      assert.ok(Math.abs(sheet.y + sheet.height - nav.y) <= 2, 'Sheet must stay attached above navigation');
      await page.locator('#mapZoomIn').click();
      assert.ok(await page.evaluate(() => state.mapZoom > 1));
      await page.locator('#resetMapView').click();
      const input = page.locator('#searchScreenInput');
      await input.fill('1학년 1반');
      const spaced = await page.locator('#floorBoothList [data-list-select]').evaluateAll(nodes => nodes.map(n => n.dataset.listSelect));
      await input.fill('1학년1반');
      assert.deepEqual(await page.locator('#floorBoothList [data-list-select]').evaluateAll(nodes => nodes.map(n => n.dataset.listSelect)), spaced);
      assert.ok(spaced.length, 'Class search returns a result');
      await input.evaluate(el => { window.imeNode = el; el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); el.value = '인벨릭스'; el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true })); });
      assert.ok(await input.evaluate(el => el === window.imeNode && document.activeElement === el));
      await input.evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '스' })));
      assert.equal(await input.inputValue(), '인벨릭스');
      await capture('search');
      await page.locator('#clearSearchScreen').click();
      await page.evaluate(() => openBoothReview(state.db.stamps[9].boothId));
      await capture('detail');
      await page.locator('.review-section').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(out, `${width}-review.png`) });
      results.push({ width, screen: 'review', passed: true });
      await page.locator('#reviewContent').fill('즐거운 축제였어요');
      await page.locator('[data-rating="4"]').click();
      assert.equal(await page.locator('#reviewContent').inputValue(), '즐거운 축제였어요');
      assert.equal(await page.locator('.star.on .ui-icon').first().evaluate(el => getComputedStyle(el).fill), 'rgb(8, 118, 82)');
      await page.locator('.review-compose').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(out, `${width}-review-selected.png`) });
      await page.evaluate(() => { state.user.name = '아주 긴 이름을 가진 축제 참여자'; navigateTo('home'); });
      await capture('long-name');
      await page.goto(url('index.html'));
      await page.locator('#googleLogin').waitFor();
      await capture('login');
      assert.equal(await page.locator('#adminLogin,#switchMode').count(), 0, 'Production login must not expose demo entry');
      assert.deepEqual(errors, []);
      results.push({ width, searchIME: true, sheetAttached: true, rewardBadge: true, draftPreserved: true });
      await context.close();
    }
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route('**/*', route => new URL(route.request().url()).protocol === 'file:' ? route.continue() : route.abort());
    const page = await context.newPage();
    await page.goto(url('tests/stamp-ui-preview.html', '?demo=1&completed=0'));
    await page.evaluate(() => navigateTo('home'));
    assert.equal(await page.locator('.festival-wallet-link.is-ready').count(), 0);
    await page.screenshot({path:path.join(out,'390-zero-home.png')});
    await page.locator('.shortcut-vouchers').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('.shortcut-symbol.vouchers').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(217, 250, 234)');
    await page.screenshot({path:path.join(out,'390-zero-shortcuts.png')});
    await page.evaluate(() => navigateTo('vouchers'));
    await page.screenshot({path:path.join(out,'390-zero-vouchers.png')});
    results.push({width:390,screen:'zero-claimable',passed:true});
    await context.close();
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ results, network: 'all remote requests blocked', databaseWrites: 0 }, null, 2));
    console.log(`${results.length} bright UI screens/flows passed`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
