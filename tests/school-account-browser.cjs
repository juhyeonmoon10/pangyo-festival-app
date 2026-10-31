// First login with a @pangyo.hs.kr Google account named "21001홍길동": the onboarding screen fills in
// the 학번 and the name; the student confirms with one tap and that is what gets saved.
// Every Supabase request is answered locally.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const { PROJECT_URL, CLUB_IDS } = require('../supabase-catalog.js');
const site = path.resolve(__dirname, '..');
const output = path.join(site, 'artifacts/school-account');
const uid = 'a0000000-0000-4000-8000-000000000002';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: uid, exp: 4102444800, role: 'authenticated', iss: PROJECT_URL + '/auth/v1' })}.fixture`;

async function run(browser, { email, googleName }) {
  const page = await browser.newPage({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true });
  const errors = [], saved = [];
  let metadata = { full_name: googleName };
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(({ jwt, uid }) => {
    localStorage.setItem('pangyo-google-session-v1', JSON.stringify({ access_token: jwt, refresh_token: 'fixture', token_type: 'bearer', expires_at: 4102444800, expires_in: 3600, user: { id: uid } }));
  }, { jwt, uid });
  const user = () => ({ id: uid, aud: 'authenticated', role: 'authenticated', email, app_metadata: { provider: 'google' }, user_metadata: metadata,
    identities: [{ provider: 'google', identity_data: { full_name: googleName, email } }] });
  const profile = () => {
    const name = (metadata.festival_name || '').trim(), sid = metadata.festival_student_number || '';
    return { id: 7, authUserId: uid, name, email, studentNumber: sid, needsProfile: !(name && /^[1-3][0-9]{4}$/.test(sid)), isAdmin: false, completedBooths: [] };
  };
  await page.route(`${PROJECT_URL}/**`, async route => {
    const req = route.request(), pathname = new URL(req.url()).pathname;
    if (pathname === '/rest/v1/booths') return route.fulfill({ json: Object.values(CLUB_IDS).map(id => ({ id, name: id, rating: 0, position: '' })) });
    if (pathname === '/auth/v1/user' && req.method() === 'GET') return route.fulfill({ json: user() });
    if (pathname === '/auth/v1/user' && req.method() === 'PUT') {
      const data = req.postDataJSON().data || {};
      saved.push(data); metadata = { ...metadata, ...data };
      return route.fulfill({ json: user() });
    }
    if (pathname === '/rest/v1/rpc/festival_nfc_profile') return route.fulfill({ json: profile() });
    return route.fulfill({ status: 404, json: { code: 'PGRST202', message: 'Missing optional function' } });
  });
  await page.goto(pathToFileURL(path.join(site, 'index.html')).href);
  await page.locator('#profileSubmit').waitFor();
  return { page, errors, saved };
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  try {
    // School account: 학번 and name come from the Google name.
    const school = await run(browser, { email: 'student@pangyo.hs.kr', googleName: '21001홍길동' });
    assert.equal(await school.page.locator('#studentNumber').inputValue(), '21001');
    assert.match(await school.page.locator('[data-student-number-detected]').innerText(), /학번 21001을\(를\) 찾았어요/);
    assert.equal(await school.page.locator('.login-account strong').innerText(), '홍길동');
    assert.equal(await school.page.locator('#name').count(), 0);
    await school.page.screenshot({ path: path.join(output, '390-school-detected.png'), fullPage: true });
    await school.page.locator('#profileSubmit').click();
    await school.page.waitForFunction(() => state.user?.studentNumber === '21001');
    assert.deepEqual(school.saved, [{ festival_name: '홍길동', festival_student_number: '21001' }]);
    assert.equal(await school.page.evaluate(() => state.user.name), '홍길동');
    assert.deepEqual(school.errors, []);

    // A four-letter name, and the student may still correct the 학번 before saving.
    const corrected = await run(browser, { email: 'student@pangyo.hs.kr', googleName: '30105남궁민수' });
    assert.equal(await corrected.page.locator('#studentNumber').inputValue(), '30105');
    assert.equal(await corrected.page.locator('.login-account strong').innerText(), '남궁민수');
    await corrected.page.locator('#studentNumber').fill('30106');
    await corrected.page.locator('#profileSubmit').click();
    await corrected.page.waitForFunction(() => state.user?.studentNumber === '30106');
    assert.deepEqual(corrected.saved, [{ festival_name: '남궁민수', festival_student_number: '30106' }]);
    assert.deepEqual(corrected.errors, []);

    // Other accounts keep the manual entry: nothing is guessed.
    const other = await run(browser, { email: 'someone@gmail.com', googleName: '21001홍길동' });
    assert.equal(await other.page.locator('#studentNumber').inputValue(), '');
    assert.equal(await other.page.locator('[data-student-number-detected]').count(), 0);
    await other.page.screenshot({ path: path.join(output, '390-other-account.png'), fullPage: true });
    assert.deepEqual(other.errors, []);
    console.log(JSON.stringify({ passed: true, flows: ['school account detected', 'four-letter name and correction', 'other domain not guessed'] }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
