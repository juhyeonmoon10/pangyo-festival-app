(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FestivalAccount = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const TOKEN_PATTERN = /^nf1\.[A-Za-z0-9_-]+\.[0-9a-f]{64}$/;
  const PENDING_KEY = "pangyo-pending-nfc-v1";
  const MESSAGES = {
    AUTH_REQUIRED: "로그인이 필요합니다.", GOOGLE_AUTH_REQUIRED: "Google 계정으로 다시 로그인해 주세요.",
    PROFILE_REQUIRED: "이름과 학번을 먼저 등록해 주세요.", PROFILE_CONFLICT: "계정 연결을 확인해야 합니다. 운영자에게 문의해 주세요.",
    NFC_DISABLED: "서버 방문 인증이 일시 중지되었습니다.", NFC_TAG_INVALID: "유효한 방문 태그가 아닙니다. 운영자에게 확인해 주세요.",
    NFC_TAG_EXPIRED: "태그의 사용 기간이 지났거나 교체되었습니다.",
    VISIT_REQUIRED: "방문 인증을 먼저 해야 별점을 남길 수 있어요.",
    ALREADY_REVIEWED: "이 부스에는 이미 별점을 남겼어요.",
    RATING_REQUIRED: "별점을 1~5점 중에서 선택해 주세요.",
    REVIEW_TOO_LONG: "글 후기는 500자 이하로 작성해 주세요.",
    BOOTH_NOT_FOUND: "서버에 등록된 부스가 아닙니다.",
    ADMIN_REQUIRED: "운영자 계정만 사용할 수 있는 기능입니다.",
    INVALID_TAG_ISSUE_REQUEST: "발급 조건을 확인해 주세요. 유효 기간은 1분에서 7일 사이입니다.",
    SERVER_NOT_READY: "서버 준비가 아직 끝나지 않았습니다. 운영자에게 설치 상태를 확인해 주세요. 지금은 데모 둘러보기를 사용할 수 있어요.",
  };

  function normalizeError(error) {
    const known = Object.keys(MESSAGES).find(code => String(error?.message || "").includes(code));
    // PGRST202 is PostgREST's "function is not in the schema cache": the install SQL has not
    // been applied yet. Reporting that as a network problem sends people chasing the wrong fix.
    const missing = error?.code === "PGRST202" || /schema cache/i.test(String(error?.message || ""));
    const code = known || (error?.status === 401 ? "AUTH_REQUIRED" : missing ? "SERVER_NOT_READY" : "NETWORK_ERROR");
    return { code, message: MESSAGES[code] || "서버 응답을 확인하지 못했습니다. 연결을 확인하고 다시 시도해 주세요.", retryable: code === "NETWORK_ERROR" };
  }

  function validateProfile(value) {
    if (!value || !Number.isInteger(value.id) || typeof value.authUserId !== "string"
      || typeof value.name !== "string" || value.name.length > 1000
      || typeof value.email !== "string" || typeof value.studentNumber !== "string"
      || typeof value.needsProfile !== "boolean" || !Array.isArray(value.completedBooths)
      || value.completedBooths.some(id => typeof id !== "string")) throw new Error("INVALID_PROFILE_RESPONSE");
    // Older installations do not report the flag; absent means "not an operator".
    if (value.isAdmin !== undefined && typeof value.isAdmin !== "boolean") throw new Error("INVALID_PROFILE_RESPONSE");
    return { ...value, isAdmin: value.isAdmin === true };
  }

  function validateReviews(value) {
    const rating = item => Number.isInteger(item) && item >= 1 && item <= 5;
    if (!value || typeof value.boothKey !== "string" || !Number.isInteger(value.count)
      || value.count < 0 || !Array.isArray(value.reviews) || value.reviews.length > 200
      || (value.average !== null && !(Number.isFinite(Number(value.average))))
      || (value.myRating !== null && !rating(value.myRating))) throw new Error("INVALID_REVIEW_RESPONSE");
    value.reviews.forEach(review => {
      if (!review || !rating(review.rating) || typeof review.author !== "string" || review.author.length > 200
        || typeof review.mine !== "boolean" || typeof review.createdAt !== "string"
        || (review.content !== null && (typeof review.content !== "string" || review.content.length > 500))) {
        throw new Error("INVALID_REVIEW_RESPONSE");
      }
    });
    return {
      boothKey: value.boothKey, count: value.count,
      average: value.average === null ? null : Number(value.average),
      myRating: value.myRating ?? null,
      reviews: value.reviews.map(review => ({
        rating: review.rating, content: review.content ?? null,
        author: review.author, mine: review.mine, createdAt: review.createdAt,
      })),
    };
  }

  function validateIssuedTag(value) {
    if (!value || !TOKEN_PATTERN.test(String(value.token || "")) || value.token.length > 1024
      || typeof value.boothKey !== "string" || typeof value.expiresAt !== "string"
      || !Number.isInteger(value.validMinutes)) throw new Error("INVALID_ISSUE_RESPONSE");
    return { token: value.token, boothKey: value.boothKey, expiresAt: value.expiresAt, validMinutes: value.validMinutes };
  }

  function createAccount({ sdk, config, storage, location, openUrl = url => { location.href = url; }, onChange = () => {} }) {
    const client = sdk.createClient(config.PROJECT_URL, config.PUBLISHABLE_KEY, {
      auth: { flowType: "pkce", detectSessionInUrl: false, persistSession: true, autoRefreshToken: true,
        storageKey: "pangyo-google-session-v1", storage },
      global: { fetch: async (url, options = {}) => {
        const controller = new AbortController();
        const cancel = () => controller.abort();
        options.signal?.addEventListener("abort", cancel, { once: true });
        const timer = setTimeout(cancel, 10000);
        try { return await fetch(url, { ...options, signal: controller.signal }); }
        finally { clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); }
      } },
    });
    const inFlight = new Map();
    let initializing = true;
    client.auth.onAuthStateChange((event) => {
      if (!initializing && ["SIGNED_IN", "SIGNED_OUT", "USER_UPDATED"].includes(event)) {
        setTimeout(() => onChange(event), 0);
      }
    });

    async function profile() {
      const { data, error } = await client.rpc("festival_nfc_profile");
      if (error) throw error;
      return validateProfile(data);
    }

    async function initialize() {
      try {
        const url = new URL(location.href);
        const code = url.searchParams.get("code");
        if (code) {
          const { error } = await client.auth.exchangeCodeForSession(code);
          url.searchParams.delete("code");
          if (typeof history !== "undefined") history.replaceState(null, "", url.pathname + url.search + url.hash);
          if (error) throw error;
        }
        const { data, error } = await client.auth.getSession();
        if (error) throw error;
        return data.session ? await profile() : null;
      } finally { initializing = false; }
    }

    async function signIn() {
      if (location.protocol === "file:") throw new Error("파일 미리보기에서는 로그인할 수 없습니다. 설치형 앱 또는 웹 주소에서 열어 주세요.");
      const native = location.origin === "https://appassets.androidplatform.net";
      const redirectTo = native ? "pangyofestival://auth/callback" : `${location.origin}${location.pathname}`;
      const { data, error } = await client.auth.signInWithOAuth({ provider: "google", options: {
        redirectTo, skipBrowserRedirect: true, queryParams: { prompt: "select_account" },
      } });
      if (error) throw error;
      const url = new URL(data.url);
      if (url.origin !== config.PROJECT_URL || url.pathname !== "/auth/v1/authorize") throw new Error("INVALID_AUTH_DESTINATION");
      openUrl(url.href);
    }

    async function receiveCallback(callbackUrl) {
      const url = new URL(callbackUrl);
      if (url.protocol !== "pangyofestival:" || url.hostname !== "auth" || url.pathname !== "/callback"
        || url.port || url.hash || url.username || url.password) throw new Error("INVALID_AUTH_CALLBACK");
      const code = url.searchParams.get("code");
      if (!code || code.length > 2048 || url.searchParams.getAll("code").length !== 1) throw new Error("INVALID_AUTH_CALLBACK");
      const { error } = await client.auth.exchangeCodeForSession(code);
      if (error) throw error;
      return profile();
    }

    async function updateProfile(name, studentNumber) {
      name = String(name).trim();
      studentNumber = String(studentNumber).trim();
      if (!name || name.length > 60 || !/^[1-3][0-9]{4}$/.test(studentNumber)) throw new Error("이름과 5자리 학번을 확인해 주세요.");
      const { error } = await client.auth.updateUser({ data: { festival_name: name, festival_student_number: studentNumber } });
      if (error) throw error;
      return profile();
    }

    function claim(token) {
      if (typeof token !== "string" || token.length > 1024 || !TOKEN_PATTERN.test(token)) {
        return Promise.resolve({ ok: false, ...normalizeError({ message: "NFC_TAG_INVALID" }) });
      }
      if (inFlight.has(token)) return inFlight.get(token);
      const request = Promise.resolve().then(async () => {
        try {
          const { data, error } = await client.rpc("festival_nfc_claim", { p_token: token });
          if (error) return { ok: false, ...normalizeError(error) };
          if (!data || !["EARNED", "ALREADY_EARNED"].includes(data.result) || typeof data.boothKey !== "string"
            || !Array.isArray(data.completedBooths) || data.completedBooths.some(id => typeof id !== "string")
            || !data.completedBooths.includes(data.boothKey)) throw new Error("INVALID_STAMP_RESPONSE");
          return { ok: true, ...data };
        } catch (error) { return { ok: false, ...normalizeError(error) }; }
        finally { inFlight.delete(token); }
      });
      inFlight.set(token, request);
      return request;
    }

    // Booth keys come from the app's explicit club mapping, never from user input.
    function boothKey(value) {
      return typeof value === "string" && value && value.length <= 120 ? value : null;
    }

    async function reviews(booth) {
      const key = boothKey(booth);
      if (!key) return { ok: false, ...normalizeError({ message: "BOOTH_NOT_FOUND" }) };
      try {
        const { data, error } = await client.rpc("festival_booth_reviews", { p_booth: key });
        if (error) return { ok: false, ...normalizeError(error) };
        return { ok: true, ...validateReviews(data) };
      } catch (error) { return { ok: false, ...normalizeError(error) }; }
    }

    async function myReviews() {
      try {
        const { data, error } = await client.rpc("festival_my_reviews");
        if (error) return { ok: false, ...normalizeError(error) };
        if (!Array.isArray(data) || data.length > 500 || data.some(id => typeof id !== "string")) {
          throw new Error("INVALID_REVIEW_RESPONSE");
        }
        return { ok: true, boothKeys: data };
      } catch (error) { return { ok: false, ...normalizeError(error) }; }
    }

    async function submitReview(booth, rating, content) {
      const key = boothKey(booth);
      if (!key) return { ok: false, ...normalizeError({ message: "BOOTH_NOT_FOUND" }) };
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return { ok: false, ...normalizeError({ message: "RATING_REQUIRED" }) };
      }
      const text = String(content ?? "").trim();
      if (text.length > 500) return { ok: false, ...normalizeError({ message: "REVIEW_TOO_LONG" }) };
      try {
        const { data, error } = await client.rpc("festival_review_submit",
          { p_booth: key, p_rating: rating, p_content: text || null });
        if (error) return { ok: false, ...normalizeError(error) };
        if (data?.result !== "SAVED") throw new Error("INVALID_REVIEW_RESPONSE");
        return { ok: true, ...validateReviews(data) };
      } catch (error) { return { ok: false, ...normalizeError(error) }; }
    }

    // Operator-only. The server re-checks the caller's admin flag; this never grants access.
    async function issueTag(booth, validMinutes) {
      const key = boothKey(booth);
      if (!key) return { ok: false, ...normalizeError({ message: "BOOTH_NOT_FOUND" }) };
      if (!Number.isInteger(validMinutes) || validMinutes < 1 || validMinutes > 7 * 24 * 60) {
        return { ok: false, ...normalizeError({ message: "INVALID_TAG_ISSUE_REQUEST" }) };
      }
      try {
        const { data, error } = await client.rpc("festival_nfc_admin_issue",
          { p_booth: key, p_valid_minutes: validMinutes });
        if (error) return { ok: false, ...normalizeError(error) };
        return { ok: true, ...validateIssuedTag(data) };
      } catch (error) { return { ok: false, ...normalizeError(error) }; }
    }

    function savePending(claim) {
      try {
        if (!claim) storage.removeItem(PENDING_KEY);
        else if (TOKEN_PATTERN.test(claim.nfcToken) && claim.nfcToken.length <= 1024) {
          storage.setItem(PENDING_KEY, JSON.stringify({ ...claim, savedAt: Date.now() }));
        }
      } catch { /* Authentication remains usable if browser storage is restricted. */ }
    }

    function pending() {
      try {
        const claim = JSON.parse(storage.getItem(PENDING_KEY) || "null");
        if (claim && TOKEN_PATTERN.test(claim.nfcToken) && claim.nfcToken.length <= 1024
          && Date.now() - claim.savedAt >= 0 && Date.now() - claim.savedAt < 15 * 60 * 1000) return claim;
      } catch { /* Treat corrupt local state as absent. */ }
      savePending(null);
      return null;
    }

    return { initialize, signIn, profile, claim, updateProfile, receiveCallback, savePending, pending,
      reviews, myReviews, submitReview, issueTag,
      signOut: () => client.auth.signOut({ scope: "local" }), normalizeError };
  }
  return { createAccount, normalizeError, validateProfile, validateReviews, validateIssuedTag, TOKEN_PATTERN };
});
