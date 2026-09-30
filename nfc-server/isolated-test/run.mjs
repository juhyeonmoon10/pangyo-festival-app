// Isolated verification of ../install.sql, ../database-rollback.sql, ../disable.sql and ../uninstall.sql
// inside an in-process PGlite database. It never connects to the shared Supabase project.
// Usage: node run.mjs  (PGLITE_DIR must point at a folder whose node_modules contains @electric-sql/pglite)
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const nfcDir = path.resolve(here, '..');
const appDir = path.resolve(nfcDir, '..');
const pgliteDir = process.env.PGLITE_DIR || here;
const pgliteRoot = path.join(pgliteDir, 'node_modules/@electric-sql/pglite/dist');
const { PGlite } = await import(pathToFileURL(path.join(pgliteRoot, 'index.js')).href);
const { pgcrypto } = await import(pathToFileURL(path.join(pgliteRoot, 'contrib/pgcrypto.js')).href);

const read = f => fs.readFileSync(f, 'utf8');
const installSql = read(path.join(nfcDir, 'install.sql'));
const rollbackSql = read(path.join(nfcDir, 'database-rollback.sql'));
const disableSql = read(path.join(nfcDir, 'disable.sql'));
const uninstallSql = read(path.join(nfcDir, 'uninstall.sql'));
const adminSql = read(path.join(nfcDir, 'admin-issue.sql'));
const reviewsSql = read(path.join(nfcDir, 'reviews.sql'));
const verifyRunSql = read(path.join(nfcDir, 'verify-run.sql'));
const TOKEN_PATTERN = /^nf1\.[A-Za-z0-9_-]+\.[0-9a-f]{64}$/;
const shimSql = read(path.join(here, 'shim.sql'));

