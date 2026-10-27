const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup({ role = 'admin', server = true } = {}) {
  const state = { user: { id: 'operator', role }, route: 'admin', db: { event: { id: 'test-event' },
    booths: Array.from({ length: 20 }, (_, i) => ({ id: `b${i+1}`, name: `Booth ${i+1}`, officialClubId: `club-${i+1}` })),
    stamps: [{ id: 'actual-stamp' }], reviews: [{ rating: 5 }], users: [{ id: 'student' }],
  } };
  const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  const forbid = () => { throw Error('Simulation must not write actual records, storage, or RPCs'); };
  const context = vm.createContext({ state, isServerMode: () => server, isAdminUser: () => state.user?.role === 'admin',
    escapeHtml, document: { querySelector: () => null }, icon: name => `<svg data-icon="${name}"></svg>`,
    fetch: forbid, localStorage: { setItem: forbid }, sessionStorage: { setItem: forbid },
    festivalAccount: { operations: { read: forbid, write: forbid } }, nfcAdapter: { scan: forbid },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../stamp-simulator.js'), 'utf8'), context);
  return { api: vm.runInContext('festivalStampSimulator', context), state, setMode: value => { server = value; } };
}

test('only administrators can view, issue, select rewards or open a preview', () => {
  for (const role of ['user', 'operator', undefined]) {
    const { api } = setup({ role: role || 'user' });
    assert.equal(api.view(), '');
    assert.equal(api.issue('b1').ok, false);
    assert.equal(api.choose('photo', 3).ok, false);
    assert.equal(api.reset().ok, false);
    assert.equal(api.snapshot(), null);
    assert.equal(api.preview(), undefined);
  }
});

test('server and demo simulations never mutate actual account records or use gateways', () => {
  for (const server of [true, false]) {
    const { api, state } = setup({ server });
    const before = JSON.stringify(state);
    for (let i=1;i<=9;i++) assert.equal(api.issue(`b${i}`).ok, true);
    assert.equal(api.choose('photo', 3).ok, true);
    assert.equal(api.choose('food', 9).ok, true);
    assert.equal(api.snapshot().visits.length, 9);
    assert.equal(api.snapshot().vouchers.length, 3);
    api.reset();
    assert.equal(api.snapshot().visits.length, 0);
    assert.equal(JSON.stringify(state), before);
  }
});

test('invalid booths and repeated submissions cannot create extra simulated stamps', () => {
  const { api } = setup();
  assert.equal(api.issue('missing').ok, false);
  assert.equal(api.issue(undefined).ok, false);
  assert.equal(api.issue('b1').ok, true);
  for (let i=0;i<20;i++) assert.equal(api.issue('b1').ok, false);
  assert.equal(api.snapshot().visits.length, 1);
});

test('three chooses one, six gets the other, nine/twelve repeat without duplicates', () => {
  const { api } = setup();
  assert.equal(api.choose('photo', 3).ok, false);
  for(let i=1;i<=3;i++) api.issue(`b${i}`);
  assert.equal(api.choose('__proto__', 3).ok, false);
  assert.equal(api.choose('photo', 9).ok, false);
  assert.equal(api.choose('photo', 3).ok, true);
  assert.equal(api.choose('photo', 3).ok, true);
  assert.equal(api.choose('food', 3).ok, false);
  assert.equal(api.snapshot().vouchers.length, 1);
  for(let i=4;i<=12;i++) api.issue(`b${i}`);
  assert.equal(api.snapshot().vouchers.length, 2);
  assert.equal(api.choose('food', 9).ok, true);
  assert.equal(api.choose('food', 9).ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(api.snapshot().vouchers)), [
    {target:3,kind:'photo'}, {target:6,kind:'food'}, {target:9,kind:'food'}, {target:12,kind:'photo'},
  ]);
});

test('account, role, event and mode changes erase mock records and invalidate old actions', () => {
  for (const change of [s => { s.user.id='another'; }, s => { s.user=null; }, s => { s.user.role='user'; }, s => { s.db.event.id='another-event'; }]) {
    const { api, state } = setup(); api.issue('b1'); change(state); api.bind();
    assert.equal(api.snapshot()?.visits.length ?? 0, 0);
    if (!state.user || state.user.role !== 'admin') assert.equal(api.issue('b2').ok, false);
  }
  const { api, setMode }=setup(); api.issue('b1'); setMode(false);
  assert.equal(api.snapshot().visits.length, 0);
});

test('snapshots cannot be mutated to grant more simulated vouchers', () => {
  const { api } = setup(); api.issue('b1');
  const snapshot=api.snapshot(); snapshot.visits.push({boothId:'fake'}); snapshot.visits[0].boothId='changed'; snapshot.vouchers.push({target:3,kind:'photo'});
  assert.equal(api.snapshot().visits.length, 1);
  assert.equal(api.snapshot().visits[0].boothId, 'b1');
  assert.equal(api.snapshot().vouchers.length, 0);
});

test('tool escapes booth names and keeps explicit simulation boundaries', () => {
  const { api, state } = setup(); state.db.booths[0].name='<img onerror="test">'; api.issue('b1');
  const html=api.view();
  assert.match(html, /&lt;img onerror=&quot;test&quot;&gt;/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /실제 방문·별점·포인트·바우처는 바뀌지 않으며/);
  assert.match(html, /새로고침하면 모의 기록이 사라집니다/);
  assert.match(html, /id="stampSimIssue"[^>]*disabled/);
});
