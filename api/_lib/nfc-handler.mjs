import { createHash, createHmac, randomUUID } from "node:crypto";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NFC_TOKEN_PATTERN = /^[A-Za-z0-9._~-]{16,512}$/;
const MAX_BODY_BYTES = 2048;
const UPSTREAM_TIMEOUT_MS = 5000;
const ALLOWED_RPC_STATUSES = new Set([200, 201, 400, 403, 404, 409, 422, 429, 503]);

function jsonResponse(status, payload, requestId, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "X-Request-Id": requestId,
      ...extraHeaders,
    },
  });
}

function errorPayload(code, message, requestId, retryable = false) {
  return {
    error: { code, message, retryable },
    meta: { requestId },
  };
}

function errorResponse(status, code, message, requestId, retryable = false, extraHeaders = {}) {
  return jsonResponse(status, errorPayload(code, message, requestId, retryable), requestId, extraHeaders);
}

function getEventId(url) {
  const match = new URL(url).pathname.match(/^\/api\/v1\/events\/([^/]+)\/stamps\/nfc\/?$/);
  if (!match) return null;

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function getBearerToken(request) {
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
  if (!match || match[1].length > 4096) return null;
  return match[1];
}

function normalizeSupabaseUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function readConfiguration(env) {
  const supabaseUrl = normalizeSupabaseUrl(env.SUPABASE_URL || "");
  const publishableKey = String(env.SUPABASE_PUBLISHABLE_KEY || "");
  const secretKey = String(env.SUPABASE_SECRET_KEY || "");
  const tokenPepper = String(env.NFC_TOKEN_PEPPER || "");

  if (!supabaseUrl || publishableKey.length < 10 || secretKey.length < 10 || tokenPepper.length < 32) return null;
  return { supabaseUrl, publishableKey, secretKey, tokenPepper };
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function parseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function rpcHeaders(secretKey) {
  const headers = {
    Accept: "application/json",
    apikey: secretKey,
    "Content-Type": "application/json; charset=utf-8",
  };

  // Legacy service_role JWTs require Authorization. New sb_secret_* keys use apikey routing.
  if (!secretKey.startsWith("sb_secret_")) headers.Authorization = `Bearer ${secretKey}`;
  return headers;
}

function normalizeRpcPayload(payload, requestId) {
  const value = Array.isArray(payload) && payload.length === 1 ? payload[0] : payload;
  if (!value || typeof value !== "object" || !Number.isInteger(value.status) || !value.body || typeof value.body !== "object") {
    return null;
  }

  const status = ALLOWED_RPC_STATUSES.has(value.status) ? value.status : null;
  if (!status) return null;

  const body = structuredClone(value.body);
  body.meta = { ...(body.meta || {}), requestId: body.meta?.requestId || requestId };
  return { status, body };
}

export function createNfcHandler({
  env = process.env,
  fetchImpl = globalThis.fetch,
  createRequestId = randomUUID,
} = {}) {
  return async function handleNfcRequest(request) {
    const requestId = createRequestId();

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          Allow: "POST, OPTIONS",
          "Cache-Control": "no-store, max-age=0",
          "X-Request-Id": requestId,
        },
      });
    }

    if (request.method !== "POST") {
      return errorResponse(405, "METHOD_NOT_ALLOWED", "POST requests are required.", requestId, false, { Allow: "POST, OPTIONS" });
    }

    const eventId = getEventId(request.url);
    if (!eventId || !UUID_PATTERN.test(eventId)) {
      return errorResponse(400, "EVENT_ID_INVALID", "The event identifier is invalid.", requestId);
    }

    const configuration = readConfiguration(env);
    if (!configuration) {
      return errorResponse(503, "SERVICE_NOT_CONFIGURED", "The NFC service is not configured.", requestId, true);
    }

    const accessToken = getBearerToken(request);
    if (!accessToken) {
      return errorResponse(401, "AUTH_REQUIRED", "Sign in before claiming a stamp.", requestId);
    }

    const contentType = request.headers.get("Content-Type") || "";
    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
      return errorResponse(415, "CONTENT_TYPE_UNSUPPORTED", "Use application/json.", requestId);
    }

    const contentLength = Number(request.headers.get("Content-Length") || 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return errorResponse(413, "REQUEST_TOO_LARGE", "The request body is too large.", requestId);
    }

    const idempotencyKey = request.headers.get("Idempotency-Key") || "";
    if (!UUID_PATTERN.test(idempotencyKey)) {
      return errorResponse(400, "IDEMPOTENCY_KEY_REQUIRED", "A UUID Idempotency-Key header is required.", requestId);
    }

    let rawBody;
    try {
      rawBody = await request.text();
    } catch {
      return errorResponse(400, "REQUEST_BODY_INVALID", "The request body could not be read.", requestId);
    }

    if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
      return errorResponse(413, "REQUEST_TOO_LARGE", "The request body is too large.", requestId);
    }

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return errorResponse(400, "REQUEST_BODY_INVALID", "The request body must be valid JSON.", requestId);
    }

    const nfcToken = typeof body?.token === "string" ? body.token : "";
    if (!NFC_TOKEN_PATTERN.test(nfcToken)) {
      return errorResponse(422, "NFC_TAG_INVALID", "The NFC token is invalid.", requestId);
    }

    let authResponse;
    try {
      authResponse = await fetchWithTimeout(fetchImpl, `${configuration.supabaseUrl}/auth/v1/user`, {
        method: "GET",
        headers: {
          Accept: "application/json",
          apikey: configuration.publishableKey,
          Authorization: `Bearer ${accessToken}`,
        },
      });
    } catch {
      return errorResponse(503, "AUTH_SERVICE_UNAVAILABLE", "Authentication is temporarily unavailable.", requestId, true);
    }

    if (!authResponse.ok) {
      if (authResponse.status === 401 || authResponse.status === 403) {
        return errorResponse(401, "AUTH_REQUIRED", "The session is invalid or expired.", requestId);
      }
      return errorResponse(503, "AUTH_SERVICE_UNAVAILABLE", "Authentication is temporarily unavailable.", requestId, true);
    }

    const authUser = await parseJson(authResponse);
    if (!authUser || !UUID_PATTERN.test(String(authUser.id || ""))) {
      return errorResponse(503, "AUTH_SERVICE_INVALID_RESPONSE", "Authentication returned an invalid response.", requestId, true);
    }

    const tokenDigest = createHmac("sha256", configuration.tokenPepper).update(nfcToken, "utf8").digest("hex");
    const requestDigest = createHash("sha256").update(`${eventId}\n${tokenDigest}`, "utf8").digest("hex");

    let rpcResponse;
    try {
      rpcResponse = await fetchWithTimeout(fetchImpl, `${configuration.supabaseUrl}/rest/v1/rpc/claim_nfc_stamp`, {
        method: "POST",
        headers: rpcHeaders(configuration.secretKey),
        body: JSON.stringify({
          p_event_id: eventId,
          p_actor_id: authUser.id,
          p_token_digest_hex: tokenDigest,
          p_idempotency_key: idempotencyKey,
          p_request_digest_hex: requestDigest,
          p_request_id: requestId,
        }),
      });
    } catch {
      return errorResponse(503, "STAMP_SERVICE_UNAVAILABLE", "Stamp processing is temporarily unavailable.", requestId, true);
    }

    const rpcPayload = await parseJson(rpcResponse);
    if (!rpcResponse.ok) {
      return errorResponse(503, "STAMP_SERVICE_UNAVAILABLE", "Stamp processing is temporarily unavailable.", requestId, true);
    }

    const result = normalizeRpcPayload(rpcPayload, requestId);
    if (!result) {
      return errorResponse(502, "STAMP_SERVICE_INVALID_RESPONSE", "Stamp processing returned an invalid response.", requestId, true);
    }

    return jsonResponse(result.status, result.body, result.body.meta.requestId);
  };
}
