const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createClient, validateRows, CLUB_IDS, CACHE_KEY, CACHE_MAX_AGE, PROJECT_URL } = require('../supabase-catalog.js');
const rows = Object.values(CLUB_IDS).map((id, index) => ({ id, name: id, rating: index ? 0 : 4, position: '' }));
const ok = data => ({ ok: true, json: async () => data });
function memoryStorage(value) {
  const data = new Map(value ? [[CACHE_KEY, JSON.stringify(value)]] : []);
  return { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), data };
}

test('only one public GET; no auth, personal IDs, or write requests', async () => {
  const storage = memoryStorage();
  const requests = [];
  const client = createClient({ storage, fetchImpl: async (url, options) => { requests.push({ url, options }); return ok(rows); } });
  const result = await client.refresh();
  assert.equal(result.status, 'ready');
  assert.equal(result.rows.length, 20);
  const { url, options } = requests[0];
  assert.equal(new URL(url).origin, PROJECT_URL);
  assert.equal(new URL(url).pathname, '/rest/v1/booths');
  assert.equal(new URL(url).searchParams.get('select'), 'id,name,rating,position');
  assert.equal(options.method, 'GET');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.redirect, 'error');
  assert.equal(options.body, undefined);
  assert.equal(options.headers.Authorization, undefined);
  assert.match(options.headers.apikey, /^sb_publishable_/);
  assert.deepEqual([...storage.data.keys()], [CACHE_KEY]);
});

test('all 20 club UUIDs map exactly, including renamed clubs', async () => {
  const client = createClient({ fetchImpl: async () => ok(rows) });
  await client.refresh();
  for (const [clubId, id] of Object.entries(CLUB_IDS)) assert.equal(client.forClub(clubId).id, id);
  assert.equal(client.forClub('97717b20-8448-4a30-8379-c7a7029541eb').name, '매커니즘');
  assert.equal(client.forClub('unknown'), null);
});

test('parallel refresh calls share one request', async () => {
  let count = 0;
  const client = createClient({ fetchImpl: async () => { count++; return ok(rows); } });
  await Promise.all(Array.from({ length: 20 }, () => client.refresh()));
  assert.equal(count, 1);
});

test('offline cache contains public rows only, last update is retained', async () => {
  const storage = memoryStorage({ version: 1, fetchedAt: 1000, rows });
  const client = createClient({ storage, now: () => 2000, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(client.getSnapshot().status, 'cached');
  const snapshot = await client.refresh();
  assert.equal(snapshot.status, 'offline');
  assert.equal(snapshot.fetchedAt, 1000);
  assert.equal(snapshot.rows[0].rating, 4);
});

test('old, future, or corrupt caches are discarded', () => {
  for (const fetchedAt of [0, CACHE_MAX_AGE + 101]) {
    const client = createClient({ storage: memoryStorage({ version: 1, fetchedAt, rows }), now: () => CACHE_MAX_AGE + 100 });
    assert.equal(client.getSnapshot().rows.length, 0);
  }
  assert.equal(createClient({ storage: { getItem: () => '{bad' } }).getSnapshot().status, 'idle');
});

test('HTTP failure can be retried; never uses a privileged fallback', async () => {
  let count = 0;
  const client = createClient({ fetchImpl: async () => ++count === 1 ? { ok: false, status: 403 } : ok(rows) });
  assert.equal((await client.refresh()).status, 'error');
  assert.equal((await client.refresh()).status, 'ready');
  assert.equal(count, 2);
});

test('timeout aborts and releases the refresh lock', async () => {
  let count = 0;
  const client = createClient({ timeoutMs: 10, fetchImpl: async (_url, options) => {
    if (++count > 1) return ok(rows);
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('timeout'))));
  } });
  assert.equal((await client.refresh()).status, 'error');
  assert.equal((await client.refresh()).status, 'ready');
});

test('invalid contracts cannot overwrite the last successful cache', async () => {
  const storage = memoryStorage({ version: 1, fetchedAt: 1000, rows });
  const before = storage.getItem(CACHE_KEY);
  const client = createClient({ storage, now: () => 2000, fetchImpl: async () => ok([{ ...rows[0], rating: '4' }]) });
  assert.equal((await client.refresh()).status, 'offline');
  assert.equal(storage.getItem(CACHE_KEY), before);
  for (const invalid of [null, {}, [rows[0], rows[0]], [{ ...rows[0], rating: 6 }], [{ ...rows[0], rating: null }], [{ ...rows[0], name: '' }]]) {
    assert.throws(() => validateRows(invalid), /INVALID_CATALOG/);
  }
});

test('storage denial still allows live reads', async () => {
  const storage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal((await createClient({ storage, fetchImpl: async () => ok(rows) }).refresh()).status, 'ready');
});

test('empty catalog replaces stale data; unexpected extra fields are dropped', async () => {
  assert.deepEqual(validateRows([{ ...rows[0], admin: true }]), [rows[0]]);
  const storage = memoryStorage({ version: 1, fetchedAt: 1000, rows });
  const client = createClient({ storage, now: () => 2000, fetchImpl: async () => ok([]) });
  assert.equal((await client.refresh()).rows.length, 0);
  assert.equal(client.forClub(Object.keys(CLUB_IDS)[0]), null);
});
