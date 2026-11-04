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
async function setup({ server = false, updateProfile, reviewIdentitySelf } = {}) {
  const app = { dataset: {}, classList: { toggle() {} }, querySelector: () => null, innerHTML: '' };
  const inputs = new Map();
  const context = vm.createContext({
    URL, URLSearchParams, TextEncoder, TextDecoder, structuredClone, atob, btoa, crypto: webcrypto,
    location: new URL(`https://fixture.invalid/${server ? '' : '?demo=1'}`),
    localStorage: storage(), sessionStorage: storage(),
    history: { state: null, replaceState() {}, pushState() {} },
    document: { querySelector: selector => selector === '#app' ? app : inputs.get(selector) || null, querySelectorAll: () => [],
      getElementById: () => null, addEventListener() {}, body: {} },
    addEventListener() {}, setTimeout: () => 0, clearTimeout() {}, clearInterval() {}, queueMicrotask,
    festivalWeb: { afterRender() {}, bind() {}, completed: () => [], walletSummary: () => ({available:0}), points: () => null, header: () => '', home: () => '', visitRow: () => '' },
    FestivalCatalog: { CLUB_IDS: {}, createClient: () => ({ getSnapshot: () => ({ status: 'idle', rows: [] }),
      forClub: () => null, subscribe() {}, refresh() {} }) },
    FestivalAccount: { normalizeError, createAccount: () => ({ initialize: async () => profile, pending: () => null,
      myReviews: async () => ({ ok: false }), updateProfile, reviewIdentitySelf }) },
    fetch: () => { throw Error('Unit tests must not contact any server'); },
  });
  context.window = context;
  for (const file of ['nfc-manager.js', 'operations-ui.js', 'app.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  await new Promise(setImmediate);
  const api = vm.runInContext('({state, profileView, profileForm, completeProfile, loadDb, applyServerProfile, loginView, submitIdentityGate})', context);
  api.hasNameEditor = vm.runInContext('[typeof openNameEditor, typeof cancelNameEditor, typeof saveDisplayName].some(type => type !== "undefined")', context);
  if (!server) api.state.user = api.state.db.users[0];
  api.state.route = 'profile';
  return { ...api, session: context.sessionStorage, inputs };
}

// 1.54: the name is set once at sign-up; MY offers no way to change it, in either mode.
test('the profile offers no way to change the name', async () => {
  for (const server of [false, true]) {
    const api = await setup({ server });
    const html = api.profileView();
    assert.match(html, /Before|체험|학생/);
    assert.doesNotMatch(html, /이름 변경|editProfileName|profileNameForm|id="profileName"/);
    assert.equal(api.hasNameEditor, false);
    assert.equal(api.state.nameEdit, undefined);
  }
  const { createAccount } = require('../festival-account.js');
  assert.equal(typeof createAccount, 'function');
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'festival-account.js'), 'utf8'), /updateName/);
});

test('HTML-like names are escaped in profile', async () => {
  const api = await setup();
  api.state.user.name = '<img src=x onerror=alert(1)>';
  const html = api.profileView();
  assert.ok(html.includes('&lt;img'));
  assert.ok(!html.includes('<img src=x'));
});

test('Google name registration fills in the name field and saves it', async () => {
  const calls = [];
  const api = await setup({ server: true, updateProfile: async (name, studentNumber) => {
    calls.push({ name, studentNumber }); return { ...profile, name, studentNumber };
  } });
  api.applyServerProfile({ ...profile, name: '문주현', studentNumber: '', needsProfile: true });
  const html = api.profileForm();
  // 1.48: the name is an input filled in from the Google account, not only a label.
  assert.match(html, /id="name"[^>]*value="문주현"/);
  assert.match(html, /학생 정보 등록/);
  assert.doesNotMatch(html, /가져오지 못했어요/);
  api.inputs.set('#name', { value: '문주현', addEventListener() {} });
  api.inputs.set('#studentNumber', { value: '21001', addEventListener() {} });
  await api.completeProfile();
  assert.deepEqual(calls, [{ name: '문주현', studentNumber: '21001' }]);
  assert.equal(api.state.route, 'home');
  assert.equal(api.state.user.name, '문주현');
});

