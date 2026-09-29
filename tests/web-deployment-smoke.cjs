const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const base = new URL(process.env.FESTIVAL_DEPLOY_URL || 'https://pangyo-festival-app.vercel.app/');
assert.equal(base.protocol, 'https:');
const output = path.resolve(__dirname, '../artifacts/web-deployment');

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const report = { url: base.href, checkedAt: new Date().toISOString(), privatePaths: [], screens: [] };
  const response = await fetch(new URL('/deployment-info.json', base));
  assert.equal(response.status, 200);
  const release = await response.json();
  assert.equal(release.version, '1.2');
  if (process.env.FESTIVAL_DEPLOY_SHA) assert.equal(release.commit, process.env.FESTIVAL_DEPLOY_SHA);
  report.commit = release.commit;
  for (const [file, hash] of Object.entries(release.files)) {
    const resource = await fetch(new URL('/' + file, base));
    assert.equal(resource.status, 200, file);
    assert.equal(crypto.createHash('sha256').update(Buffer.from(await resource.arrayBuffer())).digest('hex'), hash, file);
  }
  report.verifiedAssets = Object.keys(release.files).length;
  for (const file of ['.env', 'README.md', 'nfc-server/install.sql', 'supabase/migrations/001_festival_core.sql', 'tests/web-redesign-browser.cjs', 'tools/build-web.cjs', 'api/health', 'api/nfc/claim']) {
    const resource = await fetch(new URL('/' + file, base));
    assert.equal(resource.status, 404, `Private/legacy route must not be published: ${file}`);
    report.privatePaths.push({ file, status: resource.status });
  }
  const nfc = await fetch(new URL('/nfc', base));
  assert.equal(nfc.status, 200);
  assert.match(await nfc.text(), /design-web/);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  try {
    for (const width of [320, 390, 430, 1024]) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: width < 500, hasTouch: true });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      // Exercise the actual public UI without reading or writing shared Supabase.
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        return url.origin === base.origin ? route.continue() : route.fulfill({ json: [] });
      });
      const capture = async name => {
        // Hidden sheet thumbnails use lazy loading and need not decode before a screenshot.
        await page.evaluate(() => Promise.race([
          Promise.all([...document.images].map(image => image.decode().catch(() => {}))),
          new Promise(resolve => setTimeout(resolve, 500)),
        ]));
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}/${name}`);
        assert.deepEqual(await page.locator('img').evaluateAll(images => images.filter(i => i.complete && !i.naturalWidth).map(i => i.src)), []);
        const screenshot = `${width}-${name}.png`;
        await page.screenshot({ path: path.join(output, screenshot), fullPage: true, animations: 'disabled' });
        report.screens.push(screenshot);
        console.log(`Verified ${width}/${name}`);
      };
      await page.goto(new URL('/?demo=1&v=web-1.2', base).href);
      await page.locator('#googleLogin').click();
      await page.waitForSelector('.web-home');
      assert.equal(await page.locator('.bottom-nav').count(), 0);
      await capture('home');
      await page.locator('.web-shortcuts [data-route="map"]').click();
      await page.locator('[data-floor="2"]').click();
      assert.equal(await page.locator('.indoor-floors .floor-tab').count(), 4);
      await capture('map');
      await page.locator('.bottom-nav [data-route="stamps"]').click();
      assert.equal(await page.locator('.web-stamps [data-route="scan"]').count(), 0, 'stamp page must not show an NFC scan entry button');
      await capture('stamps');
      await page.locator('.bottom-nav [data-route="vouchers"]').click();
      await capture('vouchers');
      await page.locator('.bottom-nav [data-route="reviews"]').click();
      await capture('reviews');
      assert.deepEqual(errors, []);
      await page.close();
    }
    const production = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await production.route('**/*', route => new URL(route.request().url()).origin === base.origin ? route.continue() : route.fulfill({ json: [] }));
    await production.goto(base.href);
    await production.waitForSelector('#googleLogin');
    assert.equal(await production.evaluate(() => isServerMode()), true);
    await production.screenshot({ path: path.join(output, 'production-login.png'), fullPage: true });
    report.productionLoginScreen = true;
    report.realGoogleLoginAndNfc = 'not exercised';
    report.sharedSupabaseRequests = 'intercepted; no shared DB access';
  } finally { await browser.close(); }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
