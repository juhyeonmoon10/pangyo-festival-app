const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const output = path.resolve(__dirname, '../artifacts/web-redesign');
const base = process.env.FESTIVAL_TEST_URL || 'http://127.0.0.1:5186/';

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  const reports = [];
  try {
    for (const width of [320, 390, 430, 1024]) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: true, isMobile: width < 500 });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('https://**/*', route => route.fulfill({ json: [] }));
      const capture = async name => {
        await page.evaluate(() => Promise.race([Promise.all([...document.images].map(i => i.decode().catch(() => {}))), new Promise(r => setTimeout(r, 250))]));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}/${name} overflow`);
        assert.deepEqual(await page.locator('img').evaluateAll(nodes => nodes.filter(n => n.complete && !n.naturalWidth).map(n => n.src)), []);
        await page.screenshot({ path: path.join(output, `${width}-${name}.png`), fullPage: true, animations: 'disabled' });
        console.log(`${width}/${name}`);
      };
      await page.goto(`${base}?demo=1`);
      await capture('login');
      await page.locator('#googleLogin').click();
      await page.waitForSelector('.web-home');
      assert.equal(await page.locator('.bottom-nav').count(), 0, 'home must not have bottom navigation');
      await capture('home');
      await page.locator('.web-shortcuts [data-route="map"]').click();
      await page.locator('[data-floor="2"]').click();
      assert.equal(await page.locator('.indoor-floors .floor-tab').count(), 4);
      const sheet = await page.locator('#sheet').boundingBox();
      const nav = await page.locator('.bottom-nav').boundingBox();
      assert.ok(Math.abs(sheet.y + sheet.height - nav.y) < 2, 'sheet must touch nav');
      await capture('map');
      await page.locator('#sheetToggle').click();
      await capture('map-list');
      await page.evaluate(() => { state.sheetLevel = 'peek'; state.sheetOpen = false; render(); });
      await page.locator('#mapZoomIn').click();
      assert.ok(await page.evaluate(() => state.mapZoom > 1));
      await page.locator('#mapSearchBtn').click();
      const input = page.locator('#searchScreenInput');
      await input.fill('1학년 1반');
      const spaced = await page.locator('#searchResultList [data-list-select]').evaluateAll(nodes => nodes.map(n => n.dataset.listSelect));
      await input.fill('1학년1반');
      assert.deepEqual(await page.locator('#searchResultList [data-list-select]').evaluateAll(nodes => nodes.map(n => n.dataset.listSelect)), spaced);
      assert.ok(spaced.includes('g1-1'));
      await page.evaluate(async () => {
        const input = document.querySelector('#searchScreenInput');
        input.focus(); input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        input.value = '1학년'; input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
        const token = mockNfcTokenForTagId(state.db.booths.find(b => b.id === 'g1-1').nfcTagId);
        await nfcAdapter.scan(createNfcClaim(token, 'android-nfc'));
        if (document.querySelector('#searchScreenInput') !== input || document.activeElement !== input) throw Error('NFC broke IME input');
        input.value = '1학년1반'; input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      });
      assert.equal(await page.evaluate(() => festivalWeb.completed().length), 0);
      assert.equal(await page.evaluate(() => festivalWeb.waiting().length), 1);
      await capture('search');
      await page.evaluate(() => dismissNfcFeedback());
      await page.locator('#closeSearchScreen').click();
      await page.locator('.bottom-nav [data-route="stamps"]').click();
      assert.equal(await page.locator('.web-stamps [data-route="scan"]').count(), 0, 'stamp page must not show an NFC scan entry button');
      await capture('pending-stamp');
      await page.locator('[data-review-booth="g1-1"]').click();
      await page.locator('#submitReview').click();
      assert.match(await page.locator('#reviewFeedback').innerText(), /별점/);
      await page.locator('[data-rating="4"]').click();
      await page.locator('#submitReview').click();
      assert.equal(await page.evaluate(() => festivalWeb.completed().length), 1);
      assert.equal(await page.evaluate(() => festivalWeb.points()), 0);
      await capture('detail-rated');
      await page.locator('.bottom-nav [data-route="reviews"]').click();
      await capture('review-pending');
      await page.locator('[data-review-booth="g1-1"]').click();
      assert.equal(await page.locator('[data-rating="4"]').isDisabled(), true);
      await page.locator('#reviewContent').fill('한글 후기 임시저장 테스트');
      await page.locator('#saveReviewDraft').click();
      await page.locator('.bottom-nav [data-route="reviews"]').click();
      await page.locator('[data-review-booth="g1-1"]').click();
      assert.equal(await page.locator('#reviewContent').inputValue(), '한글 후기 임시저장 테스트');
      await page.evaluate(() => { submitReview(); submitReview(); });
      assert.equal(await page.evaluate(() => state.db.reviews.filter(r => r.userId === state.user.id && r.boothId === 'g1-1').length), 1);
      assert.equal(await page.evaluate(() => festivalWeb.points()), 10);
      await page.locator('.bottom-nav [data-route="reviews"]').click();
      await capture('review-done');
      assert.equal(await page.locator('.web-written').count(), 1);
      // Synthetic visits exercise the existing mock gateway; no shared DB writes occur.
      await page.evaluate(async () => {
        const booths = state.db.booths.filter(b => b.id !== 'g1-1' && ['open', 'crowded'].includes(b.status)).slice(0, 9);
        for (const booth of booths) {
          const token = mockNfcTokenForTagId(booth.nfcTagId);
          await nfcAdapter.scan(createNfcClaim(token, 'android-nfc'));
          dismissNfcFeedback(); goDetail(booth.id); state.reviewRating = 5;
          await submitReview();
        }
        navigateTo('stamps');
      });
      assert.equal(await page.evaluate(() => festivalWeb.completed().length), 10);
      assert.equal(await page.evaluate(() => festivalWeb.coupons().length), 2);
      await capture('stamp-board');
      await page.locator('.bottom-nav [data-route="vouchers"]').click();
      await capture('vouchers');
      await page.evaluate(() => {
        window.qrPayloads = [];
        const original = qrcode;
        window.qrcode = (...args) => {
          const qr = original(...args), add = qr.addData;
          qr.addData = value => { qrPayloads.push(value); return add.call(qr, value); };
          return qr;
        };
      });
      await page.locator('[data-voucher]').first().click();
      assert.equal(await page.locator('.web-qr-code svg').count(), 1);
      assert.equal(await page.locator('[data-demo-redeem]').count(), 0, 'student cannot redeem own voucher');
      await capture('voucher-qr');
      await page.keyboard.press('Escape');
      await page.locator('[data-voucher]').nth(1).click();
      assert.equal(await page.evaluate(() => qrPayloads[0].split(':')[1] !== qrPayloads[1].split(':')[1]), true);
      await page.keyboard.press('Escape');
      await page.evaluate(() => { festivalWeb.syncRewards(); festivalWeb.syncRewards(); });
      assert.equal(await page.evaluate(() => festivalWeb.coupons().length), 2);
      assert.equal(await page.evaluate(() => festivalWeb.points()), 10);
      await page.locator('.bottom-nav [data-route="home"]').click();
      await capture('home-with-records');
      await page.locator('[aria-label="내 정보"]').click();
      await capture('profile');
      await page.evaluate(() => navigateTo('scan'));
      assert.equal(await page.locator('.nfc-test-panel').count(), 0);
      await capture('nfc');
      await page.evaluate(() => navigateTo('home'));
      await page.goBack();
      assert.equal(await page.evaluate(() => state.route), 'scan');
      assert.deepEqual(errors, []);
      reports.push({ width, passed: true, noHomeNav: true, imePreserved: true, ratingRequired: true, deferredReview: true, uniqueVoucherQr: true, duplicateRewardsPrevented: true, screenshots: 15 });
      await page.close();
    }
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(reports, null, 2));
    console.log(JSON.stringify(reports, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
