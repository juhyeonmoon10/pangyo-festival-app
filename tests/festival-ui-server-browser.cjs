// Presentation-only checks. All network requests are intercepted; writes are forbidden.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const { PROJECT_URL, CLUB_IDS } = require('../supabase-catalog.js');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts/festival-ui-1.4/server');
const uid = 'a0000000-0000-4000-8000-000000000001';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: uid, exp: 4102444800, role: 'authenticated' })}.fixture`;
const event = { name: '2026 판교고 축제', state: 'open', review_points: 10, version: 1 };
const catalog = {
  event,
  items: [{ key: '글빛누리', name: '글빛누리', status: 'open', floor: 2, location: '2층 1-1', description: '독서 체험 프로그램', version: 1 }],
};
const rule = { id: 'fixture-rule', title: '축제 간식 교환권', target: 5, stock: 100, issued: 10, enabled: true, version: 1, expires_at: '2099-12-31T00:00:00Z' };
const voucher = { id: 'fixture-voucher', title: rule.title, state: 'available', expiresAt: rule.expires_at };
const mine = { ready: true, points: 10, reviews: [], visits: [], vouchers: [voucher], rules: [rule], event };
const results = [];

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  try {
    for (const width of [320, 390, 430, 1024]) {
      const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width < 500, hasTouch: width < 500 });
      await context.addInitScript(({ uid, jwt }) => localStorage.setItem('pangyo-google-session-v1', JSON.stringify({
        access_token: jwt, refresh_token: 'fixture', token_type: 'bearer', expires_at: 4102444800, expires_in: 3600, user: { id: uid },
      })), { uid, jwt });
      const page = await context.newPage();
      const errors = [], unexpected = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.protocol === 'file:') return route.continue();
        let value;
        if (url.origin === PROJECT_URL) {
          if (url.pathname === '/rest/v1/booths') value = Object.values(CLUB_IDS).map(id => ({ id, name: id, rating: 0, position: '' }));
          if (url.pathname === '/rest/v1/rpc/festival_nfc_profile') value = { id: 1, authUserId: uid, name: '화면 검증', email: 'fixture@example.invalid', studentNumber: '21001', needsProfile: false, isAdmin: true, completedBooths: [] };
          if (url.pathname === '/rest/v1/rpc/festival_my_reviews') value = [];
          if (url.pathname === '/rest/v1/rpc/festival_ops_read') {
            const { p_kind: kind } = request.postDataJSON();
            value = kind === 'catalog' ? catalog : kind === 'me' ? mine
              : kind === 'dashboard' ? { participants: 100, visits: 200, reviews: 50, issued: 10, used: 2 }
              : kind === 'rules' ? { items: [rule] }
              : kind === 'participants' ? { items: [{ id: 1, name: '화면 검증', visits: 2, points: 10 }] }
              : { items: [] };
          }
        }
        if (value !== undefined) return route.fulfill({ json: value });
        unexpected.push(url.pathname);
        return route.abort();
      });
      const capture = async name => {
        await page.waitForTimeout(100);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}/${name} overflow`);
        await page.screenshot({ path: path.join(output, `${width}-${name}.png`), fullPage: true, animations: 'disabled' });
      };
      await page.goto(pathToFileURL(path.join(root, 'index.html')).href);
      await page.waitForFunction(() => festivalOpsUI.snapshot()?.ready);
      await capture('home');
      await page.evaluate(() => navigateTo('profile'));
      await capture('profile');
      await page.evaluate(() => navigateTo('vouchers'));
      await page.waitForSelector('[data-ops-qr]');
      await capture('vouchers');
      await page.evaluate(() => navigateTo('admin'));
      await page.waitForSelector('#opsTab');
      await capture('admin-dashboard');
      for (const tab of ['catalog', 'participants', 'visits', 'ledger', 'rules', 'vouchers', 'audit', 'nfc']) {
        await page.selectOption('#opsTab', tab);
        await page.waitForFunction(value => document.querySelector('#opsTab')?.value === value, tab);
        await capture(`admin-${tab}`);
      }
      assert.equal(await page.locator('.bottom-nav button').count(), 4);
      assert.deepEqual(errors, []);
      assert.deepEqual(unexpected, [], 'No unmocked requests or mutations');
      results.push({ width, passed: true, adminTabs: 9, serverWrites: 0, remoteRequests: 0 });
      await context.close();
    }
  } catch (error) {
    results.push({ passed: false, error: error.stack });
    process.exitCode = 1;
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ environment: 'Static file with intercepted fixture responses, no production calls', results }, null, 2));
    console.log(JSON.stringify(results, null, 2));
  }
})();
