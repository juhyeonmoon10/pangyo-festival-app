const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = `http://127.0.0.1:${Number(process.env.REWARD_PREVIEW_PORT || 5194)}`;
const output = path.resolve(__dirname, '../artifacts/ink-stamp');
fs.mkdirSync(output, { recursive: true });

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const results = [];
  try {
    for (const width of [320, 390, 430, 1024]) {
      const context = await browser.newContext({ viewport: { width, height: 844 } });
      await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const response = await page.goto(`${base}/tests/stamp-ui-preview.html?demo=1&completed=9&long=1`);
      assert.equal(response.status(), 200);
      await page.evaluate(async () => {
        await festivalWeb.chooseReward('photo', 3);
        render();
      });
      assert.equal(await page.locator('.stamp-path-step.is-issued').count(), 2);
      assert.equal(await page.locator('.stamp-path-step.is-claimable').count(), 1);
      assert.equal(await page.locator('.stamp-visit-history').getAttribute('open'), null);
      assert.equal(await page.locator('.reward-choice-section').count(), 0);
      const palette = await page.evaluate(() => {
        const color = selector => getComputedStyle(document.querySelector(selector)).color;
        const fill = selector => getComputedStyle(document.querySelector(selector)).backgroundColor;
        const primary = getComputedStyle(document.body).getPropertyValue('--primary').trim();
        const dark = getComputedStyle(document.body).getPropertyValue('--primary-dark').trim();
        const swatch = document.createElement('span'); document.body.append(swatch);
        swatch.style.color = primary; const primaryRgb = getComputedStyle(swatch).color;
        swatch.style.color = dark; const inkRgb = getComputedStyle(swatch).color; swatch.remove();
        return { primaryRgb, inkRgb, stamp: color('.is-earned:not(.is-reward) .stamp-path-node'), claim: fill('.is-claimable .stamp-path-node'), font: getComputedStyle(document.querySelector('.stamp-path-node')).fontFamily };
      });
      assert.equal(palette.stamp, palette.inkRgb);
      assert.equal(palette.claim, palette.primaryRgb);
      const geometry = await page.locator('.stamp-path-list').evaluate(list => {
        const nodes = [...list.querySelectorAll('.stamp-path-node')].map(el => el.getBoundingClientRect());
        const overlap = nodes.some((a,i) => nodes.slice(i+1).some(b => Math.min(a.right,b.right)>Math.max(a.left,b.left) && Math.min(a.bottom,b.bottom)>Math.max(a.top,b.top)));
        return { overlap, smallest: Math.min(...nodes.map(r=>r.width)), overflow: document.documentElement.scrollWidth > innerWidth, first: nodes[0].x, last: nodes.at(-1).y, height:innerHeight };
      });
      assert.equal(geometry.overlap, false);
      assert.equal(geometry.overflow, false);
      assert.ok(geometry.smallest >= 68);
      assert.ok(geometry.last > geometry.height, 'not all stamps squeezed into the first viewport');
      await page.screenshot({ path: path.join(output, `stamps-${width}.png`) });
      const history = page.locator('.stamp-visit-history');
      await history.locator('summary').scrollIntoViewIfNeeded();
      await history.locator('summary').focus();
      await page.keyboard.press('Enter');
      assert.equal(await history.getAttribute('open'), '');
      assert.equal(await history.locator('.web-visit').count(), 9);
      assert.equal(await history.locator('[data-route=reviews]').count(), 1);
      await page.keyboard.press('Enter');
      assert.equal(await history.getAttribute('open'), null);
      await page.evaluate(async () => { await festivalWeb.chooseReward('food', 9); render(); });
      assert.equal(await page.locator('.stamp-path-step.is-issued').count(), 3);
      assert.equal(await page.locator('.stamp-path-step.is-claimable').count(), 0);
      assert.equal(await page.locator('.stamp-voucher-shortcut > i').count(), 0);
      await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
      await page.screenshot({ path: path.join(output, `received-${width}.png`) });
      await page.locator('.bottom-nav [data-route=home]').click();
      await page.locator('.home-stamp-card').waitFor();
      assert.equal(await page.locator('.punch.on').first().evaluate(el=>getComputedStyle(el).color), palette.inkRgb);
      await page.screenshot({ path: path.join(output, `home-${width}.png`) });
      await page.locator('.web-map-action').click();
      await page.locator('.map-stage').waitFor();
      assert.equal(await page.locator('.floor-tab.active').evaluate(el=>getComputedStyle(el).backgroundColor), palette.primaryRgb);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: path.join(output, `map-${width}.png`) });
      assert.deepEqual(errors, []);
      results.push({ width, palette, geometry, passed: true });
      await context.close();
    }
    const context = await browser.newContext({ viewport: { width: 320, height: 740 }, reducedMotion: 'reduce' });
    await context.route('**/*', route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
    const page=await context.newPage();
    await page.goto(`${base}/tests/stamp-ui-preview.html?demo=1&completed=8&pending=1`);
    assert.equal(await page.locator('.stamp-rating-pending .web-visit').count(), 1);
    const next=page.locator('.stamp-path-node[aria-current=step]');
    assert.match(await next.getAttribute('aria-label'), /별점 남기기/);
    assert.equal(await next.evaluate(el=>getComputedStyle(el).transitionDuration), '0s');
    await next.click();
    await page.locator('#reviewContent').waitFor();
    results.push({ pendingReview: true, reducedMotion: true, passed: true });
    await context.close();
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ results, externalRequests: 'blocked', serverWrites: 0 }, null, 2));
    console.log(`${results.length} ink stamp layouts/flows passed`);
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
