// In-memory PostgreSQL only. No network, real accounts, or shared DB writes.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const dependency = path.join(process.env.PGLITE_DIR || here, 'node_modules/@electric-sql/pglite/dist');
const { PGlite } = await import(pathToFileURL(path.join(dependency, 'index.js')).href);
const { pgcrypto } = await import(pathToFileURL(path.join(dependency, 'contrib/pgcrypto.js')).href);
const db = new PGlite({ extensions: { pgcrypto } });
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const migration = read('nfc-server/updates/20260930-nonexpiring-tags.sql');
const out = path.join(root, 'artifacts/nfc-permanent');
fs.mkdirSync(out, { recursive: true });
const results = [];
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const names = "('claim', 'issue_tag', 'admin_issue')";
const definitions = async () => (await db.query(`select proname as name, pg_get_functiondef(p.oid) as definition
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='festival_nfc_private' and proname in ${names} order by proname`)).rows;
async function check(name, fn) {
  try { const detail = await fn(); results.push({ name, ok: true, detail }); console.log('PASS', name); }
  catch (error) { results.push({ name, ok: false, error: error.message }); console.log('FAIL', name, error.message); await db.exec('rollback').catch(() => {}); }
}
async function rpc(user, expression, role = 'authenticated') {
  try {
    await db.exec('begin');
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user.id, session_id: user.session, role })]);
    await db.exec(`set local role ${role}`);
    const row = await one(`select ${expression} as value`);
    await db.exec('commit');
    return row.value;
  } catch (error) { await db.exec('rollback'); throw error; }
}
async function account(admin = false) {
  const id = randomUUID(), session = randomUUID();
  await db.query(`insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data)
    values ($1,$2,now(),' {"provider":"google"}', '{"festival_name":"Fixture","festival_student_number":"21001"}')`, [id, `${id}@example.invalid`]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [session, id]);
  const user = { id, session };
  await rpc(user, 'public.festival_nfc_profile()');
  if (admin) await db.query('update public.users set admin=true where auth_user_id=$1', [id]);
  return user;
}
const claim = (user, token) => rpc(user, `public.festival_nfc_claim('${token}')`);
const issue = (user, minutes = 'null') => rpc(user, `public.festival_nfc_admin_issue('글빛누리', ${minutes})`);
const payload = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
async function mintRaw(value) {
  return (await one(`select 'nf1.'||encoded||'.'||encode(extensions.hmac(convert_to('nf1.'||encoded,'UTF8'),decode(cfg->>'key','hex'),'sha256'),'hex') as token
    from (select decrypted_secret::jsonb as cfg from vault.decrypted_secrets where name='pangyo_festival_nfc_v1') config,
    lateral (select rtrim(translate(replace(encode(convert_to(($1::jsonb || jsonb_build_object('epoch',cfg->>'epoch'))::text,'UTF8'),'base64'),chr(10),''),'+/','-_'),'=') as encoded) body`, [value])).token;
}
async function catalog() {
  const query = async sql => (await db.query(sql)).rows;
  return {
    columns: await query("select table_schema,table_name,column_name,data_type from information_schema.columns where table_schema in ('public','festival_nfc_private') order by 1,2,3"),
    policies: await query("select schemaname,tablename,policyname,cmd,roles::text,qual,with_check from pg_policies order by 1,2,3"),
    grants: await query("select grantee,table_schema,table_name,privilege_type from information_schema.table_privileges where table_schema='public' order by 1,2,3,4"),
    functions: await query("select n.nspname,p.proname,p.proacl::text,p.proowner,p.prosecdef,p.proconfig::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','festival_nfc_private') order by 1,2"),
  };
}

