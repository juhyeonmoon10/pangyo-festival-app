const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build, publicFiles, output } = require('../tools/build-web.cjs');

const first = build();
assert.equal(first.version, '1.2');
assert.equal(fs.existsSync(path.join(output, 'functions')), false);
fs.writeFileSync(path.join(output, 'static/stale-secret.txt'), 'synthetic stale file');
build();
assert.equal(fs.existsSync(path.join(output, 'static/stale-secret.txt')), false);
for (const forbidden of ['.env', 'api', 'nfc-server', 'supabase', 'tests', 'artifacts', 'README.md', '.git']) {
  assert.equal(fs.existsSync(path.join(output, 'static', forbidden)), false, forbidden);
}
const html = fs.readFileSync(path.join(output, 'static/index.html'), 'utf8');
for (const match of html.matchAll(/(?:src|href)="\.\/([^"?]+)(?:\?[^\"]*)?"/g)) {
  assert.ok(publicFiles().includes(match[1]), `Missing dependency: ${match[1]}`);
}
const config = JSON.parse(fs.readFileSync(path.join(output, 'config.json'), 'utf8'));
assert.equal(config.version, 3);
assert.ok(config.routes.some(route => route.src === '/nfc/?' && route.dest === '/index.html'));
console.log('PASS: dependency closure, static-only output, private file exclusion, stale output removal, NFC route.');
