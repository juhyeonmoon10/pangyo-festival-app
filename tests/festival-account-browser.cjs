const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const { PROJECT_URL, CLUB_IDS } = require('../supabase-catalog.js');
const site = path.resolve(__dirname, '..');
const output = path.join(site, 'artifacts/nfc-server');
const uid = 'a0000000-0000-4000-8000-000000000001';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: uid, exp: 4102444800, role: 'authenticated', iss: PROJECT_URL + '/auth/v1' })}.fixture`;
const token = n => `nf1.${n}.${'a'.repeat(64)}`;
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const report = [];
  try {
    for (const width of [320,390,430]) {
      const page = await browser.newPage({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true });
      const errors = [], requests = []; let completed = [], fail = false, needsProfile = false, admin = false;
      const reviews = new Map(); // booth enum -> [{ rating, content, mine }]
      page.on('pageerror', e => errors.push(e.message));
      const profile = () => ({ id: 1, authUserId: uid, name: '<test>', email: 'test@example.invalid', studentNumber: '21001', needsProfile, isAdmin: admin, completedBooths: completed });
      const summary = booth => {
        const rows = reviews.get(booth) || [];
        const mine = rows.find(row => row.mine);
        return { boothKey: booth, count: rows.length,
          average: rows.length ? (rows.reduce((sum, row) => sum + row.rating, 0) / rows.length).toFixed(1) : null,
          myRating: mine ? mine.rating : null,
          reviews: rows.map(row => ({ rating: row.rating, content: row.content, author: row.mine ? '테○○' : '김○○', mine: row.mine, createdAt: '2026-09-11T00:00:00.000Z' })) };
      };
      await page.addInitScript(({ jwt, uid }) => {
        localStorage.setItem('pangyo-google-session-v1', JSON.stringify({ access_token: jwt, refresh_token: 'fixture', token_type: 'bearer', expires_at: 4102444800, expires_in: 3600, user: { id: uid } }));
      }, { jwt, uid });
      await page.route(`${PROJECT_URL}/**`, async route => {
        const req = route.request(), pathname = new URL(req.url()).pathname;
        requests.push({ pathname, method: req.method() });
        if (pathname === '/rest/v1/booths') return route.fulfill({ json: Object.values(CLUB_IDS).map(id => ({ id, name: id, rating: 0, position: '' })) });
        assert.equal(req.headers().authorization, `Bearer ${jwt}`);
        if (pathname === '/rest/v1/rpc/festival_nfc_profile') return route.fulfill({ json: profile() });
        if (pathname === '/rest/v1/rpc/festival_nfc_claim') {
          if (fail) return route.fulfill({ status: 503, json: { message: 'fixture unavailable' } });
          const booth = req.postDataJSON().p_token === token('b') ? '매커니즘' : '글빛누리';
          const duplicate = completed.includes(booth);
          if (!duplicate) completed.push(booth);
          return route.fulfill({ json: { result: duplicate ? 'ALREADY_EARNED' : 'EARNED', boothKey: booth, completedBooths: [...completed] } });
        }
        if (pathname === '/rest/v1/rpc/festival_my_reviews') {
          return route.fulfill({ json: [...reviews.entries()].filter(([, rows]) => rows.some(row => row.mine)).map(([booth]) => booth) });
        }
        if (pathname === '/rest/v1/rpc/festival_booth_reviews') {
          return route.fulfill({ json: summary(req.postDataJSON().p_booth) });
        }
        if (pathname === '/rest/v1/rpc/festival_review_submit') {
          const { p_booth: booth, p_rating: rating, p_content: content } = req.postDataJSON();
          if (!completed.includes(booth)) return route.fulfill({ status: 403, json: { message: 'VISIT_REQUIRED' } });
          const rows = reviews.get(booth) || [];
          if (rows.some(row => row.mine)) return route.fulfill({ status: 409, json: { message: 'ALREADY_REVIEWED' } });
          reviews.set(booth, [...rows, { rating, content: content ?? null, mine: true }]);
          return route.fulfill({ json: { result: 'SAVED', ...summary(booth) } });
        }
        if (pathname === '/rest/v1/rpc/festival_nfc_admin_issue') {
          const { p_booth: booth, p_valid_minutes: minutes } = req.postDataJSON();
          if (!admin) return route.fulfill({ status: 403, json: { message: 'ADMIN_REQUIRED' } });
          assert.equal(minutes, null);
          return route.fulfill({ json: { token: token('issued'), boothKey: booth, issuedAt: '2026-09-30T00:00:00.000Z', expiresAt: null, validMinutes: null } });
        }
        if (pathname === '/auth/v1/logout') return route.fulfill({ status: 204 });
        throw Error(`Unexpected server request ${pathname}`);
      });
      const capture = async name => {
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow ${width} ${name}`);
        await page.screenshot({ path: path.join(output, `${width}-${name}.png`), fullPage: true, animations: 'disabled' });
      };
      const boothIdFor = key => page.evaluate(k => state.db.booths.find(booth => boothKeyFor(booth) === k)?.id, key);
      await page.goto(pathToFileURL(path.join(site, 'index.html')).href);
      await page.waitForSelector('.home-screen');
      assert.equal(await page.locator('h1 test').count(), 0);
      await capture('home');
      const before = await page.evaluate(() => localStorage.getItem(DB_KEY));
      fail = true;
      await page.evaluate(t => nfcAdapter.scan(createNfcClaim(t, 'android-nfc')), token('a'));
      assert.equal(await page.evaluate(() => repo.stampsForUser(state.user.id).length), 0);
      assert.equal(await page.locator('.stamp-pop').count(), 0);
      await capture('network-error');
      fail = false;
      await page.evaluate(async ts => { await Promise.all(ts.map(t => nfcAdapter.scan(createNfcClaim(t,'android-nfc')))); }, [token('a'),token('a'),token('b')]);
      assert.equal(await page.evaluate(() => repo.stampsForUser(state.user.id).length), 2);
      assert.equal(await page.evaluate(() => localStorage.getItem(DB_KEY)), before);
      await capture('second-stamp');

      // A booth without a recorded visit cannot be rated.
      const unvisited = await boothIdFor('인사이트');
      await page.evaluate(id => goDetail(id), unvisited);
      await page.waitForSelector('#boothReviewSection');
      await page.waitForFunction(() => !document.querySelector('[data-review-count]')?.textContent.includes('…'));
      assert.equal(await page.locator('#submitReview').isDisabled(), true);
      assert.equal(await page.locator('.review-compose.locked').count(), 1);

      // A visited booth accepts one rating with optional text, and only once.
      const visited = await boothIdFor('글빛누리');
      await page.evaluate(id => goDetail(id), visited);
      await page.waitForSelector('#boothReviewSection');
      await page.waitForFunction(() => document.querySelector('[data-review-count]')?.textContent === '0개');
      await page.locator('[data-rating="4"]').click();
      await page.locator('#reviewContent').fill('진짜 서버에 저장되는 후기');
      await page.locator('#submitReview').click();
      await page.waitForSelector('.review-guidance.success');
      assert.equal(await page.locator('.review').count(), 1);
      assert.equal(await page.locator('[data-review-average]').innerText(), '4.0');
      assert.equal(await page.locator('[data-review-count]').innerText(), '1개');
      assert.equal(await page.evaluate(() => localStorage.getItem(DB_KEY)), before, 'server reviews must not touch local demo storage');
      assert.equal(await page.evaluate(() => state.db.reviews.length), 0);
      await capture('review-saved');

      // Another student's review is shown under a masked name and never overwrites mine.
      reviews.set('글빛누리', [...reviews.get('글빛누리'), { rating: 5, content: '다른 학생 후기', mine: false }]);
      await page.evaluate(id => loadBoothReviews(id, { force: true }), visited);
      await page.waitForFunction(() => document.querySelectorAll('.review').length === 2);
      assert.equal(await page.locator('[data-review-average]').innerText(), '4.5');
      assert.equal((await page.locator('.review').first().innerText()).includes('○'), true);

      await page.evaluate(() => navigateTo('home'));
      await page.waitForSelector('.home-review-action');
      assert.match(await page.locator('.home-review-action small').innerText(), /별점을 기다리는 부스 1개/);
      await page.evaluate(() => navigateTo('stamps'));
      assert.equal(await page.locator('.pass-row.earned').count(), 2);
      assert.match(await page.locator('.reward-status').innerText(), /교환권은 발급되지/);
      await capture('pass');
      await page.reload();
      await page.waitForSelector('.home-screen');
      assert.equal(await page.evaluate(() => repo.stampsForUser(state.user.id).length), 2);
      assert.equal(await page.evaluate(() => canUseMockNfcTools()), false);
      assert.equal(requests.some(r => r.pathname === '/rest/v1/users'), false);
      assert.equal(await page.evaluate(() => isAdminUser()), false);
      await page.evaluate(() => navigateTo('admin'));
      assert.match(await page.locator('.screen h1').innerText(), /운영자 전용/);
      await page.evaluate(() => navigateTo('profile'));
      await capture('profile');

      // Operator tools appear only for an account the server marks as an administrator.
      admin = true;
      await page.reload();
      await page.waitForSelector('.home-screen');
      await page.evaluate(() => navigateTo('admin'));
      await page.waitForSelector('#serverAdminForm');
      await page.locator('#serverAdminBooth').selectOption(visited);
      assert.equal(await page.locator('#serverAdminMinutes').count(), 0);
      await page.locator('#serverAdminIssue').click();
      await page.waitForSelector('#serverAdminUrl');
      const issued = await page.locator('#serverAdminUrl').inputValue();
      assert.equal(issued, `pangyofestival://nfc#t=${token('issued')}`);
      assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('nf1.')), false, 'issued tokens must never be stored');
      await capture('admin-issue');

      await page.locator('.bottom-nav [data-route="profile"]').click();
      await page.locator('button[data-route="login"]').click();
      await page.waitForSelector('#googleLogin');
      assert.equal(await page.evaluate(() => state.user), null);
      assert.equal(await page.evaluate(() => localStorage.getItem('pangyo-google-session-v1')), null);

      // A sign-in that never comes back to the app must say so instead of failing silently.
      // This is what happens when the app's callback address is not registered with the provider
      // and the browser is sent to the project's default site instead.
      await page.evaluate(() => { signInStartedAt = Date.now(); document.dispatchEvent(new Event('visibilitychange')); });
      await page.waitForFunction(() => /앱으로 돌아오지 않았어요/.test(state.loginError), null, { timeout: 10000 });
      assert.match(await page.locator('.error-text').innerText(), /앱으로 돌아오지 않았어요/);
      await capture('login');
      assert.deepEqual(errors, []);
      report.push({ width, passed: true, checks: ['no optimistic stamp','two booths','duplicate','server reload','no local write','no mock admin','mobile layout','server review saved','masked author','visit required','operator issue','lost callback warned'] });
      await page.close();
    }
  } finally { await browser.close(); }
  fs.writeFileSync(path.join(output,'browser-report.json'), JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
})().catch(error => { console.error(error); process.exitCode = 1; });
