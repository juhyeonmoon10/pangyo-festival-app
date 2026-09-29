const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const dbKey = 'pangyo-festival-db-v3';
const sessionKey = 'pangyo-festival-demo-session-v1';
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
function setup() {
  const app = { dataset: {}, classList: { toggle() {} }, querySelector: () => null, innerHTML: '' };
  const context = vm.createContext({
    URL, URLSearchParams, TextEncoder, TextDecoder, structuredClone, atob, btoa, crypto: webcrypto,
    location: new URL('https://fixture.invalid/?demo=1'),
    localStorage: storage(), sessionStorage: storage(),
    history: { state: null, replaceState() {}, pushState() {} },
    document: { querySelector: selector => selector === '#app' ? app : null, querySelectorAll: () => [],
      getElementById: () => null, addEventListener() {}, body: {} },
    addEventListener() {}, setTimeout: () => 0, clearTimeout() {},
    festivalWeb: { afterRender() {}, bind() {} },
    FestivalCatalog: { CLUB_IDS: {}, createClient: () => ({ getSnapshot: () => ({ status: 'idle', rows: [] }),
      forClub: () => null, subscribe() {}, refresh() {} }) },
    fetch: () => { throw new Error('Unit tests must not contact any server'); },
  });
  context.window = context;
  for (const file of ['nfc-manager.js', 'app.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  const api = vm.runInContext('({state, seed, BOOTH_STATUS, loadDb, mockStampGateway, mockNfcTokenForTagId, adminPanel, nfcManagement})', context);
  api.state.user = api.state.db.users[0];
  return { ...api, local: context.localStorage, session: context.sessionStorage };
}
function claim(api, booth, key) {
  return api.mockStampGateway.claimNfc({ eventId: api.state.db.event.id, userId: 'fixture-student',
    nfcToken: api.mockNfcTokenForTagId(booth.nfcTagId), idempotencyKey: key });
}

test('only four operational states exist in seed and admin controls', () => {
  const api = setup();
  assert.deepEqual(Object.keys(api.BOOTH_STATUS), ['preparing', 'open', 'paused', 'closed']);
  assert.ok(api.seed.booths.every(booth => Object.hasOwn(api.BOOTH_STATUS, booth.status)));
  assert.doesNotMatch(api.adminPanel(), /crowded|혼잡/);
  const manager = api.nfcManagement.view();
  assert.doesNotMatch(manager, /crowded|혼잡/);
  for (const status of Object.keys(api.BOOTH_STATUS)) assert.ok(manager.includes(`value="${status}"`));
});

test('old device state is migrated durably without losing settings or session progress', () => {
  const api = setup();
  const saved = structuredClone(api.state.db);
  const booth = saved.booths.find(item => item.id === 'g1-6');
  booth.status = 'crowded';
  booth.nfcTagId = 'NFC-PRESERVED';
  booth.nfcEnabled = false;
  const progress = { users: saved.users, stamps: [{ id: 'existing', userId: 'fixture-student', boothId: booth.id, status: 'active' }],
    reviews: [{ id: 'review', boothId: booth.id, rating: 5 }], idempotencyRecords: [{ id: 'request' }] };
  api.local.setItem(dbKey, JSON.stringify(saved));
  api.session.setItem(sessionKey, JSON.stringify(progress));
  const migrated = api.loadDb();
  const updated = migrated.booths.find(item => item.id === booth.id);
  assert.deepEqual(structuredClone(updated), { ...booth, status: 'open' });
  assert.deepEqual(Array.from(migrated.booths.filter(item => item.id !== booth.id), item => item.status), saved.booths.filter(item => item.id !== booth.id).map(item => item.status));
  assert.equal(JSON.parse(api.local.getItem(dbKey)).booths.find(item => item.id === booth.id).status, 'open');
  assert.deepEqual(JSON.parse(api.session.getItem(sessionKey)).reviews, progress.reviews);
  assert.equal(migrated.stamps[0].id, 'existing');
  assert.equal(migrated.idempotencyRecords[0].id, 'request');
  assert.equal(api.loadDb().booths.find(item => item.id === booth.id).status, 'open');
});

for (const status of ['open', 'preparing', 'paused', 'closed', 'crowded', 'unknown']) {
  test(`NFC gateway and manager agree on ${status}`, async () => {
    const api = setup();
    const booth = api.state.db.booths.find(item => item.id === 'g1-1');
    booth.status = status;
    const checked = api.nfcManagement.check(booth.id);
    assert.equal(checked.ok, status === 'open');
    assert.equal(api.state.db.stamps.length, 0);
    const result = await claim(api, booth, `fixture-${status}`);
    assert.equal(result.ok, status === 'open');
    if (status === 'open') {
      assert.equal(result.result, 'EARNED');
      assert.equal((await claim(api, booth, `fixture-${status}`)).replayed, true);
      assert.equal((await claim(api, booth, 'fixture-another-key')).result, 'ALREADY_EARNED');
      assert.equal(api.state.db.stamps.length, 1);
    } else {
      assert.equal(result.code, 'BOOTH_NOT_OPEN');
      assert.equal(api.state.db.stamps.length, 0);
    }
  });
}

test('current plans and visual styles no longer offer crowding', () => {
  for (const file of ['README.md', 'P0_GAP_AUDIT.md', 'SERVER_DB_API_DESIGN.md', 'styles.css']) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), 'utf8'), /혼잡|crowded|crowding|congestion/i, file);
  }
  // Private plans are not required by a fresh clone or the public web build.
  for (const file of ['FESTIVAL_APP_FEATURE_PLAN.md', 'SERVER_MODE_SETUP.md']) {
    if (fs.existsSync(path.join(root, file))) assert.doesNotMatch(fs.readFileSync(path.join(root, file), 'utf8'), /혼잡|crowded|crowding|congestion/i, file);
  }
});
