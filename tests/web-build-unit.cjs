const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build, publicFiles, output } = require('../tools/build-web.cjs');

const first = build();
assert.equal(first.version, '1.21');
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
console.log('PASS: dependency closure, static-only output, private file exclusion, stale output removal, NFC route.');