test('missing Google name shows a fallback but never an unescaped name', async () => {
  const api = await setup({ server: true });
  api.applyServerProfile({ ...profile, name: '', needsProfile: true });
  assert.match(api.profileForm(), /id="name"[^>]*value=""/);
  assert.match(api.profileForm(), /가져오지 못했어요/);
  api.applyServerProfile({ ...profile, name: '<img src=x>', needsProfile: true });
  const html = api.profileForm();
  assert.doesNotMatch(html, /<img src=x>/);
  assert.match(html, /value="&lt;img/);
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

// 1.53: club membership is confirmed at sign-up, and a student who must confirm cannot get past it.
const identityState = (over = {}) => ({ eventId: 'event-1', result: null, verified: false, locked: false, eligible: true,
  selfRegistered: false, realName: null, clubs: [], boothKeys: [], studentNumber: '21001', required: true, ...over });
const flush = () => new Promise(setImmediate);

test('sign-up confirms the club membership with the typed name in the same step', async () => {
  const calls = [];
  const api = await setup({ server: true,
    updateProfile: async (name, studentNumber) => ({ ...profile, name, studentNumber }),
    reviewIdentitySelf: async (action, payload) => {
      calls.push([action, payload]);
      return { ok: true, data: action === 'confirm' ? identityState({ result: 'CONFIRMED', verified: true, required: false, realName: '홍길동', clubs: ['인벨릭스'] }) : identityState() };
    } });
  calls.length = 0; // the fixture session itself was checked while starting
  api.applyServerProfile({ ...profile, name: '홍길동', studentNumber: '', needsProfile: true });
  assert.match(api.profileForm(), /data-identity-note[^>]*>1·2학년은 등록할 때 창체 동아리 명단으로 소속 동아리도 함께 확인해요/);
  api.inputs.set('#name', { value: '홍길동' });
  api.inputs.set('#studentNumber', { value: '21001' });
  await api.completeProfile();
  await flush();
  assert.equal(JSON.stringify(calls), JSON.stringify([['status', null], ['confirm', { eventId: 'event-1', realName: '홍길동' }]]));
  assert.equal(api.state.route, 'home');
  assert.equal(api.state.user.name, '홍길동');
  assert.equal(api.state.identityGate, null);
});

test('a name that is not on the roster keeps the student on the membership step', async () => {
  let confirmed = false, saved = [];
  const api = await setup({ server: true,
    updateProfile: async (name, studentNumber) => { saved.push([name, studentNumber]); return { ...profile, name, studentNumber }; },
    reviewIdentitySelf: async (action, payload) => {
      if (action === 'status') return { ok: true, data: identityState() };
      confirmed = payload.realName === '홍길동';
      return { ok: true, data: confirmed ? identityState({ result: 'CONFIRMED', verified: true, required: false, realName: '홍길동', clubs: ['인벨릭스'] }) : identityState({ result: 'IDENTITY_MISMATCH' }) };
    } });
  api.applyServerProfile({ ...profile, name: '홍길도', studentNumber: '', needsProfile: true });
  api.inputs.set('#name', { value: '홍길도' });
  api.inputs.set('#studentNumber', { value: '21001' });
  await api.completeProfile();
  await flush();
  // Not in: no user, the login screen shows the membership step with the reason and no skip button.
  assert.equal(api.state.user, null);
  assert.equal(api.state.authStep, 'identity');
  const html = api.loginView();
  assert.match(html, /소속 동아리 확인/);
  assert.match(html, /이 단계는 건너뛸 수 없어요/);
  assert.match(html, /동아리 명단의 이름과 달라요/);
  assert.match(html, /id="identityName"[^>]*value="홍길도"/);
  assert.doesNotMatch(html, /건너뛰|나중에|data-route="home"/);
  // Corrected right after sign-up: the profile name is saved too, then it is confirmed.
  api.inputs.set('#identityName', { value: '홍길동' });
  api.inputs.set('#identityStudentNumber', { value: '21001' });
  await api.submitIdentityGate();
  await flush();
  assert.equal(JSON.stringify(saved.at(-1)), JSON.stringify(['홍길동', '21001']));
  assert.equal(api.state.route, 'home');
  assert.equal(api.state.user.name, '홍길동');
});

test('a returning student who still has to confirm sees the step; others go straight in', async () => {
  const states = { required: identityState(), locked: identityState({ locked: true }), grade3: identityState({ eligible: false, required: false, studentNumber: '30101' }) };
  for (const [kind, data] of Object.entries(states)) {
    let confirms = 0;
    const api = await setup({ server: true, reviewIdentitySelf: async action => { if (action === 'confirm') confirms++; return { ok: true, data }; } });
    api.state.user = null;
    api.applyServerProfile({ ...profile });
    await flush();
    assert.equal(confirms, 0, `${kind}: a later login never confirms by itself`);
    if (kind === 'grade3') { assert.equal(api.state.user.id, profile.authUserId); continue; }
    assert.equal(api.state.user, null, kind);
    const html = api.loginView();
    if (kind === 'locked') { assert.match(html, /운영자가 소속 확인을 취소했어요/); assert.doesNotMatch(html, /identitySubmit/); }
    else assert.match(html, /id="identitySubmit"/);
  }
  // Operators are not held at the step.
  let asked = 0;
  const admin = await setup({ server: true, reviewIdentitySelf: async () => { asked++; return { ok: true, data: identityState() }; } });
  admin.state.user = null;
  asked = 0; // the fixture session itself was checked while starting
  admin.applyServerProfile({ ...profile, isAdmin: true });
  await flush();
  assert.equal(asked, 0);
  assert.equal(admin.state.user.role, 'admin');
});

test('a failed membership check offers a retry instead of letting the student in', async () => {
  const api = await setup({ server: true, reviewIdentitySelf: async () => ({ ok: false, code: 'NETWORK_ERROR', message: '연결을 확인해 주세요.' }) });
  api.state.user = null;
  api.applyServerProfile({ ...profile });
  await flush();
  assert.equal(api.state.user, null);
  assert.match(api.loginView(), /id="identityRetry"/);
  // No running festival: nothing to confirm.
  const closed = await setup({ server: true, reviewIdentitySelf: async () => ({ ok: false, code: 'OPS_NOT_READY', message: '' }) });
  closed.state.user = null;
  closed.applyServerProfile({ ...profile });
  await flush();
  assert.equal(closed.state.user.id, profile.authUserId);
});