await db.exec(read('nfc-server/isolated-test/shim.sql'));
await db.exec(read('nfc-server/install.sql'));
await db.exec(read('nfc-server/admin-issue.sql'));
const admin = await account(true), student = await account(), other = await account();
const finite = await issue(admin, '60');
const baseline = await definitions();
const rollback = `begin; set local search_path=public;\n${baseline.map(row => row.definition.trim()+';').join('\n')}\ncommit;`;
fs.writeFileSync(path.join(out, 'isolated-rollback.sql'), rollback);
const before = await catalog();
await check('01 migration preserves tables, columns, policies, owners, grants and security modes', async () => {
  await db.exec(migration);
  assert.deepEqual(await catalog(), before);
});
await check('02 deployed source matches the tested baseline when a server snapshot is available', () => {
  const file = path.join(out, 'server-before.json');
  if (!fs.existsSync(file)) return 'No server snapshot provided; local baseline only';
  const live = JSON.parse(fs.readFileSync(file, 'utf8'));
  const body = value => value.split('$function$')[1].replace(/\s+/g, ' ').trim();
  for (const row of baseline) assert.equal(body(live.find(item => item.name === row.name).definition), body(row.definition), row.name);
  return 'Three deployed bodies match the baseline';
});
let permanent;
await check('03 administrator issues an explicitly signed permanent tag without an expiry', async () => {
  permanent = await issue(admin);
  assert.equal(permanent.expiresAt, null);
  assert.equal(permanent.validMinutes, null);
  const data = payload(permanent.token);
  assert.equal(data.expires, null);
  assert.equal(data.lifetime, 'permanent');
  assert.match(data.nonce, /^[0-9a-f]{32}$/);
  assert.ok(data.epoch);
  return { lifetime: data.lifetime, urlBytes: Buffer.byteLength(`https://pangyo-festival-app.vercel.app/#t=${permanent.token}`) };
});
await check('04 permanent tag records exactly one visit per student and booth', async () => {
  assert.equal((await claim(student, permanent.token)).result, 'EARNED');
  assert.equal((await claim(student, permanent.token)).result, 'ALREADY_EARNED');
  const reissued = await issue(admin);
  assert.notEqual(reissued.token, permanent.token);
  assert.equal((await claim(student, reissued.token)).result, 'ALREADY_EARNED');
  assert.equal((await claim(other, permanent.token)).result, 'EARNED');
  assert.equal((await one('select cardinality(completed_booths) as n from public.users where auth_user_id=$1', [student.id])).n, 1);
});
await check('05 pre-update finite tags retain their original expiry', async () => {
  assert.equal((await claim(student, finite.token)).result, 'ALREADY_EARNED');
  const expired = await mintRaw({ booth: '글빛누리', expires: 0 });
  await assert.rejects(claim(student, expired), /NFC_TAG_EXPIRED/);
});
await check('06 missing expiry, unknown lifetime and malformed permanent tokens fail closed', async () => {
  for (const data of [
    { booth: '글빛누리' }, { booth: '글빛누리', expires: null },
    { booth: '글빛누리', expires: null, lifetime: 'forever', nonce: 'a'.repeat(32) },
    { booth: '글빛누리', expires: null, lifetime: 'permanent' },
    { booth: '글빛누리', lifetime: 'permanent', nonce: 'a'.repeat(32) },
    { booth: '글빛누리', expires: 9999999999, lifetime: 'permanent', nonce: 'a'.repeat(32) },
  ]) await assert.rejects(claim(student, await mintRaw(data)), /NFC_TAG_EXPIRED/);
});
await check('07 changing a finite token into a permanent one invalidates its signature', async () => {
  const data = { ...payload(finite.token), expires: null, lifetime: 'permanent' };
  const forged = `nf1.${Buffer.from(JSON.stringify(data)).toString('base64url')}.${finite.token.split('.')[2]}`;
  await assert.rejects(claim(student, forged), /NFC_TAG_INVALID/);
});
await check('08 students and anonymous users still cannot issue tags or read the signing secret', async () => {
  await assert.rejects(issue(student), /ADMIN_REQUIRED/);
  await assert.rejects(rpc(student, "festival_nfc_private.admin_issue('글빛누리',null)"), /ADMIN_REQUIRED/);
  await assert.rejects(rpc(student, "public.festival_nfc_admin_issue('글빛누리',null)", 'anon'), /permission denied/);
  await assert.rejects(rpc(student, "festival_nfc_private.issue_tag('글빛누리',null)"), /permission denied/);
  await assert.rejects(rpc(admin, '(select decrypted_secret from vault.decrypted_secrets limit 1)'), /permission denied/);
});
await check('09 invalid finite durations and missing booths remain rejected', async () => {
  for (const minutes of ['0', '-1', '10081']) await assert.rejects(issue(admin, minutes), /INVALID_TAG_ISSUE_REQUEST/);
  for (const minutes of ['1', '10080']) assert.notEqual((await issue(admin, minutes)).expiresAt, null);
  await assert.rejects(rpc(admin, "public.festival_nfc_admin_issue('없는부스',null)"), /NFC_TAG_INVALID/);
});
await check('10 an expired Google session cannot issue or claim a permanent tag', async () => {
  await db.query("update auth.sessions set not_after=now()-interval '1 minute' where id in ($1,$2)", [admin.session, student.session]);
  await assert.rejects(issue(admin), /GOOGLE_AUTH_REQUIRED/);
  await assert.rejects(claim(student, permanent.token), /GOOGLE_AUTH_REQUIRED/);
  await db.exec('update auth.sessions set not_after=null');
});
await check('11 emergency disable still blocks both issuing and visits', async () => {
  await db.exec(`select vault.update_secret(id,(decrypted_secret::jsonb||'{"enabled":false}')::text) from vault.decrypted_secrets where name='pangyo_festival_nfc_v1'`);
  await assert.rejects(issue(admin), /NFC_DISABLED/);
  await assert.rejects(claim(student, permanent.token), /NFC_DISABLED/);
  await db.exec(`select vault.update_secret(id,(decrypted_secret::jsonb||'{"enabled":true}')::text) from vault.decrypted_secrets where name='pangyo_festival_nfc_v1'`);
});
await check('12 rollback rejects permanent tags, preserves visits and keeps finite tags valid', async () => {
  await db.exec(rollback);
  assert.deepEqual(await definitions(), baseline);
  assert.deepEqual(await catalog(), before);
  await assert.rejects(issue(admin), /INVALID_TAG_ISSUE_REQUEST/);
  await assert.rejects(claim(student, permanent.token), /NFC_TAG_EXPIRED/);
  assert.equal((await claim(student, finite.token)).result, 'ALREADY_EARNED');
  assert.equal((await one('select cardinality(completed_booths) as n from public.users where auth_user_id=$1', [student.id])).n, 1);
  await db.exec(migration);
  await assert.rejects(db.exec(migration), /NFC_SOURCE_CHANGED_REVIEW_REQUIRED/);
  await db.exec('rollback');
  assert.equal((await claim(student, permanent.token)).result, 'ALREADY_EARNED');
});
await check('13 epoch rotation revokes permanent and finite tags without changing visits', async () => {
  await db.exec(`select vault.update_secret(id,(decrypted_secret::jsonb||jsonb_build_object('epoch',encode(extensions.gen_random_bytes(16),'hex')))::text) from vault.decrypted_secrets where name='pangyo_festival_nfc_v1'`);
  await assert.rejects(claim(student, permanent.token), /NFC_TAG_EXPIRED/);
  await assert.rejects(claim(student, finite.token), /NFC_TAG_EXPIRED/);
  assert.equal((await claim(student, (await issue(admin)).token)).result, 'ALREADY_EARNED');
});
const failed = results.filter(result => !result.ok).length;
fs.writeFileSync(path.join(out, 'isolated-report.json'), JSON.stringify({ ranAt: new Date().toISOString(),
  environment: 'PGlite 0.5.8 with auth and Vault shims, synthetic accounts only; no shared DB connection',
  notVerified: ['real OAuth', 'Vault encryption', 'concurrent DB connections', 'physical NFC'], failed, results }, null, 2));
await db.close();
console.log(`${results.length - failed}/${results.length} checks passed`);
process.exitCode = failed ? 1 : 0;
