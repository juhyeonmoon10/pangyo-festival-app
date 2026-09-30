// Shows exactly what the installed app asks the sign-in service to come back to.
// The page is served from the same origin the APK uses, so the result matches the real app.
// Nothing leaves this machine: the provider origin is intercepted and the sign-in never runs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const { PROJECT_URL, CLUB_IDS } = require('../supabase-catalog.js');
const site = path.resolve(__dirname, '..');
const APP_ORIGIN = 'https://appassets.androidplatform.net';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.webp': 'image/webp', '.png': 'image/png', '.txt': 'text/plain', '.json': 'application/json' };

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
  let authorizeUrl = null;
  try {
    // Serve the packaged web assets from the APK's own origin.
    await page.route(`${APP_ORIGIN}/**`, route => {
      const rel = new URL(route.request().url()).pathname.replace(/^\/assets\/site\//, '');
      const file = path.join(site, rel);
      if (!file.startsWith(site) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      route.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(file)] || 'application/octet-stream' });
    });
    await page.route(`${PROJECT_URL}/**`, route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/auth/v1/authorize') {
        authorizeUrl = url;
        return route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>stub</body></html>' });
      }
      if (url.pathname === '/rest/v1/booths') {
        return route.fulfill({ json: Object.values(CLUB_IDS).map(id => ({ id, name: id, rating: 0, position: '' })) });
      }
      return route.fulfill({ status: 404, json: { message: 'not stubbed' } });
    });

    await page.goto(`${APP_ORIGIN}/assets/site/index.html`);
    await page.waitForSelector('#googleLogin');
    assert.equal(await page.evaluate(() => isServerMode()), true, 'the app must open in server mode');
    await page.locator('#googleLogin').click();
    await page.waitForFunction(() => true);
    for (let i = 0; i < 50 && !authorizeUrl; i++) await page.waitForTimeout(100);

    assert.ok(authorizeUrl, 'the app never reached the sign-in service');
    const redirectTo = authorizeUrl.searchParams.get('redirect_to');
    console.log('앱이 실행되는 주소   :', APP_ORIGIN);
    console.log('로그인 요청 주소     :', authorizeUrl.origin + authorizeUrl.pathname);
    console.log('provider             :', authorizeUrl.searchParams.get('provider'));
    console.log('돌아올 주소          :', redirectTo);
    console.log('PKCE code_challenge  :', authorizeUrl.searchParams.get('code_challenge') ? '있음' : '없음');
    assert.equal(redirectTo, 'pangyofestival://auth/callback',
      `앱이 요청하는 복귀 주소가 예상과 다릅니다: ${redirectTo}`);
    console.log('\n결과: 앱은 올바른 복귀 주소를 보냅니다. 다른 사이트가 열린다면 서버의 허용 목록 문제입니다.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error.message || error); process.exitCode = 1; });
