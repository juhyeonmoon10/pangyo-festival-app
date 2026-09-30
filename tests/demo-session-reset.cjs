// Demo progress must not survive closing the app, while booth setup must.
// A new page in the same browser context is the closest match for reopening the installed app:
// local storage is shared, session storage is not.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const site = path.resolve(__dirname, '..');
const output = path.join(site, 'artifacts/demo-session-reset');
const entry = pathToFileURL(path.join(site, 'index.html')).href + '?demo=1';
const CUSTOM_TAG = 'NFC-SESSION-TEST';

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  const report = [];
  try {
    for (const width of [390, 1024]) {
      const context = await browser.newContext({ viewport: { width, height: 844 } });
      const errors = [];
      context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
      await context.route('https://**/*', route => route.fulfill({ json: [] }));

      const first = await context.newPage();
      await first.goto(entry);
      await first.locator('#adminLogin').click();
      await first.waitForSelector('.bottom-nav');

      // Earn one demo stamp through the mock tag panel.
      await first.evaluate(() => navigateTo('scan'));
      await first.locator('[data-nfc-test="NFC-G1-01"]').click();
      await first.waitForFunction(() => repo.stampsForUser(state.user.id).length === 1);
      // A first stamp offers a review action, so the banner waits for the user.
      await first.evaluate(() => dismissNfcFeedback());
      await first.waitForSelector('#nfcFeedback', { state: 'detached' });

      // Save booth setup, which has to outlive the session.
      await first.evaluate(() => navigateTo('admin'));
      await first.locator('[data-toggle-menu="admin-tab"]').click();
      await first.locator('[data-admin-tab="booths"]').click();
      await first.waitForSelector('#nfcManager');
      await first.locator('[data-nfc-select="g1-2"]').click();
      await first.locator('#nfcManagerTag').fill(CUSTOM_TAG);
      await first.locator('#nfcManagerSave').click();
      await first.waitForFunction(t => state.db.booths.find(b => b.id === 'g1-2').nfcTagId === t, CUSTOM_TAG);
      await first.screenshot({ path: path.join(output, `${width}-session-active.png`), fullPage: true, animations: 'disabled' });

      const split = await first.evaluate(() => ({
        durable: Object.keys(JSON.parse(localStorage.getItem(DB_KEY))),
        session: JSON.parse(sessionStorage.getItem(SESSION_KEY)),
      }));
      assert.equal(split.durable.includes('booths'), true, 'booth setup must be stored durably');
      for (const field of ['stamps', 'users', 'reviews', 'idempotencyRecords']) {
        assert.equal(split.durable.includes(field), false, `${field} must not be written to local storage`);
      }
      assert.equal(split.session.stamps.length, 1, 'the stamp belongs to the session');
      assert.equal(split.session.users.length >= 1, true);

      // Reloading the page is not closing the app. Signing in again finds the same session
      // account, and the stamp earned before the reload is still on it.
      await first.reload();
      await first.locator('#adminLogin').click();
      await first.waitForFunction(() => state.user && repo.stampsForUser(state.user.id).length === 1);

      // Reopening the app: same device storage, new session.
      const second = await context.newPage();
      await second.goto(entry);
      await second.waitForSelector('#googleLogin');
      assert.equal(await second.evaluate(() => state.user), null, 'a new run must start signed out');
      assert.equal(await second.evaluate(() => state.db.stamps.length), 0, 'demo stamps must not survive a restart');
      assert.equal(await second.evaluate(() => state.db.reviews.length), 0);
      assert.equal(await second.evaluate(t => state.db.booths.find(b => b.id === 'g1-2').nfcTagId === t, CUSTOM_TAG), true,
        'booth setup must survive a restart');
      await second.locator('#adminLogin').click();
      await second.waitForSelector('.bottom-nav');
      assert.equal(await second.evaluate(() => repo.stampsForUser(state.user.id).length), 0);
      await second.screenshot({ path: path.join(output, `${width}-after-restart.png`), fullPage: true, animations: 'disabled' });

      // The first run is untouched by the second: sessions are independent.
      assert.equal(await first.evaluate(() => repo.stampsForUser(state.user.id).length), 1);

      assert.deepEqual(errors, []);
      report.push({ width, passed: true, stampIsSessionOnly: true, setupPersists: true, reloadKeepsStamp: true });
      await context.close();
    }
  } finally { await browser.close(); }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
})().catch(error => { console.error(error); process.exitCode = 1; });
