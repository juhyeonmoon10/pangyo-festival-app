(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FestivalCatalog = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const PROJECT_URL = "https://vvvkzvxahviwbuyfbwir.supabase.co";
  // Public client key. This module only reads the existing public booth catalog.
  const PUBLISHABLE_KEY = "sb_publishable_hNTy7FsrKlHesR2INjmrxA_oNLOfsah";
  const CACHE_KEY = "pangyo-public-catalog-v1-vvvkzvxahviwbuyfbwir";
  const CACHE_MAX_AGE = 24 * 60 * 60 * 1000;
  const CLUB_IDS = Object.freeze({
    "709a90e2-b234-46f9-9675-0ebe14f856b6": "글빛누리",
    "97717b20-8448-4a30-8379-c7a7029541eb": "매커니즘",
    "edc2df72-fae6-4016-b42f-a67ff85c29c6": "인사이트",
    "7f339a02-ea01-419e-ae56-6b03722092c2": "패러다임",
    "8e992f2a-3f62-4e35-a533-9a7a511de3c1": "리켐",
    "bd986569-f15e-4202-9eb7-a37006639c2a": "인벨릭스",
    "22031dff-ac7a-4653-92de-05efa5ba1660": "건축학부",
    "ef2c47d3-47ec-4a27-a96b-740a5d5281c7": "머큐리",
    "f058e380-c7e3-4739-8780-6d7f8960cdc6": "네온",
    "6cc4bd63-7652-4068-bca3-1a7e0c5b25b8": "티치스트",
    "3bda73fa-9f6a-4cd9-8b1b-a274dabe600f": "케미스트",
    "238d8ed9-94b6-47ee-aa13-bc43ef56de9b": "아트 캔버스",
    "5add1187-1512-4ca2-9ac4-b5fbf61f9d3c": "창업특허연구소",
    "43e29cde-458b-45cb-bab5-2d773a87ef98": "모멘트",
    "060d9426-5617-47b7-afd6-c06d8f16c4e2": "배구사랑",
    "fb4bff77-acc9-4335-91bb-ce4a5b5ac441": "월드 스코프",
    "9b11a808-3916-4791-b2f6-eda7a1d8ba64": "방송부",
    "2908ebef-b57c-4ec2-94ec-bea7c9b6fad2": "심장박동",
    "b61ab2bb-2d0d-47d3-8c87-2b36baf28ffc": "레브",
    "077557c9-0d54-41dd-a4ed-2bd9d9bce364": "다이나믹스",
  });

  function validateRows(value) {
    if (!Array.isArray(value) || value.length > 1000) throw new Error("INVALID_CATALOG");
    const seen = new Set();
    return value.map((row) => {
      if (!row || typeof row.id !== "string" || !row.id.trim() || row.id.length > 120
        || seen.has(row.id) || typeof row.name !== "string" || !row.name.trim()
        || row.name.length > 200 || typeof row.position !== "string" || row.position.length > 500
        || typeof row.rating !== "number" || !Number.isFinite(row.rating)
        || row.rating < 0 || row.rating > 5) throw new Error("INVALID_CATALOG");
      seen.add(row.id);
      return Object.freeze({ id: row.id, name: row.name.trim(), rating: row.rating, position: row.position.trim() });
    });
  }

  function createClient({ fetchImpl = globalThis.fetch, storage = null, timeoutMs = 6000, now = Date.now } = {}) {
    let snapshot = { status: "idle", rows: [], fetchedAt: null };
    let inFlight = null;
    const listeners = new Set();
    try {
      const cached = JSON.parse(storage?.getItem(CACHE_KEY) || "null");
      if (cached?.version === 1 && Number.isFinite(cached.fetchedAt)
        && now() - cached.fetchedAt >= 0 && now() - cached.fetchedAt < CACHE_MAX_AGE) {
        snapshot = { status: "cached", rows: validateRows(cached.rows), fetchedAt: cached.fetchedAt };
      }
    } catch { /* A corrupt or unavailable cache must not prevent opening the map. */ }

    function publish(next) {
      snapshot = Object.freeze({ ...next, rows: Object.freeze([...next.rows]) });
      listeners.forEach((listener) => listener(snapshot));
    }

    function refresh() {
      if (inFlight) return inFlight;
      // Defer work one microtask so even repeated synchronous clicks share one request.
      inFlight = Promise.resolve().then(async () => {
        publish({ ...snapshot, status: "loading" });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetchImpl(`${PROJECT_URL}/rest/v1/booths?select=id,name,rating,position&order=id&limit=1000`, {
            method: "GET",
            headers: { apikey: PUBLISHABLE_KEY, Accept: "application/json" },
            credentials: "omit",
            cache: "no-store",
            redirect: "error",
            signal: controller.signal,
          });
          if (!response.ok) throw new Error("CATALOG_UNAVAILABLE");
          const rows = validateRows(await response.json());
          const fetchedAt = now();
          try { storage?.setItem(CACHE_KEY, JSON.stringify({ version: 1, fetchedAt, rows })); } catch { /* Private browsing can deny storage. */ }
          publish({ status: "ready", rows, fetchedAt });
        } catch {
          publish({ ...snapshot, status: snapshot.fetchedAt !== null ? "offline" : "error" });
        } finally {
          clearTimeout(timer);
          inFlight = null;
        }
        return snapshot;
      });
      return inFlight;
    }

    return Object.freeze({
      getSnapshot: () => snapshot,
      forClub: (clubId) => snapshot.rows.find((row) => row.id === CLUB_IDS[clubId]) || null,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      refresh,
    });
  }

  return Object.freeze({ createClient, validateRows, CLUB_IDS, CACHE_KEY, CACHE_MAX_AGE, PROJECT_URL, PUBLISHABLE_KEY });
});
