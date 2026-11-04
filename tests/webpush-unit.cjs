// Web Push encryption and VAPID of the waiting-push Edge Function (supabase/functions/waiting-push/webpush.js),
// checked against an independent receiver written with node:crypto (RFC 8291 / RFC 8188 / RFC 8292).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../supabase/functions/waiting-push/webpush.js')).href);
const b64u = buffer => Buffer.from(buffer).toString('base64url');

function browser() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { ecdh, p256dh: b64u(ecdh.getPublicKey()), auth: b64u(crypto.randomBytes(16)) };
}

// What a browser does with the request body.
function decrypt(body, receiver) {
  const salt = body.subarray(0, 16), rs = body.readUInt32BE(16), idlen = body[20];
  const senderKey = body.subarray(21, 21 + idlen), sealed = body.subarray(21 + idlen);
  const shared = receiver.ecdh.computeSecret(senderKey);
  const ua = receiver.ecdh.getPublicKey();
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), ua, senderKey]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(receiver.auth, 'base64url'), info, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  return { rs, idlen, text: plain.subarray(0, plain.lastIndexOf(2)).toString('utf8'), delimiter: plain[plain.lastIndexOf(2)] };
}

function vapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return { publicKey: b64u(point), privateKey: jwk.d, subject: 'mailto:festival@example.invalid', key: publicKey };
}

test('a message encrypted for a subscription is read back by the browser side', async () => {
  const { encrypt } = await load();
  const receiver = browser();
  const message = JSON.stringify({ title: '테스트 부스 웨이팅 순서 안내', body: '대기번호 3번 · 현재 대기순번 2번째 · 현재 대기 5팀 · 예상 대기시간 약 5분' });
  const body = Buffer.from(await encrypt(new TextEncoder().encode(message), receiver.p256dh, receiver.auth));
  const read = decrypt(body, receiver);
  assert.deepEqual([read.rs, read.idlen, read.delimiter, read.text], [4096, 65, 2, message]);
  assert.ok(body.length < 4096);
});

test('a different browser cannot read it', async () => {
  const { encrypt } = await load();
  const receiver = browser(), stranger = browser();
  const body = Buffer.from(await encrypt(new TextEncoder().encode('비밀'), receiver.p256dh, receiver.auth));
  assert.throws(() => decrypt(body, { ...stranger, auth: receiver.auth }));
});

test('the VAPID header is an ES256 JWT for the push service origin, signed by the key it names', async () => {
  const { vapidHeader } = await load();
  const keys = vapidKeys();
  const now = Date.UTC(2026, 10, 4, 3, 0, 0);
  const header = await vapidHeader('https://fcm.googleapis.com/fcm/send/abc', keys, now);
  const [, jwt, k] = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, keys.publicKey);
  const [h, p, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url')), { aud: 'https://fcm.googleapis.com', exp: now / 1000 + 43200, sub: keys.subject });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: keys.key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
});

test('send posts the encrypted body with the Web Push headers and returns the status', async () => {
  const { send } = await load();
  const receiver = browser(), keys = vapidKeys();
  let seen;
  const status = await send({ endpoint: 'https://push.example.invalid/x', p256dh: receiver.p256dh, auth: receiver.auth },
    { title: 't', body: 'b', url: '/waiting/1' }, keys, { topic: 'abc', fetcher: async (url, init) => { seen = { url, init }; return { status: 201 }; } });
  assert.equal(status, 201);
  assert.equal(seen.url, 'https://push.example.invalid/x');
  assert.deepEqual([seen.init.headers['Content-Encoding'], seen.init.headers.TTL, seen.init.headers.Urgency, seen.init.headers.Topic], ['aes128gcm', '600', 'high', 'abc']);
  assert.deepEqual(JSON.parse(decrypt(Buffer.from(seen.init.body), receiver).text), { title: 't', body: 'b', url: '/waiting/1' });
});
