const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAccount, normalizeError, validateProfile, validateReviews, validateIssuedTag } = require('../festival-account.js');
const config = require('../supabase-catalog.js');
const token = `nf1.e30.${'a'.repeat(64)}`;
const good = { id: 1, authUserId: 'fixture', name: 'Test', email: 'test@example.invalid', studentNumber: '21001', needsProfile: false, completedBooths: [] };
function setup(rpc) {
  const values = new Map(); let options, authCallback;
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const auth = { onAuthStateChange: cb => { authCallback = cb; }, getSession: async () => ({ data: { session: null } }),
    updateUser: async () => ({ error: null }), exchangeCodeForSession: async () => ({ error: null }),
    signOut: async () => ({ error: null }), signInWithOAuth: async () => ({ data: { url: config.PROJECT_URL + '/auth/v1/authorize?provider=google' } }) };
  const sdk = { createClient: (url, key, opts) => { assert.equal(url, config.PROJECT_URL); options = opts; return { auth, rpc }; } };
  const location = new URL('https://appassets.androidplatform.net/assets/site/index.html');
  const account = createAccount({ sdk, config, storage, location, openUrl: () => {} });
  return { account, options, storage, auth, getCallback: () => authCallback };
}
test('uses PKCE and initializes without manufacturing a session', async () => {
  const { account, options } = setup(() => { throw Error('unexpected RPC'); });
  assert.equal(options.auth.flowType, 'pkce'); assert.equal(await account.initialize(), null);
});
test('same tag concurrent requests share exactly one server call', async () => {
  let calls = 0, release;
  const { account } = setup(async () => { calls++; await new Promise(r => { release = r; }); return { data: { result: 'EARNED', boothKey: '글빛누리', completedBooths: ['글빛누리'] } }; });
  const one = account.claim(token), two = account.claim(token);
  assert.equal(one, two); await Promise.resolve(); assert.equal(calls, 1); release();
  assert.equal((await one).ok, true);
});
test('legacy tokens and malformed server success never award stamps', async () => {
  const { account } = setup(async () => ({ data: { result: 'EARNED', boothKey: '글빛누리', completedBooths: [] } }));
  assert.equal((await account.claim('mock-v1.e30')).code, 'NFC_TAG_INVALID');
  assert.equal((await account.claim(token)).ok, false);
});
test('pending signed tag survives redirect and expires after 15 minutes', () => {
  const { account, storage } = setup(); account.savePending({ nfcToken: token });
  assert.equal(account.pending().nfcToken, token);
  storage.setItem('pangyo-pending-nfc-v1', JSON.stringify({ nfcToken: token, savedAt: Date.now() - 900001 }));
  assert.equal(account.pending(), null);
});
test('only exact native callback is accepted; no URL injection', async () => {
  const { account } = setup(async () => ({ data: good }));
  assert.deepEqual(await account.receiveCallback('pangyofestival://auth/callback?code=fixture'), { ...good, isAdmin: false });
  for (const url of ['https://evil.invalid/?code=x','pangyofestival://auth:123/callback?code=x','pangyofestival://auth/callback?code=a&code=b','pangyofestival://auth/callback?code=a#token=x']) {
    await assert.rejects(account.receiveCallback(url));
  }
});
test('profile input validation and safe public error messages', async () => {
  const { account } = setup();
  await assert.rejects(account.updateProfile('Test','99999'));
  assert.throws(() => validateProfile({ ...good, completedBooths: [123] }));
  assert.equal(validateProfile(good).isAdmin, false);
  assert.equal(validateProfile({ ...good, isAdmin: true }).isAdmin, true);
  assert.throws(() => validateProfile({ ...good, isAdmin: 'yes' }));
  assert.equal(normalizeError({ message: 'internal private database password' }).message.includes('password'), false);
  assert.equal(normalizeError({ message: 'NFC_TAG_EXPIRED' }).code, 'NFC_TAG_EXPIRED');
  assert.equal(normalizeError({ code: 'PGRST202', message: 'Could not find the function' }).code, 'SERVER_NOT_READY');
  assert.equal(normalizeError({ message: 'not found in the schema cache' }).code, 'SERVER_NOT_READY');
  assert.equal(normalizeError({ message: 'boom' }).code, 'NETWORK_ERROR');
});

