const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build, publicFiles, output } = require('../tools/build-web.cjs');

const first = build();
assert.equal(first.version, '1.32');
// An open page compares its own release with the deployed one to offer a reload.
assert.ok(fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8').includes(`const APP_RELEASE = "${first.version}";`), 'APP_RELEASE must match the build version');
assert.equal(fs.existsSync(path.join(output, 'functions')), false);
fs.writeFileSync(path.join(output, 'static/stale-secret.txt'), 'synthetic stale file');
build();
assert.equal(fs.existsSync(path.join(output, 'static/stale-secret.txt')), false);
for (const forbidden of ['.env', 'api', 'nfc-server', 'operations-server', 'tools', 'supabase', 'tests', 'artifacts', 'README.md', '.git']) {
  assert.equal(fs.existsSync(path.join(output, 'static', forbidden)), false, forbidden);
}
const html = fs.readFileSync(path.join(output, 'static/index.html'), 'utf8');
for (const asset of ['assets/festival-school-1.4.webp', 'assets/festival-map-1.4.webp']) {
  assert.ok(first.files[asset], `Missing home illustration: ${asset}`);
  assert.ok(fs.statSync(path.join(output, 'static', asset)).size < 200000, 'Home artwork must stay lightweight');
}
for (const match of html.matchAll(/(?:src|href)="\.\/([^"?]+)(?:\?[^\"]*)?"/g)) {
  assert.ok(publicFiles().includes(match[1]), `Missing dependency: ${match[1]}`);
}
const config = JSON.parse(fs.readFileSync(path.join(output, 'config.json'), 'utf8'));
assert.equal(config.version, 3);
assert.ok(config.routes.some(route => route.src === '/nfc/?' && route.dest === '/index.html'));
const rewrite = config.routes.find(route => route.src === require('../festival-router.js').pagePattern && route.dest === '/index.html');
assert.ok(rewrite, 'Page URLs must support a direct visit and refresh');
const pattern = new RegExp(`^${rewrite.src}$`);
for (const page of ['/', '/login', '/admin', '/map', '/stamp', '/voucher/', '/my', '/reviews', '/identity', '/booth/fixture', '/booth/fixture/reviews']) {
  assert.ok(pattern.test(page), `Missing page rewrite: ${page}`);
}
for (const privatePath of ['/api/debug', '/operations-server/install.sql', '/.env', '/tests/stamp-ui-preview.html', '/missing.js']) {
  assert.equal(pattern.test(privatePath), false, `A private or missing file must not become an app page: ${privatePath}`);
}
// Every response carries the security headers; the CSP admits the inline <base> script by hash only.
const headers = config.routes[0].headers;
assert.equal(config.routes[0].src, '/(.*)');
const csp = Object.fromEntries(headers['Content-Security-Policy'].split('; ').map(part => [part.split(' ')[0], part.split(' ').slice(1)]));
assert.deepEqual(csp['default-src'], ["'self'"]);
assert.ok(!csp['script-src'].some(v => ["'unsafe-inline'", "'unsafe-eval'", 'https:', '*'].includes(v)), 'script-src must not allow inline or remote code');
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
assert.equal(inline.length, 1, 'index.html keeps exactly one inline script');
assert.ok(csp['script-src'].includes(`'sha256-${require('node:crypto').createHash('sha256').update(inline[0][1]).digest('base64')}'`));
assert.ok(csp['connect-src'].includes('https://vvvkzvxahviwbuyfbwir.supabase.co'));
assert.deepEqual(csp['object-src'], ["'none'"]);
assert.deepEqual(csp['frame-ancestors'], ["'self'"]);
for (const name of ['X-Content-Type-Options', 'Referrer-Policy', 'X-Frame-Options', 'Cross-Origin-Opener-Policy', 'Permissions-Policy']) assert.ok(headers[name], name);
// The legacy api/ folder never reaches Vercel, so no server function is deployed from it.
const ignored = fs.readFileSync(path.join(__dirname, '../.vercelignore'), 'utf8').split(/\r?\n/);
for (const dir of ['/api', '/tests', '/nfc-server', '/operations-server', '/supabase', '/artifacts']) assert.ok(ignored.includes(dir), `.vercelignore must list ${dir}`);
console.log('PASS: dependency closure, static-only output, private file exclusion, stale output removal, NFC route.');
