const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const { PROJECT_URL, CLUB_IDS } = require('../supabase-catalog.js');
const base = process.env.FESTIVAL_TEST_URL || 'http://127.0.0.1:5186/';
const output = path.resolve(__dirname, '../artifacts/web-redesign');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  const checks = [];
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('https://**/*', r => r.fulfill({ json: [] }));
    await page.goto(`${base}?demo=1`);
    await page.locator('#googleLogin').click();
    await page.evaluate(async () => {
      const booth = state.db.booths.find(b => b.id === 'g1-1');
      await nfcAdapter.scan(createNfcClaim(mockNfcTokenForTagId(booth.nfcTagId), 'android-nfc'));
      dismissNfcFeedback(); goDetail(booth.id); state.reviewRating = 4;
      window.originalWriteSessionStorage = writeSessionStorage;
      writeSessionStorage = () => false;
      await submitReview();
    });
    assert.equal(await page.evaluate(() => festivalWeb.completed().length), 0);
    assert.match(await page.locator('#reviewFeedback').innerText(), /저장 공간/);
    await page.locator('#reviewContent').fill('저장 실패 중에도 보존할 글');
    await page.locator('#saveReviewDraft').click();
    assert.match(await page.locator('#reviewFeedback').innerText(), /저장 공간/);
    assert.equal(await page.locator('#reviewContent').inputValue(), '저장 실패 중에도 보존할 글');
    await page.evaluate(() => { writeSessionStorage = originalWriteSessionStorage; });
    checks.push('Failed storage neither awards a stamp nor claims draft success');
    await page.locator('#saveReviewDraft').click();
    await page.reload();
    await page.locator('#googleLogin').click();
    await page.evaluate(() => goDetail('g1-1'));
    assert.equal(await page.locator('#reviewContent').inputValue(), '저장 실패 중에도 보존할 글');
    assert.equal(await page.evaluate(() => state.reviewRating), 4);
    checks.push('Unsubmitted rating and text survive reload in the same tab');
    await page.evaluate(() => {
      window.__nfcSessions = [];
      window.NDEFReader = class {
        constructor() { __nfcSessions.push(this); }
        async scan({ signal }) { this.signal = signal; }
      };
      navigateTo('scan');
    });
    await page.locator('#webNfcScan').click();
    assert.equal(await page.evaluate(() => __nfcSessions.length), 1);
    await page.evaluate(() => navigateTo('home'));
    assert.equal(await page.evaluate(() => __nfcSessions[0].signal.aborted), true);
    await page.evaluate(() => {
      window.NDEFReader = class { async scan() { throw new DOMException('Denied', 'NotAllowedError'); } };
      navigateTo('scan');
    });
    await page.locator('#webNfcScan').click();
    assert.match(await page.locator('#webNfcStatus').innerText(), /권한/);
    checks.push('Web NFC scan aborts on navigation and displays permission denial');
    await page.evaluate(async () => { await resetLogin(); adminLogin(); goDetail('g1-1'); });
    await page.locator('.web-program-editor summary').click();
    await page.locator('#program-title').fill('합성 프로그램 <안전 확인>');
    await page.locator('#program-description').fill('실제 행사 안내가 아닌 자동 테스트용 소개입니다.');
    await page.locator('#program-hours').fill('10:00 ~ 12:00');
    await page.locator('#program-duration').fill('약 10분');
    await page.locator('#program-participation').fill('현장 접수');
    await page.locator('#program-materials').fill('없음');
    await page.locator('#programEditor button[type="submit"]').click();
    assert.equal(await page.locator('.web-program h3').innerText(), '합성 프로그램 <안전 확인>');
    assert.equal(await page.locator('.web-program h3 > *').count(), 0, 'program content is escaped');
    await page.screenshot({ path: path.join(output, '390-program-filled.png'), fullPage: true });
    await page.reload();
    await page.evaluate(() => { adminLogin(); goDetail('g1-1'); });
    assert.match(await page.locator('.web-program').innerText(), /합성 프로그램/);
    checks.push('Admin-only program editor persists locally and escapes markup');
    // Only synthetic test fixtures mint coupons here, never a production server.
    await page.evaluate(() => {
      const coupon = { id: 'test-coupon', target: 5, title: '테스트 쿠폰', expiresAt: new Date(Date.now() + 86400000).toISOString(), redeemedAt: null };
      writeSessionStorage(`festival-web-demo:${state.user.id}`, JSON.stringify({ points: {}, coupons: [coupon] }));
      navigateTo('vouchers');
      window.realNow = Date.now;
    });
    await page.locator('[data-voucher]').click();
    await page.evaluate(() => { Date.now = () => realNow() + 61000; });
    await page.waitForFunction(() => document.querySelector('.web-qr-time')?.textContent.includes('만료'));
    assert.equal(await page.locator('.web-qr-code > svg').count(), 0);
    assert.equal(await page.locator('[data-demo-redeem]').isDisabled(), true);
    await page.locator('[data-qr-refresh]').click();
    assert.equal(await page.locator('.web-qr-code svg').count(), 1);
    await page.locator('[data-demo-redeem]').click();
    assert.equal(await page.locator('.web-qr-dialog').count(), 0);
    await page.locator('[data-voucher-filter="history"]').click();
    assert.equal(await page.locator('.web-coupon button').innerText(), '사용 완료');
    await page.evaluate(() => { Date.now = realNow; });
    checks.push('QR expires, refreshes and is consumed once by demo administrator only');
    assert.deepEqual(errors, []);
    await page.close();

    const server = await browser.newPage({ viewport: { width: 320, height: 844 } });
    const uid = 'a0000000-0000-4000-8000-000000000001';
    const encode = x => Buffer.from(JSON.stringify(x)).toString('base64url');
    const jwt = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: uid, exp: 4102444800, role: 'authenticated', iss: PROJECT_URL + '/auth/v1' })}.fixture`;
    let rating = null;
    const calls = [];
    const serverErrors = [];
    server.on('pageerror', e => serverErrors.push(e.message));
    await server.addInitScript(({ jwt, uid }) => localStorage.setItem('pangyo-google-session-v1', JSON.stringify({ access_token: jwt, refresh_token: 'fixture', token_type: 'bearer', expires_at: 4102444800, user: { id: uid } })), { jwt, uid });
    await server.route('https://**/*', async route => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.origin !== PROJECT_URL) return route.abort();
      const endpoint = url.pathname.split('/').pop();
      calls.push(endpoint);
      const summary = () => ({ boothKey: '글빛누리', count: rating ? 1 : 0, average: rating ? '4.0' : null, myRating: rating,
        reviews: rating ? [{ rating, content: '', mine: true, author: '테○○', createdAt: '2026-09-29T00:00:00Z' }] : [] });
      if (endpoint === 'booths') return route.fulfill({ json: Object.values(CLUB_IDS).map(id => ({ id, name: id, rating: 0, position: '' })) });
      if (endpoint === 'festival_nfc_profile') return route.fulfill({ json: { id: 1, authUserId: uid, name: '테스트', email: 'test@example.invalid', studentNumber: '21001', needsProfile: false, isAdmin: false, completedBooths: ['글빛누리'] } });
      if (endpoint === 'festival_my_reviews') return route.fulfill({ json: rating ? ['글빛누리'] : [] });
      if (endpoint === 'festival_booth_reviews') return route.fulfill({ json: summary() });
      if (endpoint === 'festival_review_submit') { rating = req.postDataJSON().p_rating; return route.fulfill({ json: { result: 'SAVED', ...summary() } }); }
      if (endpoint === 'logout') return route.fulfill({ status: 204 });
      return route.fulfill({ status: 500, json: { message: 'Unexpected request in isolated test' } });
    });
    await server.goto(base);
    await server.waitForSelector('.web-home');
    assert.equal(await server.evaluate(() => isServerMode()), true);
    await server.evaluate(() => goDetail('g1-1'));
    await server.waitForFunction(() => serverReviewState('g1-1')?.status === 'ready');
    await server.locator('[data-rating="4"]').click();
    await server.locator('#submitReview').click();
    await server.waitForFunction(() => festivalWeb.completed().length === 1);
    await server.locator('#reviewContent').fill('나중에 쓰는 후기');
    await server.locator('#submitReview').click();
    assert.match(await server.locator('#reviewFeedback').innerText(), /임시저장/);
    assert.equal(calls.filter(c => c === 'festival_review_submit').length, 1, 'must not send unsupported update RPC');
    await server.evaluate(() => navigateTo('vouchers'));
    assert.equal(await server.locator('[data-voucher]').count(), 0);
    assert.equal(await server.evaluate(() => festivalWeb.points()), null);
    assert.match(await server.locator('.web-empty').innerText(), /준비/);
    assert.equal(calls.some(c => /users|redeem|coupon|points|admin_issue/.test(c)), false);
    await server.screenshot({ path: path.join(output, '320-server-voucher-gated.png'), fullPage: true });
    await server.evaluate(() => navigateTo('profile'));
    await server.locator('button[data-route="login"]').click();
    await server.waitForSelector('#googleLogin');
    await server.goBack();
    assert.equal(await server.evaluate(() => state.user), null);
    assert.deepEqual(serverErrors, []);
    checks.push('Mocked server: existing rating RPC works, later text stays a draft, production points/QR never fabricated');
    checks.push('Logout and browser back cannot restore the authenticated user');
    await server.close();
    fs.writeFileSync(path.join(output, 'boundaries-report.json'), JSON.stringify({ passed: true, checks, sharedNetworkRequests: 0 }, null, 2));
    console.log(JSON.stringify(checks, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
