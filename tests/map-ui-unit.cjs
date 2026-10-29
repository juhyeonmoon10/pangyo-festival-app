const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

function setup() {
  const root = path.resolve(__dirname, '..');
  const nodes = new Map();
  const app = { dataset: {}, classList: { toggle() {} }, querySelector: () => null, innerHTML: '' };
  const memory = () => {
    const values = new Map();
    return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  };
  const context = vm.createContext({
    URL, URLSearchParams, TextEncoder, TextDecoder, structuredClone, atob, btoa, crypto: webcrypto,
    location: new URL('https://fixture.invalid/?demo=1'), localStorage: memory(), sessionStorage: memory(),
    history: { state: null, replaceState() {}, pushState() {} },
    document: { querySelector: selector => selector === '#app' ? app : nodes.get(selector) || null,
      querySelectorAll: () => [], getElementById: () => null, addEventListener() {}, body: {} },
    addEventListener() {}, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, queueMicrotask,
    FestivalCatalog: { CLUB_IDS: {}, createClient: () => ({
      getSnapshot: () => ({ status: 'ready', rows: [] }), forClub: () => null, subscribe() {}, refresh() {},
    }) },
    fetch() { throw Error('Network is forbidden in map tests'); },
  });
  context.window = context;
  for (const file of ['assets/vendor/ui-icons.js', 'web-experience.js', 'nfc-manager.js', 'operations-ui.js', 'app.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  }
  const api = vm.runInContext('({state, mapView, visibleBooths, searchResults, setSheetLevel, bindEvents, adjustMapZoom})', context);
  api.state.user = api.state.db.users[0];
  api.state.selectedBoothId = null;
  return { ...api, nodes, app };
}

test('map keeps one search action, one reset and no extra instructional copy', () => {
  const api = setup();
  const html = api.mapView();
  assert.equal((html.match(/<h1>/g) || []).length, 1);
  assert.equal((html.match(/id="searchScreenInput"/g) || []).length, 1);
  assert.equal((html.match(/id="resetMapView"/g) || []).length, 1);
  assert.match(html, /class="map-search-bar search-screen-input/);
  assert.doesNotMatch(html, /aria-modal="true"/);
  assert.doesNotMatch(html, /탭해서|sheet-hint|sheet-head/);
});

test('each floor has exactly one selected floor control and correct list count', () => {
  const api = setup();
  for (const floor of [1, 2, 3, 4]) {
    api.state.floor = floor;
    const html = api.mapView();
    assert.equal((html.match(/data-floor="/g) || []).length, 4);
    assert.equal((html.match(/aria-pressed="true"/g) || []).length, 1);
    assert.match(html, new RegExp(`data-floor="${floor}"[^>]*aria-pressed="true"`));
    assert.ok(html.includes(`${floor}층 부스</strong>`));
    assert.ok(html.includes(`id="mapResultCount">${api.visibleBooths().length}개`));
  }
});

test('sheet summaries and accessible expansion states agree for every snap level', () => {
  const api = setup();
  for (const [level, label] of [['peek', '부스 목록 펼치기'], ['mid', '부스 목록 더 펼치기'], ['full', '부스 목록 접기']]) {
    api.setSheetLevel(level);
    const html = api.mapView();
    assert.ok(html.includes(`aria-label="${label}" aria-expanded="${level !== 'peek'}" aria-controls="floorBoothList"`));
    assert.equal((html.match(/data-floor-stamp-count/g) || []).length, 1);
    assert.match(html, /id="floorBoothList"/);
  }
});

test('visit check marks reflect existing records without creating visits', () => {
  const api = setup();
  const booth = api.visibleBooths()[0];
  api.state.db.stamps = [{ id: 'fixture', userId: api.state.user.id, boothId: booth.id, status: 'active' }];
  const html = api.mapView();
  assert.match(html, /data-floor-stamp-count>1<\/span>/);
  assert.match(html, /class="room-state" aria-hidden="true"><svg/);
  assert.match(html, new RegExp(`class="plan-room [^"]*visited[^"]*"[^>]*data-map-select="${booth.id}"`));
  assert.equal(api.state.db.stamps.length, 1);
});

test('map search and room attributes escape external names', () => {
  const api = setup();
  api.state.search = '<img src=x onerror=alert(1)>';
  assert.match(api.mapView(), /&lt;img src=x onerror=alert\(1\)&gt;/);
  api.state.search = '';
  api.visibleBooths()[0].name = '" onmouseover="unsafe';
  assert.doesNotMatch(api.mapView(), /title="" onmouseover=/);
});

test('Korean composition preserves input and commits only after composition ends', () => {
  const api = setup();
  const handlers = {};
  const input = { dataset: {}, value: '', addEventListener: (event, callback) => { handlers[event] = callback; },
    closest: () => ({ classList: { toggle() {} } }) };
  const list = { innerHTML: '', scrollTop: 0, querySelectorAll: () => [] };
  api.nodes.set('#searchScreenInput', input);
  api.nodes.set('#searchResultList', list);
  api.bindEvents();
  handlers.compositionstart();
  input.value = '1학ㄴ';
  handlers.input({ isComposing: true, target: input });
  assert.equal(api.state.search, '');
  input.value = '1학년 1반';
  handlers.compositionend({ target: input });
  assert.equal(api.state.search, '1학년 1반');
  assert.equal(api.nodes.get('#searchScreenInput'), input);
  const spaced = JSON.stringify(api.searchResults().map(b => b.id));
  api.state.search = '1학년1반';
  assert.equal(JSON.stringify(api.searchResults().map(b => b.id)), spaced);
  assert.notEqual(spaced, '[]');
});

test('zoom limits and reset-to-fit offsets are unchanged', () => {
  const api = setup();
  api.adjustMapZoom(10);
  assert.equal(api.state.mapZoom, 1.6);
  api.state.mapOffsetX = 50;
  api.state.mapOffsetY = 50;
  api.adjustMapZoom(-10);
  assert.equal(api.state.mapZoom, 0.9);
  assert.equal(api.state.mapOffsetX, 0);
  assert.equal(api.state.mapOffsetY, 0);
});
