const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { normalizeError } = require('../festival-account.js');

const root = path.resolve(__dirname, '..');
const profile = { id: 1, authUserId: 'fixture-student', name: 'Before', email: 'fixture@example.invalid',
  studentNumber: '21001', needsProfile: false, completedBooths: [], isAdmin: false };
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
async function setup({ server = false, updateName = async name => ({ ...profile, name }), updateProfile } = {}) {
  const app = { dataset: {}, classList: { toggle() {} }, querySelector: () => null, innerHTML: '' };
  const inputs = new Map();
  const context = vm.createContext({
    URL, URLSearchParams, TextEncoder, TextDecoder, structuredClone, atob, btoa, crypto: webcrypto,
    location: new URL(`https://fixture.invalid/${server ? '' : '?demo=1'}`),
    localStorage: storage(), sessionStorage: storage(),
    history: { state: null, replaceState() {}, pushState() {} },
    document: { querySelector: selector => selector === '#app' ? app : inputs.get(selector) || null, querySelectorAll: () => [],
      getElementById: () => null, addEventListener() {}, body: {} },
    addEventListener() {}, setTimeout: () => 0, clearTimeout() {},
    festivalWeb: { afterRender() {}, bind() {}, completed: () => [], header: () => '', home: () => '' },
    FestivalCatalog: { CLUB_IDS: {}, createClient: () => ({ getSnapshot: () => ({ status: 'idle', rows: [] }),
      forClub: () => null, subscribe() {}, refresh() {} }) },
    FestivalAccount: { normalizeError, createAccount: () => ({ initialize: async () => profile, pending: () => null,
      myReviews: async () => ({ ok: false }), updateName, updateProfile }) },
    fetch: () => { throw Error('Unit tests must not contact any server'); },
  });
  context.window = context;
  for (const file of ['nfc-manager.js', 'app.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  await new Promise(setImmediate);
  const api = vm.runInContext('({state, openNameEditor, cancelNameEditor, saveDisplayName, profileView, profileForm, completeProfile, loadDb, applyServerProfile})', context);
  if (!server) api.state.user = api.state.db.users[0];
  api.state.route = 'profile';
  return { ...api, session: context.sessionStorage, inputs };
}

test('cancel and unchanged names do not save', async () => {
  let calls = 0;
  const api = await setup({ server: true, updateName: () => { calls++; } });
  api.openNameEditor();
  assert.equal(api.state.nameEdit.draft, 'Before');
  api.state.nameEdit.draft = 'Unsaved';
  api.cancelNameEditor();
  assert.equal(api.state.user.name, 'Before');
  api.openNameEditor();
  await api.saveDisplayName();
  assert.equal(calls, 0);
});

test('empty and long input retain the draft and show validation without saving', async () => {
  const api = await setup({ server: true, updateName: () => { throw Error('unexpected write'); } });
  api.openNameEditor();
  for (const draft of ['  ', '가'.repeat(61)]) {
    api.state.nameEdit.draft = draft;
    await api.saveDisplayName();
    assert.equal(api.state.nameEdit.draft, draft);
    assert.match(api.state.nameEdit.error, /1~60/);
    assert.equal(api.state.user.name, 'Before');
  }
});

test('demo changes survive reload while IDs, stamps and reviews stay intact', async () => {
  const api = await setup();
  const before = structuredClone(api.state.user);
  api.state.db.stamps.push({ id: 'stamp-fixture', userId: before.id, boothId: 'g1-1' });
  api.state.db.reviews.push({ id: 'review-fixture', userId: before.id, boothId: 'g1-1', rating: 5 });
  api.openNameEditor();
  api.state.nameEdit.draft = '  새 이름  ';
  await api.saveDisplayName();
  assert.deepEqual(structuredClone(api.state.user), { ...before, name: '새 이름' });
  const reloaded = api.loadDb();
  assert.equal(reloaded.users.find(user => user.id === before.id).name, '새 이름');
  assert.equal(reloaded.stamps[0].id, 'stamp-fixture');
  assert.equal(reloaded.reviews[0].id, 'review-fixture');
  assert.equal(api.state.nameEdit.open, false);
  assert.match(api.state.nameEdit.message, /변경했어요/);
});

test('storage and server failures leave the name and draft unchanged', async () => {
  for (const server of [false, true]) {
    const api = await setup({ server, updateName: async () => { throw Error('private internal error'); } });
    const before = api.state.user.name;
    api.openNameEditor();
    api.state.nameEdit.draft = 'New';
    api.session.setItem = () => { throw Error('storage full'); };
    await api.saveDisplayName();
    assert.equal(api.state.user.name, before);
    assert.equal(api.state.nameEdit.draft, 'New');
    assert.equal(api.state.nameEdit.open, true);
    assert.equal(api.state.nameEdit.busy, false);
    assert.ok(api.state.nameEdit.error);
    assert.doesNotMatch(api.state.nameEdit.error, /private|internal/);
  }
});

test('repeated submit shares the UI lock and changes only the name', async () => {
  let calls = 0, finish;
  const api = await setup({ server: true, updateName: name => { calls++; return new Promise(resolve => { finish = () => resolve({ ...profile, name }); }); } });
  const before = structuredClone(api.state.user);
  api.openNameEditor();
  api.state.nameEdit.draft = 'After';
  const first = api.saveDisplayName();
  await api.saveDisplayName();
  assert.equal(calls, 1);
  assert.equal(api.state.nameEdit.busy, true);
  finish();
  await first;
  assert.deepEqual(structuredClone(api.state.user), { ...before, name: 'After' });
});

test('a response from a signed-out user cannot overwrite a new session', async () => {
  let finish;
  const api = await setup({ server: true, updateName: name => new Promise(resolve => { finish = () => resolve({ ...profile, name }); }) });
  api.openNameEditor();
  api.state.nameEdit.draft = 'After';
  const pending = api.saveDisplayName();
  api.applyServerProfile(null);
  api.applyServerProfile({ ...profile, authUserId: 'another-user', name: 'Other' });
  finish();
  await pending;
  assert.equal(api.state.user.name, 'Other');
  assert.equal(api.state.nameEdit.draft, '');
});

test('HTML-like names are escaped in profile and editor', async () => {
  const api = await setup();
  api.state.user.name = '<img src=x onerror=alert(1)>';
  api.openNameEditor();
  const html = api.profileView();
  assert.ok(html.includes('&lt;img'));
  assert.ok(!html.includes('<img src=x'));
});

test('Google name registration asks for student number only and saves the automatic name', async () => {
  const calls = [];
  const api = await setup({ server: true, updateProfile: async (name, studentNumber) => {
    calls.push({ name, studentNumber }); return { ...profile, name, studentNumber };
  } });
  api.applyServerProfile({ ...profile, name: '문주현', studentNumber: '', needsProfile: true });
  const html = api.profileForm();
  assert.doesNotMatch(html, /id="name"/);
  assert.match(html, /학번 확인/);
  api.inputs.set('#studentNumber', { value: '21001', addEventListener() {} });
  await api.completeProfile();
  assert.deepEqual(calls, [{ name: '문주현', studentNumber: '21001' }]);
  assert.equal(api.state.route, 'home');
  assert.equal(api.state.user.name, '문주현');
});

test('missing Google name shows a fallback but never an unescaped name', async () => {
  const api = await setup({ server: true });
  api.applyServerProfile({ ...profile, name: '', needsProfile: true });
  assert.match(api.profileForm(), /id="name"/);
  api.applyServerProfile({ ...profile, name: '<img src=x>', needsProfile: true });
  const html = api.profileForm();
  assert.doesNotMatch(html, /<img src=x>|id="name"/);
  assert.match(html, /&lt;img/);
});

test('onboarding blocks duplicate saves and retains student input on failure', async () => {
  let calls = 0, reject;
  const api = await setup({ server: true, updateProfile: () => {
    calls++; return new Promise((_, fail) => { reject = fail; });
  } });
  api.applyServerProfile({ ...profile, needsProfile: true });
  api.inputs.set('#studentNumber', { value: '21002', addEventListener() {} });
  const first = api.completeProfile();
  await api.completeProfile();
  assert.equal(calls, 1);
  assert.match(api.profileForm(), /disabled/);
  reject(new Error('private database error'));
  await first;
  assert.equal(api.state.pendingGoogle.studentNumber, '21002');
  assert.match(api.profileForm(), /value="21002"/);
  assert.doesNotMatch(api.state.loginError, /private/);
  assert.equal(api.state.loginBusy, false);
});
