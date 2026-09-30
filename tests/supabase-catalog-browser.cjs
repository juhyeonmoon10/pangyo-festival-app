const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const { CLUB_IDS, PROJECT_URL } = require('../supabase-catalog.js');
const site = path.resolve(__dirname, '..');
const output = path.join(site, 'artifacts/supabase-catalog');
const fixtures = Object.values(CLUB_IDS).map((id, index) => ({ id, name: id, rating: index ? 0 : 4, position: '' }));

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const report = [];
  try {
    for (const width of [320, 390, 430]) {
      const page = await browser.newPage({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true });
      const errors = [], requests = [];
      let offline = false, hold = false, release;
      let responseRows = fixtures;
      page.on('pageerror', error => errors.push(error.message));
      await page.route(`${PROJECT_URL}/**`, async route => {
        const request = route.request();
        requests.push({ method: request.method(), path: new URL(request.url()).pathname });
        assert.equal(request.method(), 'GET');
        assert.equal(new URL(request.url()).pathname, '/rest/v1/booths');
        if (offline) return route.abort('internetdisconnected');
        if (hold) await new Promise(resolve => { release = resolve; });
        return route.fulfill({ json: responseRows });
      });
      const capture = async name => {
        await page.screenshot({ path: path.join(output, `${width}-${name}.png`), fullPage: true, animations: 'disabled' });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}-${name} horizontal overflow`);
      };
      await page.goto(pathToFileURL(path.join(site, 'index.html')).href + '?demo=1');
      await page.waitForFunction(() => publicCatalog.getSnapshot().status === 'ready');
      assert.match(await page.locator('[data-catalog-status]').innerText(), /20개/);
      assert.equal(await page.evaluate(() => OFFICIAL_CLUBS.every(club => publicCatalog.forClub(club.id))), true);
      await capture('login');
      await page.click('#googleLogin');
      await page.locator('.bottom-nav [data-route="map"]').click();
      await page.click('#mapSearchBtn');
      const search = page.locator('#searchScreenInput');
      await search.fill('1학년 1반');
      const spaced = await page.locator('.search-result-list [data-list-select]').evaluateAll(nodes => nodes.map(n => n.dataset.listSelect));
      await search.fill('1학년1반');
      assert.deepEqual(await page.locator('.search-result-list [data-list-select]').evaluateAll(nodes => nodes.map(n => n.dataset.listSelect)), spaced);
      const localBefore = await page.evaluate(() => localStorage.getItem(DB_KEY));
      hold = true;
      await page.evaluate(() => { window.testInput = document.querySelector('#searchScreenInput'); void publicCatalog.refresh(); });
      await page.waitForFunction(() => publicCatalog.getSnapshot().status === 'loading');
      await search.dispatchEvent('compositionstart');
      await search.fill('매커니즘');
      while (!release) await new Promise(resolve => setTimeout(resolve, 10));
      release();
      await page.waitForFunction(() => publicCatalog.getSnapshot().status === 'ready');
      assert.equal(await page.evaluate(() => window.testInput === document.querySelector('#searchScreenInput') && document.activeElement === window.testInput), true);
      assert.equal(await search.inputValue(), '매커니즘');
      await search.dispatchEvent('compositionend');
      assert.equal(await page.locator('.search-result-list [data-list-select="g1-2"]').count(), 1);
      assert.equal(await page.evaluate(() => localStorage.getItem(DB_KEY)), localBefore);
      hold = false;
      await capture('search');
      await search.fill('글빛누리');
      await page.locator('.search-result-list [data-list-select="g1-1"]').click();
      if (!await page.locator('.detail-screen').count()) await page.locator('[data-detail="g1-1"]').click();
      await page.waitForSelector('.detail-screen');
      assert.match(await page.locator('.detail-metrics [data-catalog-rating]').innerText(), /DB 4.0점/);
      assert.match(await page.locator('[data-catalog-position]').innerText(), /미등록/);
      assert.match(await page.locator('.review-heading').innerText(), /평가 · 앱을 닫으면 사라짐/);
      await capture('detail');
      const count = requests.length;
      await page.evaluate(() => { for (let n = 0; n < 20; n++) void publicCatalog.refresh(); });
      await page.waitForFunction(() => publicCatalog.getSnapshot().status === 'ready');
      assert.equal(requests.length, count + 1);
      responseRows = fixtures.map(row => row.id === '글빛누리' ? { ...row, name: '<img src=x onerror="window.xss=true">', position: '<script>bad()</script>' } : row);
      await page.evaluate(() => publicCatalog.refresh());
      assert.equal(await page.evaluate(() => window.xss), undefined);
      assert.equal(await page.locator('[data-catalog-name] img').count(), 0);
      assert.match(await page.locator('.title [data-catalog-name]').innerText(), /<img/);
      responseRows = fixtures;
      await page.evaluate(() => publicCatalog.refresh());
      offline = true;
      // VER.2 keeps the connection panel on the profile screen; the booth rating stays on detail.
      await page.evaluate(() => navigateTo('profile'));
      await page.locator('[data-refresh-catalog]').click();
      await page.waitForFunction(() => publicCatalog.getSnapshot().status === 'offline');
      assert.match(await page.locator('[data-catalog-status]').innerText(), /저장된/);
      await page.evaluate(() => goDetail('g1-1'));
      await page.waitForSelector('.detail-screen');
      assert.match(await page.locator('.detail-metrics [data-catalog-rating]').innerText(), /저장본/);
      await capture('offline');
      await page.reload();
      await page.waitForFunction(() => publicCatalog.getSnapshot().status === 'offline');
      assert.equal(await page.evaluate(() => publicCatalog.getSnapshot().rows.length), 20);
      assert.deepEqual(errors, []);
      report.push({ width, requests: requests.length, methods: [...new Set(requests.map(r => r.method))], passed: true });
      await page.close();
    }
    if (process.argv.includes('--live')) {
      const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
      const requests = [];
      page.on('request', request => {
        if (request.url().startsWith(PROJECT_URL)) requests.push({ method: request.method(), path: new URL(request.url()).pathname });
      });
      await page.goto(pathToFileURL(path.join(site, 'index.html')).href);
      await page.waitForFunction(() => publicCatalog.getSnapshot().status === 'ready', null, { timeout: 15000 });
      const snapshot = await page.evaluate(() => ({ status: publicCatalog.getSnapshot().status, count: publicCatalog.getSnapshot().rows.length }));
      assert.ok(snapshot.count > 0);
      assert.ok(requests.every(request => request.method === 'GET' && request.path === '/rest/v1/booths'));
      await page.screenshot({ path: path.join(output, '390-live-login.png'), fullPage: true });
      report.push({ live: true, ...snapshot, requests });
      await page.close();
    }
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
