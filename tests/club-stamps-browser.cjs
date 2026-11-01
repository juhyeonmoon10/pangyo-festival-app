const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createPreviewServer } = require('../tools/preview-ui.cjs');
const assets = require('../assets/stamps/SOURCES.json').assets;
const output = path.resolve(__dirname, '../artifacts/club-stamps');

async function showClubVisits(page, count) {
  await page.evaluate(count => {
    const booths = state.db.booths.filter(booth => booth.officialClubId).slice(0, count);
    state.db.stamps = booths.map((booth, i) => ({ id: `club-fixture-${i}`, userId: state.user.id, boothId: booth.id,
      status: 'active', method: 'nfc', createdAt: new Date(1797555600000 + i * 600000).toISOString() }));
    state.db.reviews = booths.map((booth, i) => ({ id: `club-review-${i}`, userId: state.user.id, boothId: booth.id,
      rating: 5, content: '', createdAt: new Date(1797555600000 + i * 600000).toISOString() }));
    render();
  }, count);
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const server = createPreviewServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  const results = [];
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    for (const width of [320, 390, 430, 1024]) {
      const context = await browser.newContext({ viewport: { width, height: 844 } });
      await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${base}/tests/stamp-ui-preview.html?demo=1&completed=20`);
      await showClubVisits(page, 20);
      const expected = await page.evaluate(() => festivalWeb.completed().map(visit => state.db.booths.find(b => b.id === visit.boothId).officialClubId));
      assert.equal(new Set(expected).size, 20);
      assert.deepEqual([...expected].sort(), assets.map(asset => asset.clubId).sort());
      const images = page.locator('.stamp-club-artwork');
      assert.equal(await images.count(), 20);
      for (let i = 0; i < 20; i++) {
        const image = images.nth(i);
        await image.scrollIntoViewIfNeeded();
        await image.evaluate(image => image.decode());
        assert.ok((await image.getAttribute('src')).endsWith(`${expected[i]}.png`));
      }
      const pixels = await images.evaluateAll(images => images.map(image => {
        const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256;
        const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0, 256, 256);
        const data = ctx.getImageData(0, 0, 256, 256).data;
        let ink = 0, clear = 0;
        for (let i = 3; i < data.length; i += 4) { if (data[i] > 150) ink++; if (data[i] === 0) clear++; }
        return { ink, clear, width: image.naturalWidth, height: image.naturalHeight };
      }));
      assert.ok(pixels.every(pixel => pixel.ink > 1000 && pixel.clear > 1000 && pixel.width === 256 && pixel.height === 256));
      const geometry = await page.locator('.stamp-path-list').evaluate(list => {
        const nodes = [...list.querySelectorAll('.stamp-path-node')].map(el => el.getBoundingClientRect());
        return {
          overflow: document.documentElement.scrollWidth > innerWidth,
          overlap: nodes.some((a, i) => nodes.slice(i + 1).some(b => Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top))),
          smallest: Math.min(...nodes.map(node => node.width)),
        };
      });
      assert.equal(geometry.overflow, false); assert.equal(geometry.overlap, false); assert.ok(geometry.smallest >= 68);
      const navRows = await page.locator('.bottom-nav .nav-btn').evaluateAll(buttons => buttons.map(button => Math.round(button.getBoundingClientRect().top)));
      assert.equal(navRows.length, 5); assert.equal(new Set(navRows).size, 1);
      assert.equal(await page.locator('.stamp-path-step.is-reward').count(), 2);
      await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
      await page.screenshot({ path: path.join(output, `stamps-${width}.png`), fullPage: true });
      await page.locator('.stamp-path-step.is-claimable .stamp-path-node').click();
      await page.locator('#rewardChoiceForm').waitFor();
      assert.equal(await page.evaluate(() => festivalWeb.coupons().length), 0);
      await page.evaluate(async () => { await festivalWeb.chooseReward('photo', 3); navigateTo('stamps'); });
      assert.equal(await page.locator('.stamp-path-step.is-issued').count(), 2);
      assert.equal(await page.evaluate(() => festivalWeb.coupons().length), 2);
      assert.equal(await page.locator('.stamp-club-artwork').count(), 20);
      await page.locator('.stamp-path-step:not(.is-reward) .stamp-path-node[data-list-select]').first().click();
      assert.equal(await page.evaluate(() => state.route), 'detail');
      assert.deepEqual(errors, []);
      results.push({ width, images: 20, transparentNonblank: true, vouchers: 2, geometry, passed: true });
      await context.close();
    }
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    await context.route('**/assets/stamps/*.png', route => route.fulfill({ status: 404, body: '' }));
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/tests/stamp-ui-preview.html?demo=1&completed=3`);
    await showClubVisits(page, 3);
    await page.waitForFunction(() => document.querySelectorAll('.stamp-club-artwork').length === 0);
    assert.equal(await page.locator('.has-club-stamp').count(), 0);
    assert.equal(await page.locator('.is-earned').count(), 3);
    assert.equal(await page.locator('.is-earned .stamp-path-face').first().evaluate(el => getComputedStyle(el).visibility), 'visible');
    await page.screenshot({ path: path.join(output, 'fallback-390.png') });
    await page.locator('.is-claimable .stamp-path-node').click();
    await page.locator('#rewardChoiceForm').waitFor();
    assert.deepEqual(errors, []);
    results.push({ failedImages: 3, fallbackVisible: true, voucherAction: true, passed: true });
    await context.close();
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ results, externalRequests: 'blocked', databaseWrites: 0 }, null, 2));
    console.log(`${results.length} club stamp layouts/flows passed`);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
