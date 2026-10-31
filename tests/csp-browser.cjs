// Serves the built site with the exact headers from .vercel/output/config.json and opens the
// student, demo and operator screens. Fails on any Content-Security-Policy violation, so a new
// inline script, remote script or blocked image shows up before it reaches production.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { build, output } = require('../tools/build-web.cjs');
const { PROJECT_URL } = require('../supabase-catalog.js');

build();
const config = JSON.parse(fs.readFileSync(path.join(output, 'config.json'), 'utf8'));
const headers = config.routes[0].headers;
const page = new RegExp(`^${config.routes.find(r => r.dest === '/index.html' && r.src !== '/nfc/?').src}$`);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.json': 'application/json', '.txt': 'text/plain' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let file = path.join(output, 'static', decodeURIComponent(url.pathname));
  if (!file.startsWith(path.join(output, 'static')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (!page.test(url.pathname) && url.pathname !== '/nfc') { res.writeHead(404, headers); return res.end(); }
    file = path.join(output, 'static/index.html');
  }
  res.writeHead(200, { ...headers, 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, channel: process.env.CHROME_PATH ? undefined : 'msedge', executablePath: process.env.CHROME_PATH });
  const violations = [], errors = [], visited = [];
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 850 }, isMobile: true, hasTouch: true });
    await context.addInitScript(() => {
      window.__csp = [];
      document.addEventListener('securitypolicyviolation', e => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    // Supabase answers empty: the student pages fall back to the public catalog view.
    await context.route(`${PROJECT_URL}/**`, route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    const tab = await context.newPage();
    tab.on('pageerror', e => errors.push(e.message));
    tab.on('console', m => { if (/Content Security Policy/i.test(m.text())) violations.push(m.text()); });
    const check = async name => {
      await tab.waitForTimeout(300);
      violations.push(...(await tab.evaluate(() => window.__csp.splice(0))).map(v => `${name}: ${v}`));
      visited.push(name);
    };
    // The inline <base> script runs (its hash is allowed): relative assets load from the root.
    await tab.goto(`${origin}/map`);
    await tab.waitForFunction(() => typeof render === 'function' && document.querySelector('base')?.getAttribute('href') === '/');
    await check('map');
    for (const route of ['home', 'stamps', 'vouchers', 'profile', 'login', 'notices']) {
      await tab.evaluate(r => { state.route = r; render(); }, route);
      await check(route);
    }
    // Demo mode draws QR codes as data: images and runs the operator screens without a server.
    await tab.goto(`${origin}/?demo=1`);
    await tab.waitForFunction(() => typeof render === 'function');
    for (const route of ['home', 'map', 'stamps', 'vouchers', 'profile', 'admin']) {
      await tab.evaluate(r => { state.route = r; render(); }, route);
      await check(`demo ${route}`);
    }
    const qr = tab.locator('[data-voucher]').first();
    if (await qr.count()) { await tab.evaluate(() => { state.route = 'vouchers'; render(); }); await qr.click(); await check('demo voucher QR'); }
    assert.deepEqual(violations, []);
    assert.deepEqual(errors, []);
    // The policy is live: an injected inline script and a remote image are both refused.
    await tab.evaluate(() => {
      document.body.append(Object.assign(document.createElement('script'), { textContent: 'window.__injected = 1' }));
      document.body.append(Object.assign(document.createElement('img'), { src: 'https://example.invalid/x.png' }));
    });
    await tab.waitForTimeout(300);
    assert.equal(await tab.evaluate(() => window.__injected), undefined);
    const refused = await tab.evaluate(() => window.__csp.join('\n'));
    assert.match(refused, /script-src/); assert.match(refused, /img-src/);
    console.log(JSON.stringify({ passed: true, screens: visited.length, visited }));
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
