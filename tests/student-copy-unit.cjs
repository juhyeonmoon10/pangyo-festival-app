const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { normalizeError } = require('../festival-account.js');

const root = path.resolve(__dirname, '..');
const profile = { id: 1, authUserId: 'fixture', name: 'Student', email: 'fixture@example.invalid',
  studentNumber: '21001', needsProfile: false, completedBooths: [], isAdmin: false };
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
async function setup(server = true) {
  const app = { dataset: {}, classList: { toggle() {} }, querySelector: () => null, innerHTML: '' };
  const catalog = { status: 'ready', row: null, refreshes: 0, subscriber: null };
  const slots = new Map();
  const context = vm.createContext({
    URL, URLSearchParams, TextEncoder, TextDecoder, structuredClone, atob, btoa, crypto: webcrypto,
    location: new URL(`https://fixture.invalid/${server ? '' : '?demo=1'}`),
    localStorage: storage(), sessionStorage: storage(),
    history: { state: null, replaceState() {}, pushState() {} },
    document: { querySelector: selector => selector === '#app' ? app : null,
      querySelectorAll: selector => slots.get(selector) || [], getElementById: () => null, addEventListener() {}, body: {} },
    addEventListener() {}, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    FestivalCatalog: { CLUB_IDS: {}, createClient: () => ({
      getSnapshot: () => ({ status: catalog.status, rows: catalog.row ? [catalog.row] : [] }),
      forClub: () => catalog.row, subscribe: callback => { catalog.subscriber = callback; },
      refresh: () => { catalog.refreshes++; },
    }) },
    FestivalAccount: { normalizeError, createAccount: () => ({ initialize: async () => profile,
      pending: () => null, myReviews: async () => ({ ok: false }) }) },
    fetch: () => { throw Error('No network in copy tests'); },
  });
  context.window = context;
  for (const file of ['web-experience.js', 'nfc-manager.js', 'app.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  }
  await new Promise(setImmediate);
  const api = vm.runInContext('({state, profileView, loginView, mapView, detailView, scanView, reviewForm, catalogRatingText, catalogPositionText, festivalWeb})', context);
  if (!server) api.state.user = api.state.db.users[0];
  api.state.selectedBoothId = api.state.db.booths[0].id;
  return { ...api, catalog, slots };
}

test('profile and login omit storage and connection diagnostics in both modes', async () => {
  for (const server of [true, false]) {
    const api = await setup(server);
    for (const html of [api.profileView(), api.loginView()]) {
      assert.doesNotMatch(html, /저장 위치|Supabase|catalog-connection|data-catalog-status|마지막 조회|부스 DB/);
    }
    assert.match(api.profileView(), /방문 기록/);
    assert.match(api.profileView(), /이름 변경/);
  }
});

test('student routes do not expose backend implementation notices', async () => {
  const api = await setup();
  for (const html of [api.mapView(), api.detailView(), api.scanView(), api.festivalWeb.home(),
    api.festivalWeb.stamps(), api.festivalWeb.reviews(), api.festivalWeb.vouchers()]) {
    assert.doesNotMatch(html, /Supabase|부스 DB|DB 별점|DB 위치|서버 연결|운영 서버|서버 방문 인증|catalog-connection/);
  }
});

test('removing diagnostics does not stop catalog refresh or in-place updates', async () => {
  const api = await setup();
  const booth = api.state.db.booths.find(item => item.officialClubId);
  const nameSlot = { textContent: '', dataset: { catalogName: booth.id } };
  const ratingSlot = { textContent: '', dataset: { catalogRating: booth.id } };
  api.slots.set('[data-catalog-name]', [nameSlot]);
  api.slots.set('[data-catalog-rating]', [ratingSlot]);
  assert.equal(api.catalog.refreshes, 1);
  api.catalog.row = { name: 'Updated booth', rating: 4.5, position: '2층' };
  api.catalog.subscriber();
  assert.equal(nameSlot.textContent, 'Updated booth');
  assert.equal(ratingSlot.textContent, '4.5점');
  assert.equal(api.catalogPositionText(booth), '위치: 2층');
  api.catalog.status = 'offline';
  api.catalog.subscriber();
  assert.equal(ratingSlot.textContent, '4.5점 · 이전 정보');
});

test('unavailable services, provisional locations, and draft limits remain explicit', async () => {
  const api = await setup();
  assert.match(api.detailView(), /실제 부스 위치는 운영 안내를 확인/);
  assert.match(api.festivalWeb.vouchers(), /아직 이용할 수 없어요/);
  assert.match(api.festivalWeb.reviews(), /탭을 닫으면 사라지며 포인트는 적립되지/);
  api.state.loginError = '저장하지 못했어요. 다시 시도해 주세요.';
  assert.match(api.profileView(), /저장하지 못했어요/);
  for (const code of ['AUTH_REQUIRED', 'SERVER_NOT_READY', 'NFC_DISABLED', 'BOOTH_NOT_FOUND', 'NETWORK_ERROR']) {
    const result = normalizeError({ message: code });
    assert.ok(result.message);
    assert.doesNotMatch(result.message, /서버|DB|Supabase|데모 둘러보기/);
  }
});
