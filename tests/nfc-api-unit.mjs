import assert from "node:assert/strict";
import test from "node:test";

import { createNfcHandler } from "../api/_lib/nfc-handler.mjs";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const IDEMPOTENCY_KEY = "33333333-3333-4333-8333-333333333333";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const STAMP_ID = "55555555-5555-4555-8555-555555555555";
const BOOTH_ID = "66666666-6666-4666-8666-666666666666";
const RAW_TOKEN = "nfc_token_for_unit_test_01";

const ENV = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_unit_test",
  SUPABASE_SECRET_KEY: "sb_secret_unit_test_value",
  NFC_TOKEN_PEPPER: "unit-test-pepper-with-at-least-32-characters",
};

function request({
  method = "POST",
  eventId = EVENT_ID,
  token = RAW_TOKEN,
  idempotencyKey = IDEMPOTENCY_KEY,
  authorization = "Bearer user-access-token",
  contentType = "application/json",
  body,
} = {}) {
  const headers = new Headers();
  if (authorization) headers.set("Authorization", authorization);
  if (contentType) headers.set("Content-Type", contentType);
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);

  return new Request(`https://festival.test/api/v1/events/${eventId}/stamps/nfc`, {
    method,
    headers,
    body: method === "POST" ? (body ?? JSON.stringify({ token })) : undefined,
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function read(response) {
  return { status: response.status, body: await response.json(), headers: response.headers };
}

test("fails closed when server configuration is missing", async () => {
  let calls = 0;
  const handler = createNfcHandler({
    env: {},
    fetchImpl: async () => { calls += 1; return json({}); },
    createRequestId: () => REQUEST_ID,
  });

  const result = await read(await handler(request()));
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, "SERVICE_NOT_CONFIGURED");
  assert.equal(calls, 0);
});

test("requires a valid bearer session", async () => {
  const handler = createNfcHandler({ env: ENV, createRequestId: () => REQUEST_ID });
  const result = await read(await handler(request({ authorization: null })));

  assert.equal(result.status, 401);
  assert.equal(result.body.error.code, "AUTH_REQUIRED");
});

test("rejects malformed event, idempotency, content type, and token inputs", async (t) => {
  const handler = createNfcHandler({
    env: ENV,
    fetchImpl: async () => { throw new Error("validation should run before fetch"); },
    createRequestId: () => REQUEST_ID,
  });

  await t.test("event id", async () => {
    const result = await read(await handler(request({ eventId: "event-2026" })));
    assert.equal(result.body.error.code, "EVENT_ID_INVALID");
  });

  await t.test("idempotency key", async () => {
    const result = await read(await handler(request({ idempotencyKey: "same-key" })));
    assert.equal(result.body.error.code, "IDEMPOTENCY_KEY_REQUIRED");
  });

  await t.test("content type", async () => {
    const result = await read(await handler(request({ contentType: "text/plain" })));
    assert.equal(result.status, 415);
  });

  await t.test("token", async () => {
    const result = await read(await handler(request({ token: "short" })));
    assert.equal(result.status, 422);
    assert.equal(result.body.error.code, "NFC_TAG_INVALID");
  });
});

test("rejects an expired Supabase access token", async () => {
  const handler = createNfcHandler({
    env: ENV,
    fetchImpl: async (url) => {
      assert.match(String(url), /\/auth\/v1\/user$/);
      return json({ message: "invalid token" }, 401);
    },
    createRequestId: () => REQUEST_ID,
  });

  const result = await read(await handler(request()));
  assert.equal(result.status, 401);
  assert.equal(result.body.error.code, "AUTH_REQUIRED");
});

test("verifies the user then sends only digests to the stamp RPC", async () => {
  const calls = [];
  const handler = createNfcHandler({
    env: ENV,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith("/auth/v1/user")) return json({ id: USER_ID });

      return json({
        status: 201,
        body: {
          data: {
            result: "EARNED",
            stamp: {
              id: STAMP_ID,
              boothId: BOOTH_ID,
              method: "nfc",
              earnedAt: "2026-12-18T01:23:45.000Z",
            },
          },
          meta: { requestId: REQUEST_ID },
        },
        replayed: false,
      });
    },
    createRequestId: () => REQUEST_ID,
  });

  const result = await read(await handler(request()));
  assert.equal(result.status, 201);
  assert.equal(result.body.data.result, "EARNED");
  assert.equal(result.headers.get("X-Request-Id"), REQUEST_ID);
  assert.equal(calls.length, 2);

  const authHeaders = new Headers(calls[0].options.headers);
  assert.equal(authHeaders.get("apikey"), ENV.SUPABASE_PUBLISHABLE_KEY);
  assert.equal(authHeaders.get("Authorization"), "Bearer user-access-token");

  const rpcHeaders = new Headers(calls[1].options.headers);
  const rpcBody = JSON.parse(calls[1].options.body);
  assert.equal(rpcHeaders.get("apikey"), ENV.SUPABASE_SECRET_KEY);
  assert.equal(rpcHeaders.get("Authorization"), null);
  assert.equal(rpcBody.p_actor_id, USER_ID);
  assert.equal(rpcBody.p_event_id, EVENT_ID);
  assert.equal(rpcBody.p_idempotency_key, IDEMPOTENCY_KEY);
  assert.match(rpcBody.p_token_digest_hex, /^[0-9a-f]{64}$/);
  assert.match(rpcBody.p_request_digest_hex, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(calls[1].options.body, new RegExp(RAW_TOKEN));
});

test("returns an existing stamp as a successful idempotent result", async () => {
  let call = 0;
  const handler = createNfcHandler({
    env: ENV,
    fetchImpl: async () => {
      call += 1;
      if (call === 1) return json({ id: USER_ID });
      return json({
        status: 200,
        body: {
          data: {
            result: "ALREADY_EARNED",
            stamp: { id: STAMP_ID, boothId: BOOTH_ID, method: "nfc", earnedAt: "2026-12-18T01:23:45.000Z" },
          },
          meta: { requestId: REQUEST_ID },
        },
        replayed: true,
      });
    },
    createRequestId: () => REQUEST_ID,
  });

  const result = await read(await handler(request()));
  assert.equal(result.status, 200);
  assert.equal(result.body.data.result, "ALREADY_EARNED");
});

test("does not expose upstream Supabase errors", async () => {
  let call = 0;
  const handler = createNfcHandler({
    env: ENV,
    fetchImpl: async () => {
      call += 1;
      if (call === 1) return json({ id: USER_ID });
      return json({ message: "database internals", details: "sensitive SQL" }, 500);
    },
    createRequestId: () => REQUEST_ID,
  });

  const result = await read(await handler(request()));
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, "STAMP_SERVICE_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(result.body), /database internals|sensitive SQL/);
});
