// Web Push with WebCrypto only, so the same code runs in the Supabase Edge Function (Deno) and in the
// Node unit test: RFC 8291 message encryption (aes128gcm, RFC 8188) and RFC 8292 VAPID.
const enc = new TextEncoder();

export const b64u = {
  encode(bytes) {
    let text = '';
    for (const b of bytes) text += String.fromCharCode(b);
    return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(value) {
    const text = atob(String(value).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '='));
    return Uint8Array.from(text, ch => ch.charCodeAt(0));
  },
};

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

// One record (rs 4096): salt(16) | rs(4) | idlen(1) | sender public key(65) | ciphertext.
// salt and serverKeys are only passed by tests.
export async function encrypt(plaintext, p256dh, authSecret, { salt, serverKeys } = {}) {
  const ua = b64u.decode(p256dh), auth = b64u.decode(authSecret);
  const server = serverKeys || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', server.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, server.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(enc.encode('WebPush: info\0'), ua, asPublic), 32);
  const nonceSalt = salt || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(nonceSalt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(nonceSalt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(plaintext, new Uint8Array([2]))));
  const header = new Uint8Array(86);
  header.set(nonceSalt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = 65;
  header.set(asPublic, 21);
  return concat(header, sealed);
}

// vapid: { publicKey: base64url of the 65-byte point, privateKey: base64url of d, subject: 'mailto:…' or https URL }.
export async function vapidHeader(endpoint, vapid, now = Date.now()) {
  const point = b64u.decode(vapid.publicKey);
  const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: b64u.encode(point.slice(1, 33)), y: b64u.encode(point.slice(33, 65)), d: vapid.privateKey, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const part = value => b64u.encode(enc.encode(JSON.stringify(value)));
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: vapid.subject })}`;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned)));
  return `vapid t=${unsigned}.${b64u.encode(signature)}, k=${vapid.publicKey}`;
}

// Returns the push service's HTTP status. topic (≤ 32 URL-safe characters) replaces an undelivered
// earlier message with the same topic, so a phone that was offline gets only the latest place in line.
export async function send(subscription, message, vapid, { ttl = 600, urgency = 'high', topic, fetcher = fetch } = {}) {
  const body = await encrypt(enc.encode(JSON.stringify(message)), subscription.p256dh, subscription.auth);
  const headers = { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(ttl), Urgency: urgency,
    Authorization: await vapidHeader(subscription.endpoint, vapid) };
  if (topic) headers.Topic = topic;
  const response = await fetcher(subscription.endpoint, { method: 'POST', headers, body });
  return response.status;
}
