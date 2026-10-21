const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup({ count = 0, pending = 0, server = false, name = 'Test booth' } = {}) {
  const records = new Map();
  const booths = Array.from({ length: 25 }, (_, i) => ({ id: `booth-${i}`, name: i ? `Booth ${i}` : name, location: '2F' }));
  const visits = booths.slice(0, count + pending).map(b => ({ boothId: b.id, userId: 'fixture' }));
  const reviews = booths.slice(0, count).map(b => ({ boothId: b.id, userId: 'fixture', rating: 5, content: '' }));
  const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const context = vm.createContext({
    state: { user: { id: 'fixture' }, db: { booths, reviews } },
    repo: { stampsForUser: () => visits, hasReview: (_id, boothId) => reviews.some(r => r.boothId === boothId) },
    isServerMode: () => server, festivalOpsUI: { snapshot: () => null },
    readSessionStorage: key => records.get(key), writeSessionStorage: (key, value) => { records.set(key, value); return true; },
    escapeHtml, icon: key => `<svg data-icon="${key}" aria-hidden="true"></svg>`,
    catalogBooth: () => null, clubVisual: () => '', bottomNav: () => '<nav>Navigation</nav>',
    makeId: () => `coupon-${records.size}`, formatTime: () => '',
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../web-experience.js'), 'utf8'), context);
  return { api: vm.runInContext('festivalWeb', context), visits, reviews, records };
}

test('empty path has one actionable next stamp, ten visual slots, and a zero progress value', () => {
  const { api } = setup();
  const html = api.stamps();
  assert.equal((html.match(/class="stamp-path-step /g) || []).length, 10);
  assert.equal((html.match(/aria-current="step"/g) || []).length, 1);
  assert.match(html, /class="stamp-path-node" data-route="map"/);
  assert.match(html, /max="5" value="0"/);
  assert.doesNotMatch(html, /web-stamp-grid|web-stamp-cell/);
});

test('rated visits alone become completed nodes; the next action opens a pending review', () => {
  const { api, visits, reviews } = setup({ count: 3, pending: 2 });
  const html = api.stamps();
  assert.equal((html.match(/stamp-path-step is-earned/g) || []).length, 3);
  assert.match(html, /class="stamp-path-node" data-review-booth="booth-3"/);
  assert.match(html, /max="5" value="3"/);
  assert.equal(visits.length, 5);
  assert.equal(reviews.length, 3);
});

test('completed nodes retain booth navigation and escape long or HTML-like names', () => {
  const { api } = setup({ count: 1, name: '<script>Test & long booth name</script>' });
  const html = api.stamps();
  assert.match(html, /data-list-select="booth-0"/);
  assert.match(html, /&lt;script&gt;Test &amp; long booth name&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('a completed five-stamp chapter preserves existing demo voucher issuance', () => {
  const { api } = setup({ count: 5 });
  const html = api.stamps();
  assert.match(html, /max="5" value="5"/);
  assert.equal((html.match(/stamp-path-chapter is-complete/g) || []).length, 1);
  assert.match(html, /button type="button" data-route="vouchers" class="stamp-path-milestone is-ready"/);
  assert.equal(api.coupons().length, 1);
  api.stamps();
  assert.equal(api.coupons().length, 1);
});

test('ten and thirteen stamps never truncate later visits or invent extra rewards', () => {
  for (const count of [10, 13]) {
    const { api } = setup({ count });
    const html = api.stamps();
    assert.equal((html.match(/class="stamp-path-step /g) || []).length, 15);
    assert.equal((html.match(/stamp-path-step is-earned/g) || []).length, count);
    assert.equal((html.match(/aria-current="step"/g) || []).length, 1);
    assert.equal(api.coupons().length, 2);
  }
});

test('server path shows records without fabricating five-stamp reward milestones or writes', () => {
  const { api, records } = setup({ count: 5, server: true });
  const html = api.stamps();
  assert.doesNotMatch(html, /stamp-path-milestone|체험 바우처|작은 선물/);
  assert.match(html, /data-route="vouchers"/);
  assert.equal(records.size, 0);
});

test('upcoming slots are not fake buttons and layout styles honor reduced motion', () => {
  const html = setup().api.stamps();
  assert.equal((html.match(/<button[^>]+class="stamp-path-node"/g) || []).length, 1);
  const css = fs.readFileSync(path.join(__dirname, '../web-redesign.css'), 'utf8');
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /stamp-path-node:focus-visible/);
});