const db = new PGlite({ extensions: { pgcrypto } });
const results = [];
let failures = 0;
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? null });
    console.log('PASS', name, detail === undefined ? '' : JSON.stringify(detail));
  } catch (error) {
    failures++;
    results.push({ name, ok: false, error: String(error?.message || error) });
    console.log('FAIL', name, error?.message || error);
    await db.exec('rollback').catch(() => {});
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function asRole(role, claims, body, { commit = true } = {}) {
  const claimSql = claims ? `select set_config('request.jwt.claims', '${JSON.stringify(claims).replace(/'/g, "''")}', true);` : '';
  try {
    return await db.exec(`begin; ${claimSql} set local role ${role}; ${body}; reset role; ${commit ? 'commit' : 'rollback'};`);
  } catch (error) {
    await db.exec('rollback').catch(() => {});
    throw error;
  }
}
async function rpc(claims, call, opts) {
  const res = await asRole('authenticated', claims, `select ${call} as r`, opts);
  return res.find(item => item.rows?.length && 'r' in item.rows[0]).rows[0].r;
}
function rowsOf(res, column) {
  return res.find(item => item.fields?.some(f => f.name === column)).rows;
}
async function expectError(pattern, fn) {
  try { await fn(); } catch (error) {
    if (pattern.test(error.message)) return error.message.split('\n')[0];
    throw new Error(`unexpected error: ${error.message}`);
  }
  throw new Error(`expected error matching ${pattern}`);
}
async function snapshot() {
  const policies = (await db.query(`select policyname, cmd, roles::text as roles, qual, with_check from pg_policies where schemaname='public' and tablename='users' order by policyname`)).rows;
  const grants = (await db.query(`select grantee, privilege_type from information_schema.role_table_grants where table_schema='public' and table_name='users' and grantee in ('anon','authenticated') order by 1,2`)).rows;
  const columnGrants = (await db.query(`select grantee, column_name, privilege_type from information_schema.role_column_grants where table_schema='public' and table_name='users' and grantee in ('anon','authenticated') order by 1,2,3`)).rows;
  const installed = (await one(`select exists(select 1 from pg_namespace where nspname='festival_nfc_private') as v`)).v;
  const publicFunctions = (await one(`select count(*)::int as v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'festival_nfc_%'`)).v;
  const vaultSecrets = (await one(`select count(*)::int as v from vault.secrets where name='pangyo_festival_nfc_v1'`)).v;
  return { policies, grants, columnGrants, installed, publicFunctions, vaultSecrets };
}

// ---- fixtures -------------------------------------------------------------
const users = {};
async function addAuthUser(key, { provider = 'google', confirmed = true, banned = false, meta = {}, session = true, email } = {}) {
  const id = randomUUID();
  const sessionId = randomUUID();
  const address = email || `${key}-${id}@example.invalid`;
  await db.query(`insert into auth.users(id,email,email_confirmed_at,banned_until,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    values($1,$2,$3,$4,$5,$6,now(),now())`,
    [id, address, confirmed ? new Date() : null, banned ? new Date(Date.now() + 3600e3) : null,
      { provider, providers: [provider] }, { full_name: `Fixture ${key}`, ...meta }]);
  if (session) await db.query(`insert into auth.sessions(id,user_id,created_at,updated_at) values($1,$2,now(),now())`, [sessionId, id]);
  users[key] = { id, sessionId, claims: { sub: id, role: 'authenticated', session_id: sessionId }, email: address };
  return users[key];
}
const complete = { festival_name: '테스트 학생', festival_student_number: '21001' };
const issue = async (booth, interval = '1 hour') =>
  (await one(`select festival_nfc_private.issue_tag($1::public.booth_enum, now() + $2::interval) as t`, [booth, interval])).t;
const mintRaw = async payload => (await one(`
  select 'nf1.'||enc||'.'||encode(extensions.hmac(convert_to('nf1.'||enc,'UTF8'),decode(cfg->>'key','hex'),'sha256'),'hex') as t
  from (select decrypted_secret::jsonb cfg from vault.decrypted_secrets where name='pangyo_festival_nfc_v1') c,
  lateral (select rtrim(translate(replace(encode(convert_to(($1::jsonb || case when $2 then jsonb_build_object('epoch', cfg->>'epoch') else '{}'::jsonb end)::text,'UTF8'),'base64'),chr(10),''),'+/','-_'),'=') enc) e`,
  [payload, !('epoch' in payload)])).t;

// ---- phase A: baseline ------------------------------------------------------
await db.exec(shimSql);
const baseline = await snapshot();
await check('A. baseline matches before-permissions.json', async () => {
  assert(!baseline.installed && baseline.publicFunctions === 0 && baseline.vaultSecrets === 0, 'clean baseline expected');
  const select = baseline.policies.find(p => p.policyname === 'users_authenticated_select');
  const update = baseline.policies.find(p => p.policyname === 'users_authenticated_update');
  assert(select?.qual === 'true' && update?.qual === 'true' && update?.with_check === '(money >= 0)', JSON.stringify(baseline.policies));
  assert(same(baseline.grants.map(g => g.privilege_type), ['SELECT', 'UPDATE']), JSON.stringify(baseline.grants));
  return baseline.grants;
});

// ---- phase B: install + database-rollback.sql as documented ------------------
await check('B. the ready-to-paste verify-run.sql passes and leaves no trace', async () => {
  // The generated file is what a person actually pastes, so test that file, not a rebuilt string.
  const cut = installSql.lastIndexOf('commit;');
  assert(cut > 0, 'install.sql must end with commit;');
  assert(verifyRunSql.includes(installSql.slice(0, cut).trimEnd()), 'verify-run.sql is stale; rebuild it');
  assert(verifyRunSql.trimEnd().endsWith(rollbackSql.trimEnd()), 'verify-run.sql is stale; rebuild it');
  assert(!verifyRunSql.split('\n').some(line => line.trim() === 'commit;'), 'verify-run.sql must never commit');
  const res = await db.exec(verifyRunSql);
  const verification = res.at(-1)?.rows?.[0]?.verification;
  assert(typeof verification === 'string' && verification.startsWith('PASS'), `verification row: ${verification}`);
  assert(same(await snapshot(), baseline), 'state changed after rollback');
  return verification;
});

// ---- phase C: real install in the isolated database --------------------------
let installed;
await check('C1. install.sql commits and rewrites users permissions', async () => {
  await db.exec(installSql);
  installed = await snapshot();
  assert(installed.installed && installed.publicFunctions === 2 && installed.vaultSecrets === 1, JSON.stringify(installed));
  const select = installed.policies.find(p => p.policyname === 'users_authenticated_select');
  const update = installed.policies.find(p => p.policyname === 'users_authenticated_update');
  assert(/auth_user_id = \( ?SELECT auth\.uid\(\)/.test(select.qual), select.qual);
  assert(update.qual === 'false' && update.with_check === 'false', JSON.stringify(update));
  assert(same(installed.grants, [{ grantee: 'authenticated', privilege_type: 'SELECT' }]), JSON.stringify(installed.grants));
  assert(installed.columnGrants.every(g => g.privilege_type === 'SELECT'), JSON.stringify(installed.columnGrants));
  return { policies: installed.policies.map(p => `${p.policyname}: using ${p.qual} check ${p.with_check}`), grants: installed.grants };
});
await check('C2. running install.sql twice is refused without partial changes', async () => {
  const guard = installSql.slice(installSql.indexOf('do $$'), installSql.indexOf('end $$;') + 'end $$;'.length);
  const message = await expectError(/NFC_ALREADY_INSTALLED_REVIEW_BEFORE_UPDATING/, () => db.query(guard));
  await expectError(/NFC_ALREADY_INSTALLED_REVIEW_BEFORE_UPDATING/, () => db.exec(installSql));
  await db.exec('rollback'); // the aborted transaction is discarded, exactly as the SQL editor would on error
  assert(same(await snapshot(), installed), 'second run changed state');
  return message;
});

// ---- phase D: behaviour -----------------------------------------------------
const A = await addAuthUser('A', { meta: complete });
const B = await addAuthUser('B');
const C = await addAuthUser('C', { provider: 'email', meta: complete });
const D = await addAuthUser('D', { confirmed: false, meta: complete });
const E = await addAuthUser('E', { banned: true, meta: complete });
const F = await addAuthUser('F', { meta: complete, email: 'legacy-row@example.invalid' });
const G = await addAuthUser('G', { meta: complete, email: 'taken-row@example.invalid' });
const H = await addAuthUser('H', { meta: complete, session: false });
await db.query(`insert into public.users(email, name, money, completed_booths) values($1,'Legacy Student',1500,'{}')`, [F.email]);
await db.query(`insert into public.users(auth_user_id, email, name) values($1,$2,'Someone Else')`, [randomUUID(), G.email]);
await db.query(`insert into public.users(auth_user_id, email, name, money, admin) values($1,'other-team-user@example.invalid','Other Team',3000,true)`, [randomUUID()]);

await check('D1. anon cannot call profile or claim', async () => [
  await expectError(/permission denied/, () => asRole('anon', { role: 'anon' }, `select public.festival_nfc_profile()`)),
  await expectError(/permission denied/, () => asRole('anon', { role: 'anon' }, `select public.festival_nfc_claim('nf1.x.${'0'.repeat(64)}')`)),
]);
await check('D2. authenticated without a JWT subject -> AUTH_REQUIRED', () =>
  expectError(/AUTH_REQUIRED/, () => rpc({ role: 'authenticated' }, 'public.festival_nfc_profile()')));
await check('D3. complete Google user gets own profile and a users row is created', async () => {
  const p = await rpc(A.claims, 'public.festival_nfc_profile()');
  assert(p.authUserId === A.id && p.needsProfile === false && p.name === '테스트 학생' && p.studentNumber === '21001' && same(p.completedBooths, []), JSON.stringify(p));
  const row = await one(`select count(*)::int as n from public.users where auth_user_id=$1`, [A.id]);
  assert(row.n === 1, 'row count');
  return p;
});
await check('D4. RLS: student sees only own row; direct UPDATE denied (the other-team impact)', async () => {
  const rows = rowsOf(await asRole('authenticated', A.claims, `select auth_user_id from public.users`), 'auth_user_id');
  assert(rows.length === 1 && rows[0].auth_user_id === A.id, `visible rows: ${JSON.stringify(rows)}`);
  return [
    await expectError(/permission denied for table users/, () => asRole('authenticated', A.claims, `update public.users set money = 999 where auth_user_id = '${A.id}'`)),
    await expectError(/permission denied for table users/, () => asRole('authenticated', A.claims, `update public.users set completed_booths = '{글빛누리}' where auth_user_id = '${A.id}'`)),
    await expectError(/permission denied for table users/, () => asRole('authenticated', A.claims, `update public.users set admin = true where auth_user_id = '${A.id}'`)),
  ];
});
await check('D5. Google user without name/student number -> needsProfile, claim refused', async () => {
  const p = await rpc(B.claims, 'public.festival_nfc_profile()');
  assert(p.needsProfile === true, JSON.stringify(p));
  const token = await issue('글빛누리');
  return await expectError(/PROFILE_REQUIRED/, () => rpc(B.claims, `public.festival_nfc_claim('${token}')`));
});
await check('D6. non-Google provider -> GOOGLE_AUTH_REQUIRED', () => expectError(/GOOGLE_AUTH_REQUIRED/, () => rpc(C.claims, 'public.festival_nfc_profile()')));
await check('D7. unconfirmed email -> GOOGLE_AUTH_REQUIRED', () => expectError(/GOOGLE_AUTH_REQUIRED/, () => rpc(D.claims, 'public.festival_nfc_profile()')));
await check('D8. banned account -> GOOGLE_AUTH_REQUIRED', () => expectError(/GOOGLE_AUTH_REQUIRED/, () => rpc(E.claims, 'public.festival_nfc_profile()')));
await check('D9. JWT whose session_id has no auth.sessions row -> GOOGLE_AUTH_REQUIRED', () =>
  expectError(/GOOGLE_AUTH_REQUIRED/, () => rpc({ sub: H.id, role: 'authenticated', session_id: randomUUID() }, 'public.festival_nfc_profile()')));
await check('D10. existing row with same email and null auth_user_id is linked, money preserved', async () => {
  const p = await rpc(F.claims, 'public.festival_nfc_profile()');
  const row = await one(`select id, money, auth_user_id from public.users where email=$1`, [F.email]);
  assert(row.auth_user_id === F.id && row.money === 1500 && p.id === row.id, JSON.stringify({ p, row }));
  return { linkedId: row.id, money: row.money };
});
await check('D11. same email already linked to another auth user -> PROFILE_CONFLICT', () =>
  expectError(/PROFILE_CONFLICT/, () => rpc(G.claims, 'public.festival_nfc_profile()')));

let token1, token2;
await check('D12. first claim, duplicate, second booth, another student reuses the same tag', async () => {
  token1 = await issue('글빛누리'); token2 = await issue('매커니즘');
  const r1 = await rpc(A.claims, `public.festival_nfc_claim('${token1}')`);
  assert(r1.result === 'EARNED' && r1.boothKey === '글빛누리' && same(r1.completedBooths, ['글빛누리']), JSON.stringify(r1));
  const r2 = await rpc(A.claims, `public.festival_nfc_claim('${token1}')`);
  assert(r2.result === 'ALREADY_EARNED' && same(r2.completedBooths, ['글빛누리']), JSON.stringify(r2));
  const r3 = await rpc(A.claims, `public.festival_nfc_claim('${token2}')`);
  assert(r3.result === 'EARNED' && same(r3.completedBooths, ['글빛누리', '매커니즘']), JSON.stringify(r3));
  const r4 = await rpc(F.claims, `public.festival_nfc_claim('${token1}')`);
  assert(r4.result === 'EARNED' && same(r4.completedBooths, ['글빛누리']), JSON.stringify(r4));
  const other = await one(`select money, to_jsonb(completed_booths) as completed_booths from public.users where email='other-team-user@example.invalid'`);
  assert(other.money === 3000 && same(other.completed_booths, []), 'unrelated row touched');
  return { A: r3.completedBooths, F: r4.completedBooths, tokenLength: token1.length, urlBytes: Buffer.byteLength(`pangyofestival://nfc#t=${token1}`) };
});
await check('D13. forged / malformed / oversized tokens -> NFC_TAG_INVALID', async () => {
  const flipped = token1.slice(0, -1) + (token1.at(-1) === 'a' ? 'b' : 'a');
  const [head, payload, sig] = token1.split('.');
  return [
    await expectError(/NFC_TAG_INVALID/, () => rpc(A.claims, `public.festival_nfc_claim('${flipped}')`)),
    await expectError(/NFC_TAG_INVALID/, () => rpc(A.claims, `public.festival_nfc_claim('${head}.${payload}.${'0'.repeat(64)}')`)),
    await expectError(/NFC_TAG_INVALID/, () => rpc(A.claims, `public.festival_nfc_claim('nf2.${payload}.${sig}')`)),
    await expectError(/NFC_TAG_INVALID/, () => rpc(A.claims, `public.festival_nfc_claim('NFC-G1-01')`)),
    await expectError(/NFC_TAG_INVALID/, () => rpc(A.claims, `public.festival_nfc_claim('nf1.${'A'.repeat(1100)}.${'0'.repeat(64)}')`)),
    await expectError(/NFC_TAG_INVALID/, () => rpc(A.claims, `public.festival_nfc_claim(null)`)),
  ];
});
await check('D14. expired / wrong-epoch / malformed payload with a valid signature -> NFC_TAG_EXPIRED', async () => [
  await expectError(/NFC_TAG_EXPIRED/, async () => rpc(A.claims, `public.festival_nfc_claim('${await mintRaw({ booth: '글빛누리', expires: 0 })}')`)),
  await expectError(/NFC_TAG_EXPIRED/, async () => rpc(A.claims, `public.festival_nfc_claim('${await mintRaw({ booth: '글빛누리', expires: 9999999999, epoch: 'stale' })}')`)),
  await expectError(/NFC_TAG_EXPIRED/, async () => rpc(A.claims, `public.festival_nfc_claim('${await mintRaw({ booth: '글빛누리' })}')`)),
  await expectError(/NFC_TAG_EXPIRED/, async () => rpc(A.claims, `public.festival_nfc_claim('${await mintRaw({ booth: '없는부스', expires: 9999999999 })}')`)),
]);
await check('D15. issue_tag limits: past, >7 days, unknown booth; students cannot mint or read the Vault', async () => [
  await expectError(/INVALID_TAG_ISSUE_REQUEST/, () => issue('글빛누리', '-1 minute')),
  await expectError(/INVALID_TAG_ISSUE_REQUEST/, () => issue('글빛누리', '8 days')),
  await expectError(/invalid input value for enum/, () => issue('없는부스')),
  await expectError(/permission denied/, () => asRole('authenticated', A.claims, `select festival_nfc_private.issue_tag('글빛누리', now() + interval '1 hour')`)),
  await expectError(/permission denied/, () => asRole('authenticated', A.claims, `select * from vault.decrypted_secrets`)),
]);
await check('D16. booth removed from public.booths -> NFC_TAG_INVALID even with a valid signature', async () => {
  const token = await issue('네온');
  await db.query(`delete from public.booths where id='네온'`);
  const message = await expectError(/NFC_TAG_INVALID/, () => rpc(A.claims, `public.festival_nfc_claim('${token}')`));
  await db.query(`insert into public.booths(id,name) values('네온','네온')`);
  return message;
});
await check('D17. rotating the epoch invalidates old tags; new tags work', async () => {
  await db.query(`select vault.update_secret(id, (decrypted_secret::jsonb || jsonb_build_object('epoch', encode(extensions.gen_random_bytes(16),'hex')))::text) from vault.decrypted_secrets where name='pangyo_festival_nfc_v1'`);
  const old = await expectError(/NFC_TAG_EXPIRED/, () => rpc(A.claims, `public.festival_nfc_claim('${token2}')`));
  const fresh = await issue('인사이트');
  const r = await rpc(A.claims, `public.festival_nfc_claim('${fresh}')`);
  assert(r.result === 'EARNED' && r.completedBooths.length === 3, JSON.stringify(r));
  return old;
});
await check('D18. enabled=false stops claims and minting without deleting data', async () => {
  await db.query(`select vault.update_secret(id, (decrypted_secret::jsonb || '{"enabled": false}')::text) from vault.decrypted_secrets where name='pangyo_festival_nfc_v1'`);
  const mint = await expectError(/NFC_DISABLED/, () => issue('패러다임'));
  const claim = await expectError(/NFC_DISABLED/, () => rpc(A.claims, `public.festival_nfc_claim('${token1}')`));
  await db.query(`select vault.update_secret(id, (decrypted_secret::jsonb || '{"enabled": true}')::text) from vault.decrypted_secrets where name='pangyo_festival_nfc_v1'`);
  const row = await one(`select to_jsonb(completed_booths) as completed_booths from public.users where auth_user_id=$1`, [A.id]);
  assert(row.completed_booths.length === 3, 'data lost');
  return [mint, claim];
});
await check('D19. expired auth.sessions row -> GOOGLE_AUTH_REQUIRED', async () => {
  await db.query(`update auth.sessions set not_after = now() - interval '1 minute' where id=$1`, [F.sessionId]);
  return expectError(/GOOGLE_AUTH_REQUIRED/, () => rpc(F.claims, 'public.festival_nfc_profile()'));
});
await check('D20. profile exposes only own-account fields; money is never returned', async () => {
  const p = await rpc(A.claims, 'public.festival_nfc_profile()');
  const keys = Object.keys(p).sort().join();
  assert(keys === 'authUserId,completedBooths,email,id,isAdmin,name,needsProfile,studentNumber', keys);
  assert(p.isAdmin === false, 'a plain student must not be reported as an administrator');
  return Object.keys(p);
});

// ---- phase E: disable.sql --------------------------------------------------
await check('E. disable.sql blocks both RPCs, keeps rows and own-row SELECT', async () => {
  await db.exec(disableSql);
  const out = [
    await expectError(/permission denied/, () => rpc(A.claims, 'public.festival_nfc_profile()')),
    await expectError(/permission denied/, () => rpc(A.claims, `public.festival_nfc_claim('${token1}')`)),
  ];
  const rows = rowsOf(await asRole('authenticated', A.claims, `select to_jsonb(completed_booths) as completed_booths from public.users`), 'completed_booths');
  assert(rows.length === 1 && rows[0].completed_booths.length === 3, JSON.stringify(rows));
  const enabled = (await one(`select (decrypted_secret::jsonb->>'enabled')::boolean as v from vault.decrypted_secrets where name='pangyo_festival_nfc_v1'`)).v;
  assert(enabled === false, 'vault flag not cleared');
  assert(same((await snapshot()).policies, installed.policies), 'disable changed policies');
  return out;
});

// ---- phase F: uninstall.sql -------------------------------------------------
await check('F1. uninstall.sql restores the 2026-09-09 permissions exactly; stamp data survives', async () => {
  await db.exec(uninstallSql);
  const after = await snapshot();
  assert(same(after, baseline), `diff:\n${JSON.stringify(after, null, 1)}\nvs\n${JSON.stringify(baseline, null, 1)}`);
  const row = await one(`select to_jsonb(completed_booths) as completed_booths from public.users where auth_user_id=$1`, [A.id]);
  assert(row.completed_booths.length === 3, 'stamp data must survive uninstall');
  return { policies: after.policies.map(p => `${p.policyname}: using ${p.qual} check ${p.with_check}`), grants: after.grants };
});
await check('F2. install.sql can be applied again after uninstall (fresh signing key rejects old tags)', async () => {
  await db.exec(installSql);
  const s = await snapshot();
  assert(s.installed && s.vaultSecrets === 1, JSON.stringify(s));
  return await expectError(/NFC_TAG_EXPIRED|NFC_TAG_INVALID/, () => rpc(A.claims, `public.festival_nfc_claim('${token1}')`));
});

// ---- phase G: admin-issue.sql (draft admin tag issuance) ----------------------
let adminInstalled;
await check('G1. admin-issue.sql applies after install; second run refused without changes', async () => {
  await db.exec(adminSql);
  adminInstalled = await snapshot();
  assert(adminInstalled.publicFunctions === 3, JSON.stringify(adminInstalled));
  assert(same(adminInstalled.policies, installed.policies) && same(adminInstalled.grants, installed.grants), 'admin-issue.sql must not touch users permissions');
  const message = await expectError(/NFC_ADMIN_ISSUE_ALREADY_INSTALLED_REVIEW_BEFORE_UPDATING/, () => db.exec(adminSql));
  await db.exec('rollback');
  assert(same(await snapshot(), adminInstalled), 'second run changed state');
  return message;
});
const I = await addAuthUser('I', { meta: complete });
await check('G2. anon, ordinary students, users without a row, and no-session accounts cannot issue', async () => [
  await expectError(/permission denied/, () => asRole('anon', { role: 'anon' }, `select public.festival_nfc_admin_issue('글빛누리', 60)`)),
  await expectError(/ADMIN_REQUIRED/, () => rpc(A.claims, `public.festival_nfc_admin_issue('글빛누리', 60)`)),
  await expectError(/ADMIN_REQUIRED/, () => rpc(B.claims, `public.festival_nfc_admin_issue('글빛누리', 60)`)),
  await expectError(/ADMIN_REQUIRED/, () => rpc(I.claims, `public.festival_nfc_admin_issue('글빛누리', 60)`)),
  await expectError(/GOOGLE_AUTH_REQUIRED/, () => rpc({ sub: H.id, role: 'authenticated', session_id: randomUUID() }, `public.festival_nfc_admin_issue('글빛누리', 60)`)),
  // the private implementation is callable by authenticated (same pattern as claim) and enforces the flag itself
  await expectError(/ADMIN_REQUIRED/, () => asRole('authenticated', A.claims, `select festival_nfc_private.admin_issue('글빛누리', 60)`)),
]);
let adminToken;
await check('G3. users.admin=true (set by the team, not by the app) can issue; a student claims that token', async () => {
  await db.query(`update public.users set admin = true where auth_user_id = $1`, [A.id]);
  await db.query(`update auth.sessions set not_after = null where id = $1`, [F.sessionId]); // D19 expired it
  const issued = await rpc(A.claims, `public.festival_nfc_admin_issue('레브', 60)`);
  assert(TOKEN_PATTERN.test(issued.token) && issued.boothKey === '레브' && issued.validMinutes === 60, JSON.stringify(issued));
  const delta = (new Date(issued.expiresAt) - Date.now()) / 60000;
  assert(delta > 59 && delta <= 60, `expiresAt drift: ${delta}`);
  adminToken = issued.token;
  const r = await rpc(F.claims, `public.festival_nfc_claim('${adminToken}')`);
  assert(r.result === 'EARNED' && r.completedBooths.includes('레브'), JSON.stringify(r));
  const again = await rpc(F.claims, `public.festival_nfc_claim('${adminToken}')`);
  assert(again.result === 'ALREADY_EARNED', JSON.stringify(again));
  return { boothKey: issued.boothKey, student: r.completedBooths, urlBytes: Buffer.byteLength(`pangyofestival://nfc#t=${adminToken}`) };
});
await check('G4. issuance input limits: minutes 1..10080, booth must exist', async () => {
  const max = await rpc(A.claims, `public.festival_nfc_admin_issue('네온', 10080)`);
  const min = await rpc(A.claims, `public.festival_nfc_admin_issue('네온', 1)`);
  assert(TOKEN_PATTERN.test(max.token) && TOKEN_PATTERN.test(min.token) && max.token !== min.token, 'boundary tokens');
  return [
    await expectError(/INVALID_TAG_ISSUE_REQUEST/, () => rpc(A.claims, `public.festival_nfc_admin_issue('네온', 0)`)),
    await expectError(/INVALID_TAG_ISSUE_REQUEST/, () => rpc(A.claims, `public.festival_nfc_admin_issue('네온', 10081)`)),
    await expectError(/INVALID_TAG_ISSUE_REQUEST/, () => rpc(A.claims, `public.festival_nfc_admin_issue('네온', null)`)),
    await expectError(/NFC_TAG_INVALID/, () => rpc(A.claims, `public.festival_nfc_admin_issue('없는부스', 60)`)),
    await expectError(/NFC_TAG_INVALID/, () => rpc(A.claims, `public.festival_nfc_admin_issue(null, 60)`)),
    await expectError(/NFC_TAG_INVALID/, () => rpc(A.claims, `public.festival_nfc_admin_issue('${'x'.repeat(200)}', 60)`)),
  ];
});
await check('G5. disabled Vault flag and expired admin session block issuance; admin still cannot read the Vault', async () => {
  await db.query(`select vault.update_secret(id, (decrypted_secret::jsonb || '{"enabled": false}')::text) from vault.decrypted_secrets where name='pangyo_festival_nfc_v1'`);
  const disabled = await expectError(/NFC_DISABLED/, () => rpc(A.claims, `public.festival_nfc_admin_issue('네온', 60)`));
  await db.query(`select vault.update_secret(id, (decrypted_secret::jsonb || '{"enabled": true}')::text) from vault.decrypted_secrets where name='pangyo_festival_nfc_v1'`);
  await db.query(`update auth.sessions set not_after = now() - interval '1 minute' where id=$1`, [A.sessionId]);
  const expired = await expectError(/GOOGLE_AUTH_REQUIRED/, () => rpc(A.claims, `public.festival_nfc_admin_issue('네온', 60)`));
  await db.query(`update auth.sessions set not_after = null where id=$1`, [A.sessionId]);
  const vault = await expectError(/permission denied/, () => asRole('authenticated', A.claims, `select * from vault.decrypted_secrets`));
  return [disabled, expired, vault];
});
await check('G6. issued token respects epoch rotation like operator tokens', async () => {
  await db.query(`select vault.update_secret(id, (decrypted_secret::jsonb || jsonb_build_object('epoch', encode(extensions.gen_random_bytes(16),'hex')))::text) from vault.decrypted_secrets where name='pangyo_festival_nfc_v1'`);
  const old = await expectError(/NFC_TAG_EXPIRED/, () => rpc(I.claims, `public.festival_nfc_claim('${adminToken}')`));
  const fresh = await rpc(A.claims, `public.festival_nfc_admin_issue('레브', 30)`);
  const r = await rpc(I.claims, `public.festival_nfc_claim('${fresh.token}')`);
  assert(r.result === 'EARNED', JSON.stringify(r));
  return old;
});
// ---- phase H: reviews.sql (real booth reviews) --------------------------------
await check('H1. reviews.sql applies after install, adds the nullable content column, refuses a second run', async () => {
  await db.exec(reviewsSql);
  const column = await one(`select data_type, is_nullable from information_schema.columns
    where table_schema='public' and table_name='booth_ratings' and column_name='content'`);
  assert(column?.data_type === 'text' && column.is_nullable === 'YES', JSON.stringify(column));
  const s = await snapshot();
  assert(same(s.policies, installed.policies) && same(s.grants, installed.grants), 'reviews.sql must not touch users permissions');
  const message = await expectError(/NFC_REVIEWS_ALREADY_INSTALLED_REVIEW_BEFORE_UPDATING/, () => db.exec(reviewsSql));
  await db.exec('rollback');
  return message;
});
await check('H2. an unrated booth reports zero count, no average and no own rating', async () => {
  const r = await rpc(A.claims, `public.festival_booth_reviews('글빛누리')`);
  assert(r.count === 0 && r.average === null && r.myRating === null && same(r.reviews, []), JSON.stringify(r));
  return r;
});
await check('H3. a review requires a recorded visit, a profile, and a real booth', async () => [
  await expectError(/VISIT_REQUIRED/, () => rpc(A.claims, `public.festival_review_submit('네온', 5, null)`)),
  await expectError(/PROFILE_REQUIRED/, () => rpc(B.claims, `public.festival_review_submit('글빛누리', 5, null)`)),
  await expectError(/BOOTH_NOT_FOUND/, () => rpc(A.claims, `public.festival_review_submit('없는부스', 5, null)`)),
  await expectError(/permission denied/, () => asRole('anon', { role: 'anon' }, `select public.festival_booth_reviews('글빛누리')`)),
  await expectError(/permission denied/, () => asRole('anon', { role: 'anon' }, `select public.festival_review_submit('글빛누리', 5, null)`)),
]);
await check('H4. star-only and star-plus-text reviews save; the same booth cannot be reviewed twice', async () => {
  const first = await rpc(A.claims, `public.festival_review_submit('글빛누리', 4, null)`);
  assert(first.result === 'SAVED' && first.count === 1 && Number(first.average) === 4 && first.myRating === 4, JSON.stringify(first));
  assert(first.reviews[0].content === null && first.reviews[0].mine === true, JSON.stringify(first.reviews));
  const duplicate = await expectError(/ALREADY_REVIEWED/, () => rpc(A.claims, `public.festival_review_submit('글빛누리', 1, '바꿔치기')`));
  const second = await rpc(F.claims, `public.festival_review_submit('글빛누리', 5, '  재미있었어요  ')`);
  assert(second.count === 2 && Number(second.average) === 4.5, JSON.stringify(second));
  const written = second.reviews.find(item => item.mine);
  assert(written.content === '재미있었어요', `content must be trimmed: ${JSON.stringify(written)}`);
  return { duplicate, average: second.average, authors: second.reviews.map(item => item.author) };
});
await check('H5. other students appear under a masked name and own ratings are never overwritten', async () => {
  const stored = await one(`select name from public.users where auth_user_id=$1`, [F.id]);
  const seen = await rpc(A.claims, `public.festival_booth_reviews('글빛누리')`);
  const others = seen.reviews.filter(item => !item.mine);
  assert(others.length === 1 && others[0].rating === 5, JSON.stringify(others));
  const masked = others[0].author;
  assert(masked[0] === stored.name[0] && /^.○+$/.test(masked) && masked.length === stored.name.length,
    `mask must keep only the first character of ${JSON.stringify(stored.name)}: ${masked}`);
  assert(!seen.reviews.some(item => String(item.author).includes(stored.name.slice(1))), 'full name leaked');
  assert(seen.myRating === 4, 'own rating must survive another student review');
  const rows = await one(`select count(*)::int as n from public.booth_ratings where booth_id='글빛누리'`);
  assert(rows.n === 2, 'exactly two stored rows');
  return { storedName: stored.name, published: masked };
});
await check('H6. rating bounds and text length are enforced', async () => [
  await expectError(/RATING_REQUIRED/, () => rpc(I.claims, `public.festival_review_submit('레브', 0, null)`)),
  await expectError(/RATING_REQUIRED/, () => rpc(I.claims, `public.festival_review_submit('레브', 6, null)`)),
  await expectError(/RATING_REQUIRED/, () => rpc(I.claims, `public.festival_review_submit('레브', null, null)`)),
  await expectError(/REVIEW_TOO_LONG/, () => rpc(I.claims, `public.festival_review_submit('레브', 3, '${'가'.repeat(501)}')`)),
]);
await check('H7. my_reviews lists only the caller\'s own rated booths', async () => {
  const mine = await rpc(A.claims, `public.festival_my_reviews()`);
  const other = await rpc(F.claims, `public.festival_my_reviews()`);
  const none = await rpc(I.claims, `public.festival_my_reviews()`);
  assert(same(mine, ['글빛누리']) && same(other, ['글빛누리']) && same(none, []), JSON.stringify({ mine, other, none }));
  await expectError(/permission denied/, () => asRole('anon', { role: 'anon' }, `select public.festival_my_reviews()`));
  return { mine, none };
});

// ---- phase Z: teardown ---------------------------------------------------------
await check('Z1. disable.sql blocks every RPC; uninstall.sql removes them and restores baseline', async () => {
  await db.exec(disableSql);
  const blocked = [
    await expectError(/permission denied/, () => rpc(A.claims, `public.festival_nfc_admin_issue('레브', 30)`)),
    await expectError(/permission denied/, () => rpc(A.claims, `public.festival_booth_reviews('글빛누리')`)),
    await expectError(/permission denied/, () => rpc(A.claims, `public.festival_review_submit('레브', 3, null)`)),
  ];
  await db.exec(uninstallSql);
  const after = await snapshot();
  assert(same(after, baseline), `diff: ${JSON.stringify(after)}`);
  const kept = await one(`select count(*)::int as n from public.booth_ratings`);
  assert(kept.n === 2, 'uninstall must not delete stored reviews');
  const orphanAdmin = await expectError(/NFC_INSTALL_REQUIRED_FIRST/, () => db.exec(adminSql));
  await db.exec('rollback');
  const orphanReviews = await expectError(/NFC_INSTALL_REQUIRED_FIRST/, () => db.exec(reviewsSql));
  await db.exec('rollback');
  assert(same(await snapshot(), baseline), 'add-on files on a clean database must not leave anything');
  return [...blocked, orphanAdmin, orphanReviews];
});

const report = {
  ranAt: new Date().toISOString(),
  environment: 'PGlite (in-process PostgreSQL 17) with auth/vault shims from shim.sql; the shared Supabase project was not contacted',
  notVerifiedHere: ['Supabase Vault encryption', 'GoTrue session issuance and JWT signing', 'PostgREST RPC transport', 'concurrent sessions (single connection)', 'physical NFC cards', 'Google OAuth'],
  failures, results,
};
const outDir = path.join(appDir, 'artifacts/nfc-isolated-db');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
console.log(`\n${results.length - failures}/${results.length} checks passed -> ${path.join(outDir, 'report.json')}`);
await db.close();
process.exit(failures ? 1 : 0);