test('name changes update only the app display name and confirm the saved profile', async () => {
  const calls = [];
  const expected = { ...good, name: '새 이름', completedBooths: ['글빛누리'] };
  const { account, auth } = setup(async method => { calls.push(method); return { data: expected }; });
  auth.updateUser = async attributes => { calls.push(attributes); return { error: null }; };
  const profile = await account.updateName('  새 이름  ');
  assert.deepEqual(calls, [{ data: { festival_name: '새 이름' } }, 'festival_nfc_profile']);
  assert.equal(profile.studentNumber, good.studentNumber);
  assert.deepEqual(profile.completedBooths, expected.completedBooths);
});

test('invalid name changes never reach authentication or the profile RPC', async () => {
  const { account, auth } = setup(() => { throw Error('unexpected RPC'); });
  auth.updateUser = () => { throw Error('unexpected write'); };
  for (const name of ['', '   ', '가'.repeat(61), null, 42]) {
    await assert.rejects(account.updateName(name), /INVALID_NAME/);
  }
});

test('a failed or unconfirmed name change is not reported as saved', async () => {
  const { account, auth } = setup(async () => ({ data: good }));
  auth.updateUser = async () => ({ error: new Error('AUTH_REQUIRED') });
  await assert.rejects(account.updateName('New'), /AUTH_REQUIRED/);
  auth.updateUser = async () => ({ error: null });
  await assert.rejects(account.updateName('New'), /PROFILE_NAME_UNCONFIRMED/);
  assert.match(normalizeError({ message: 'PROFILE_NAME_UNCONFIRMED' }).message, /변경 결과/);
});

test('review responses are validated before they reach the screen', () => {
  const ok = { boothKey: '글빛누리', count: 2, average: '4.5', myRating: 4,
    reviews: [{ rating: 5, content: null, author: '김○○', mine: false, createdAt: '2026-09-11T00:00:00Z' }] };
  const parsed = validateReviews(ok);
  assert.equal(parsed.average, 4.5);
  assert.equal(parsed.reviews[0].content, null);
  assert.throws(() => validateReviews({ ...ok, count: -1 }));
  assert.throws(() => validateReviews({ ...ok, reviews: [{ ...ok.reviews[0], rating: 9 }] }));
  assert.throws(() => validateReviews({ ...ok, reviews: [{ ...ok.reviews[0], content: 'x'.repeat(501) }] }));
  assert.throws(() => validateReviews({ ...ok, myRating: 0 }));
});
test('client refuses impossible review and issue requests before calling the server', async () => {
  const { account } = setup(async () => { throw Error('server must not be called'); });
  assert.equal((await account.submitReview('글빛누리', 0, '')).code, 'RATING_REQUIRED');
  assert.equal((await account.submitReview('글빛누리', 3, 'x'.repeat(501))).code, 'REVIEW_TOO_LONG');
  assert.equal((await account.submitReview('', 3, '')).code, 'BOOTH_NOT_FOUND');
  assert.equal((await account.issueTag('글빛누리', 0)).code, 'INVALID_TAG_ISSUE_REQUEST');
  assert.equal((await account.issueTag('글빛누리', 10081)).code, 'INVALID_TAG_ISSUE_REQUEST');
});
test('issued tags must carry a real signed token', () => {
  const issued = { token, boothKey: '글빛누리', expiresAt: '2026-09-11T00:00:00Z', validMinutes: 60 };
  assert.equal(validateIssuedTag(issued).token, token);
  assert.throws(() => validateIssuedTag({ ...issued, token: 'NFC-G1-01' }));
  assert.throws(() => validateIssuedTag({ ...issued, validMinutes: 1.5 }));
});
test('a stamp claim never doubles as a review write', async () => {
  const seen = [];
  const { account } = setup(async (name) => { seen.push(name); return { data: { boothKey: '글빛누리', count: 0, average: null, myRating: null, reviews: [] } }; });
  await account.reviews('글빛누리');
  assert.deepEqual(seen, ['festival_booth_reviews']);
});
