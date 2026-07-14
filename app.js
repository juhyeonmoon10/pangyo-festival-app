const DB_KEY = "pangyo-festival-db-v3";
const GOAL_COUNT = 5;
const STAMP_GATEWAY_MODE = "mock";
const MOCK_NFC_TOKEN_PREFIX = "mock-v1.";
const EVENT = {
  id: "event-2026",
  name: "2026 판교고 연말 축제",
  startsAt: "2026-12-18T00:00:00.000Z",
  endsAt: "2026-12-18T06:00:00.000Z",
  status: "rehearsal",
};

const BOOTH_STATUS = {
  preparing: { label: "준비 중", tone: "muted" },
  open: { label: "운영 중", tone: "success" },
  crowded: { label: "혼잡", tone: "warning" },
  paused: { label: "일시 중지", tone: "danger" },
  closed: { label: "마감", tone: "muted" },
};

const FLOORS = [
  { floor: 1, label: "1층", caption: "시설" },
  { floor: 2, label: "2층", caption: "1학년" },
  { floor: 3, label: "3층", caption: "2학년" },
  { floor: 4, label: "4층", caption: "3학년" },
];

const classPositions = [
  [9, 41],
  [19, 41],
  [29, 41],
  [39, 41],
  [49, 41],
  [73, 41],
  [83, 41],
  [93, 41],
];

const state = {
  db: null,
  user: null,
  route: "login",
  floor: 1,
  mapZoom: 1,
  mapOffsetX: 0,
  mapOffsetY: 0,
  selectedBoothId: null,
  sheetOpen: false,
  sheetLevel: "peek",
  openMenu: null,
  search: "",
  searchOpen: false,
  sort: "name",
  adminTab: "dashboard",
  reviewRating: 5,
  authStep: "google",
  pendingGoogle: null,
  authIntent: "student",
  loginBusy: false,
  loginError: "",
  adminMessage: "",
  scanResult: null,
  nfcTestMessage: "",
  pendingNfcClaim: null,
};

const HISTORY_KEY = "pangyo-festival-navigation-v1";
const actionLocks = new Set();
let navigationIndex = 0;

function navigationSnapshot() {
  return {
    key: HISTORY_KEY,
    index: navigationIndex,
    route: state.route,
    floor: state.floor,
    selectedBoothId: state.selectedBoothId,
    sheetLevel: state.sheetLevel,
    searchOpen: state.searchOpen,
    adminTab: state.adminTab,
  };
}

function writeNavigationHistory(mode = "push") {
  try {
    if (mode === "push") navigationIndex += 1;
    history[mode === "replace" ? "replaceState" : "pushState"](navigationSnapshot(), "");
  } catch {
    // Local file previews can restrict History API writes in some browsers.
  }
}

function navigateTo(route, { replace = false } = {}) {
  const changed = state.route !== route;
  state.route = route;
  render();
  writeNavigationHistory(replace || !changed ? "replace" : "push");
}

function initializeNavigation() {
  const current = history.state;
  if (current?.key === HISTORY_KEY) navigationIndex = Number(current.index) || 0;
  writeNavigationHistory("replace");
  window.addEventListener("popstate", (event) => {
    const snapshot = event.state;
    if (!snapshot || snapshot.key !== HISTORY_KEY) return;
    navigationIndex = Number(snapshot.index) || 0;
    if (!state.user && snapshot.route !== "login") {
      state.route = "login";
      state.searchOpen = false;
      state.selectedBoothId = null;
      writeNavigationHistory("replace");
      render();
      return;
    }
    state.route = snapshot.route || "home";
    state.floor = Number(snapshot.floor) || 1;
    state.selectedBoothId = snapshot.selectedBoothId || null;
    state.sheetLevel = snapshot.sheetLevel || "peek";
    state.sheetOpen = state.sheetLevel !== "peek";
    state.searchOpen = Boolean(snapshot.searchOpen);
    state.adminTab = snapshot.adminTab || "dashboard";
    closeMenus();
    render();
    if (state.searchOpen) focusSearchInput();
  });
}

async function runActionOnce(key, action) {
  if (actionLocks.has(key)) return false;
  actionLocks.add(key);
  try {
    await action();
    return true;
  } finally {
    actionLocks.delete(key);
  }
}

function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

const authProvider = {
  signInWithGoogle() {
    return this.demoProfile();
  },
  signInAdmin() {
    return { uid: "google-admin", email: "admin@pangyo.hs.kr", displayName: "축제 관리자", provider: "google" };
  },
  demoProfile() {
    const savedUid = readStorage("pangyo-demo-google-uid-v2") || "google-local-student";
    writeStorage("pangyo-demo-google-uid-v2", savedUid);
    return { uid: savedUid, email: "student@pangyo.hs.kr", displayName: "판교고 학생", provider: "google" };
  },
};

function makeId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function encodeBase64Url(value) {
  const bytes = new TextEncoder().encode(String(value));
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value) {
  const padded = String(value).replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function mockNfcTokenForTagId(tagId) {
  return `${MOCK_NFC_TOKEN_PREFIX}${encodeBase64Url(tagId)}`;
}

function tagIdFromMockNfcToken(token) {
  if (!String(token).startsWith(MOCK_NFC_TOKEN_PREFIX)) return null;
  try {
    return decodeBase64Url(String(token).slice(MOCK_NFC_TOKEN_PREFIX.length));
  } catch {
    return null;
  }
}

function createNfcClaim(nfcToken, source = "ui") {
  return {
    nfcToken: String(nfcToken || ""),
    idempotencyKey: makeId(),
    source,
  };
}

function readInitialNfcClaim() {
  const url = new URL(window.location.href);
  const fragment = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  const fragmentToken = fragment.get("t");
  const legacyTagId = url.searchParams.get("nfc");
  if (!fragmentToken && !legacyTagId) return null;

  fragment.delete("t");
  url.searchParams.delete("nfc");
  url.hash = fragment.toString() ? `#${fragment.toString()}` : "";
  try {
    history.replaceState(history.state, "", url.href);
  } catch {
    // Local file previews can restrict History API writes.
  }

  return createNfcClaim(
    fragmentToken || mockNfcTokenForTagId(legacyTagId),
    fragmentToken ? "tag-url" : "legacy-tag-url",
  );
}

state.pendingNfcClaim = readInitialNfcClaim();

function makeClassBooths(grade, floor) {
  return classPositions.map(([x, y], index) => {
    const klass = index + 1;
    return {
      id: `g${grade}-${klass}`,
      eventId: EVENT.id,
      clubName: `${grade}학년 ${klass}반`,
      name: `${grade}학년 ${klass}반 부스`,
      floor,
      room: `${grade}-${klass}`,
      location: `${floor}층 ${grade}-${klass} 교실`,
      description: "동아리/학급 부스 종류는 추후 확정되는 대로 업데이트할 예정입니다.",
      status: index === 5 ? "crowded" : index === 7 ? "paused" : "open",
      opensAt: EVENT.startsAt,
      closesAt: EVENT.endsAt,
      nfcTagId: `NFC-G${grade}-${String(klass).padStart(2, "0")}`,
      x,
      y,
      favorite: index === 0,
      category: "class",
    };
  });
}

const seed = {
  event: {
    ...EVENT,
    emergencyMode: false,
  },
  announcements: [
    {
      id: "notice-1",
      eventId: EVENT.id,
      severity: "info",
      title: "축제 준비 중이에요",
      body: "현재 화면은 개인 UI 테스트 버전입니다. 실제 행사 정보는 운영진 확정 후 반영됩니다.",
      publishedAt: "2026-07-13T00:00:00.000Z",
    },
  ],
  users: [
    {
      id: "u-admin",
      googleUid: "google-admin",
      googleEmail: "admin@pangyo.hs.kr",
      studentNumber: "admin",
      schoolId: "festival-admin",
      name: "축제 관리자",
      role: "admin",
      exchangedAt: null,
    },
  ],
  booths: [
    { id: "b1", eventId: EVENT.id, clubName: "보건 지원", name: "보건실", floor: 1, room: "보건실", location: "1층 보건실", description: "축제 중 몸이 불편할 때 방문할 수 있는 응급 지원 공간입니다.", status: "open", opensAt: EVENT.startsAt, closesAt: EVENT.endsAt, nfcTagId: "NFC-HEALTH-101", x: 17, y: 32, favorite: false, category: "facility" },
    { id: "b2", eventId: EVENT.id, clubName: "학생회", name: "학생회 안내소", floor: 1, room: "중앙 현관", location: "1층 중앙 현관", description: "축제 안내와 분실물 문의를 도와주는 운영 부스입니다.", status: "open", opensAt: EVENT.startsAt, closesAt: EVENT.endsAt, nfcTagId: "NFC-INFO-102", x: 50, y: 43, favorite: true, category: "facility" },
    { id: "b3", eventId: EVENT.id, clubName: "행사 운영", name: "행정실", floor: 1, room: "행정실", location: "1층 행정실", description: "축제 운영 문의와 긴급 연락을 처리하는 관리 공간입니다.", status: "preparing", opensAt: EVENT.startsAt, closesAt: EVENT.endsAt, nfcTagId: "NFC-OFFICE-103", x: 46, y: 40, favorite: false, category: "facility" },
    { id: "b4", eventId: EVENT.id, clubName: "방송부", name: "시청각실", floor: 1, room: "시청각실", location: "1층 시청각실", description: "축제 영상과 안내 프로그램을 운영할 수 있는 공간입니다.", status: "paused", opensAt: EVENT.startsAt, closesAt: EVENT.endsAt, nfcTagId: "NFC-STUDIO-104", x: 84, y: 50, favorite: false, category: "facility" },
    { id: "b5", eventId: EVENT.id, clubName: "학생 지원", name: "상담실", floor: 1, room: "상담실", location: "1층 상담실", description: "조용한 안내와 상담이 필요한 경우 이용하는 공간입니다.", status: "closed", opensAt: EVENT.startsAt, closesAt: EVENT.endsAt, nfcTagId: "NFC-STORE-105", x: 31, y: 31, favorite: false, category: "facility" },
    ...makeClassBooths(1, 2),
    ...makeClassBooths(2, 3),
    ...makeClassBooths(3, 4),
  ],
  stamps: [],
  idempotencyRecords: [],
  reviews: [],
};

state.db = loadDb();

function loadDb() {
  const saved = readStorage(DB_KEY);
  if (!saved) {
    writeStorage(DB_KEY, JSON.stringify(seed));
    return structuredClone(seed);
  }
  let db;
  try {
    db = JSON.parse(saved);
  } catch {
    writeStorage(DB_KEY, JSON.stringify(seed));
    return structuredClone(seed);
  }
  const legacyFacilityUpdates = {
    b3: { legacyName: "교무실", name: "행정실", location: "1층 행정실", description: "축제 운영 문의와 긴급 연락을 처리하는 관리 공간입니다." },
    b4: { legacyName: "방송실", name: "시청각실", location: "1층 시청각실", description: "축제 영상과 안내 프로그램을 운영할 수 있는 공간입니다." },
    b5: { legacyName: "매점", name: "상담실", location: "1층 상담실", description: "조용한 안내와 상담이 필요한 경우 이용하는 공간입니다." },
  };
  db.event = { ...seed.event, ...(db.event || {}) };
  db.announcements = Array.isArray(db.announcements) ? db.announcements : structuredClone(seed.announcements);
  db.booths = (Array.isArray(db.booths) ? db.booths : structuredClone(seed.booths)).map((booth) => {
    const update = legacyFacilityUpdates[booth.id];
    const migrated = update && booth.name === update.legacyName
      ? { ...booth, name: update.name, location: update.location, description: update.description }
      : booth;
    return {
      eventId: EVENT.id,
      clubName: migrated.category === "class" ? migrated.name.replace(" 부스", "") : "행사 운영",
      room: migrated.location?.replace(/^\d층\s*/, "") || "위치 미정",
      status: "open",
      opensAt: EVENT.startsAt,
      closesAt: EVENT.endsAt,
      ...migrated,
    };
  });
  db.users = (Array.isArray(db.users) ? db.users : []).map((user) => ({
    googleUid: user.googleUid || user.id,
    googleEmail: user.googleEmail || "",
    schoolId: user.schoolId || user.studentNumber,
    role: "user",
    exchangedAt: null,
    ...user,
  }));
  db.stamps = (Array.isArray(db.stamps) ? db.stamps : []).map((stamp) => ({
    eventId: EVENT.id,
    method: "nfc",
    status: "active",
    ...stamp,
  }));
  db.idempotencyRecords = Array.isArray(db.idempotencyRecords) ? db.idempotencyRecords : [];
  db.reviews = Array.isArray(db.reviews) ? db.reviews : [];
  return db;
}

function saveDb() {
  writeStorage(DB_KEY, JSON.stringify(state.db));
}

const repo = {
  avgRating(boothId) {
    const list = state.db.reviews.filter((review) => review.boothId === boothId);
    if (!list.length) return 0;
    return list.reduce((sum, review) => sum + Number(review.rating), 0) / list.length;
  },
  hasStamp(userId, boothId) {
    return state.db.stamps.some((stamp) => stamp.userId === userId && stamp.boothId === boothId && stamp.status !== "revoked");
  },
  hasReview(userId, boothId) {
    return state.db.reviews.some((review) => review.userId === userId && review.boothId === boothId);
  },
  boothVisits(boothId) {
    return state.db.stamps.filter((stamp) => stamp.boothId === boothId && stamp.status !== "revoked").length;
  },
  stampsForUser(userId) {
    return state.db.stamps.filter((stamp) => stamp.userId === userId && stamp.status !== "revoked");
  },
};

function cloneData(value) {
  return globalThis.structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function mockTokenFingerprint(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `mock-fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function nfcFailure(code, message, options = {}) {
  return {
    ok: false,
    status: options.status ?? 422,
    code,
    message,
    retryable: Boolean(options.retryable),
    boothId: options.boothId || null,
    requestId: options.requestId || makeId(),
  };
}

const mockStampGateway = {
  async claimNfc({ eventId, userId, nfcToken, idempotencyKey }) {
    const requestId = makeId();
    if (!userId) return nfcFailure("AUTH_REQUIRED", "로그인이 필요합니다.", { status: 401, requestId });
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(String(idempotencyKey || ""))) {
      return nfcFailure("INVALID_IDEMPOTENCY_KEY", "요청 식별자가 올바르지 않습니다.", { status: 400, requestId });
    }

    const scope = `nfc:${eventId}`;
    const tokenFingerprint = mockTokenFingerprint(nfcToken);
    const previous = state.db.idempotencyRecords.find((record) => (
      record.actorId === userId
      && record.scope === scope
      && record.idempotencyKey === idempotencyKey
    ));
    if (previous) {
      if (previous.tokenFingerprint !== tokenFingerprint) {
        return nfcFailure("IDEMPOTENCY_KEY_REUSED", "같은 요청 식별자를 다른 태그에 다시 사용할 수 없습니다.", { status: 409, requestId });
      }
      return { ...cloneData(previous.response), replayed: true };
    }

    const finish = (response) => {
      state.db.idempotencyRecords.push({
        id: makeId(),
        actorId: userId,
        scope,
        idempotencyKey,
        tokenFingerprint,
        boothId: response.boothId || null,
        response: cloneData(response),
        createdAt: new Date().toISOString(),
      });
      saveDb();
      return { ...response, replayed: false };
    };

    if (eventId !== state.db.event.id) {
      return finish(nfcFailure("EVENT_NOT_FOUND", "현재 행사와 일치하지 않는 요청입니다.", { status: 404, requestId }));
    }
    if (typeof nfcToken !== "string" || !nfcToken || nfcToken.length > 512) {
      return finish(nfcFailure("NFC_TAG_INVALID", "등록되지 않았거나 잘못된 NFC 태그입니다.", { requestId }));
    }

    const tagId = tagIdFromMockNfcToken(nfcToken);
    const booth = tagId
      ? state.db.booths.find((item) => item.eventId === eventId && item.nfcTagId === tagId)
      : null;
    if (!booth) {
      return finish(nfcFailure("NFC_TAG_INVALID", "등록되지 않았거나 잘못된 NFC 태그입니다.", { requestId }));
    }
    if (state.db.event.emergencyMode) {
      return finish(nfcFailure("EMERGENCY_MODE", "비상 모드에서는 NFC 적립이 잠시 중지됩니다.", { status: 503, boothId: booth.id, requestId }));
    }
    if (!["active", "rehearsal"].includes(state.db.event.status)) {
      return finish(nfcFailure("EVENT_NOT_ACTIVE", "현재 행사가 방문 적립 가능한 상태가 아닙니다.", { boothId: booth.id, requestId }));
    }
    if (!["open", "crowded"].includes(booth.status)) {
      return finish(nfcFailure("BOOTH_NOT_OPEN", `${booth.name}은(는) ${statusInfo(booth.status).label} 상태예요.`, { boothId: booth.id, requestId }));
    }

    const existing = state.db.stamps.find((stamp) => (
      stamp.eventId === eventId
      && stamp.userId === userId
      && stamp.boothId === booth.id
      && stamp.status !== "revoked"
    ));
    if (existing) {
      return finish({
        ok: true,
        status: 200,
        result: "ALREADY_EARNED",
        boothId: booth.id,
        stampId: existing.id,
        earnedAt: existing.earnedAt || existing.createdAt,
        requestId,
      });
    }

    const earnedAt = new Date().toISOString();
    const stamp = {
      id: makeId(),
      eventId,
      userId,
      boothId: booth.id,
      method: "nfc",
      status: "active",
      idempotencyKey,
      requestId,
      earnedAt,
      createdAt: earnedAt,
    };
    state.db.stamps.push(stamp);
    return finish({
      ok: true,
      status: 201,
      result: "EARNED",
      boothId: booth.id,
      stampId: stamp.id,
      earnedAt,
      requestId,
    });
  },
};

function createHttpStampGateway() {
  return {
    async claimNfc({ eventId, nfcToken, idempotencyKey }) {
      let response;
      try {
        response = await fetch(`/api/v1/events/${encodeURIComponent(eventId)}/stamps/nfc`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({ token: nfcToken }),
        });
      } catch {
        return nfcFailure("NETWORK_ERROR", "네트워크 연결을 확인한 뒤 같은 요청으로 다시 시도해 주세요.", { status: 0, retryable: true });
      }

      let payload = {};
      try {
        payload = await response.json();
      } catch {
        return nfcFailure("INVALID_SERVER_RESPONSE", "서버 응답을 확인할 수 없습니다.", { status: response.status, retryable: response.status >= 500 });
      }
      if (!response.ok) {
        return nfcFailure(
          payload.error?.code || "STAMP_REQUEST_FAILED",
          payload.error?.message || "방문 인증을 처리하지 못했습니다.",
          {
            status: response.status,
            retryable: Boolean(payload.error?.retryable),
            requestId: payload.meta?.requestId,
          },
        );
      }

      const stamp = payload.data?.stamp || {};
      return {
        ok: true,
        status: response.status,
        result: payload.data?.result || "EARNED",
        boothId: stamp.boothId || null,
        stampId: stamp.id || null,
        earnedAt: stamp.earnedAt || null,
        requestId: payload.meta?.requestId || response.headers.get("X-Request-Id") || makeId(),
        replayed: false,
      };
    },
  };
}

const stampGateway = STAMP_GATEWAY_MODE === "http" ? createHttpStampGateway() : mockStampGateway;

const NFC_ERROR_TITLES = {
  NFC_TAG_INVALID: "등록되지 않은 태그예요",
  NFC_TAG_DISABLED: "사용 중지된 태그예요",
  NFC_TAG_EXPIRED: "사용 기간이 지난 태그예요",
  BOOTH_NOT_OPEN: "지금은 적립할 수 없어요",
  EVENT_NOT_ACTIVE: "행사가 운영 중이 아니에요",
  EMERGENCY_MODE: "방문 적립이 잠시 중지됐어요",
  IDEMPOTENCY_KEY_REUSED: "요청을 다시 확인해 주세요",
  NETWORK_ERROR: "네트워크 연결이 불안정해요",
};

const nfcAdapter = {
  async scan(claim) {
    state.nfcTestMessage = "";
    const request = {
      nfcToken: String(claim?.nfcToken || ""),
      idempotencyKey: claim?.idempotencyKey || makeId(),
      source: claim?.source || "ui",
    };
    if (!request.nfcToken) {
      state.scanResult = { type: "error", title: "태그 정보를 읽지 못했어요", body: "다시 인식하거나 운영자에게 수동 승인을 요청하세요." };
      state.route = state.user ? "scan" : "login";
      render();
      return nfcFailure("NFC_TAG_INVALID", "태그 정보가 비어 있습니다.");
    }
    if (!state.user) {
      state.pendingNfcClaim = request;
      state.route = "login";
      state.loginError = "NFC 태그가 인식되었습니다. 로그인하면 같은 요청 식별자로 자동 적립을 이어갑니다.";
      render();
      return { ok: false, queued: true };
    }

    const result = await stampGateway.claimNfc({
      eventId: state.db.event.id,
      userId: state.user.id,
      nfcToken: request.nfcToken,
      idempotencyKey: request.idempotencyKey,
    });
    const booth = result.boothId ? state.db.booths.find((item) => item.id === result.boothId) : null;

    if (result.code === "AUTH_REQUIRED") {
      state.pendingNfcClaim = request;
      state.user = null;
      state.route = "login";
      state.loginError = "로그인이 만료되었습니다. 다시 로그인하면 방문 인증을 이어갑니다.";
      render();
      return result;
    }

    if (result.ok) {
      state.pendingNfcClaim = null;
      const duplicate = result.result === "ALREADY_EARNED";
      if (!duplicate && !result.replayed) showStampPop();
      state.scanResult = {
        type: duplicate ? "duplicate" : "success",
        boothId: result.boothId,
        title: duplicate ? "이미 방문한 부스예요" : "스탬프를 적립했어요",
        body: duplicate
          ? "기존 방문 기록을 그대로 유지했어요."
          : result.replayed
            ? "같은 요청의 기존 성공 결과를 다시 불러왔어요."
            : `${formatTime(result.earnedAt)}에 방문 기록이 저장됐어요.`,
      };
    } else {
      state.pendingNfcClaim = result.retryable ? request : null;
      const blocked = ["BOOTH_NOT_OPEN", "EVENT_NOT_ACTIVE", "EMERGENCY_MODE"].includes(result.code);
      state.scanResult = {
        type: blocked ? "blocked" : "error",
        boothId: result.boothId,
        title: NFC_ERROR_TITLES[result.code] || "방문 인증을 처리하지 못했어요",
        body: result.message,
        retryable: Boolean(result.retryable),
      };
    }
    state.route = "scan";
    render();
    return result;
  },
};

function statusInfo(status) {
  return BOOTH_STATUS[status] || BOOTH_STATUS.preparing;
}

function formatTime(value) {
  return new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Seoul" }).format(new Date(value));
}

function formatOperatingHours(booth) {
  return `${formatTime(booth.opensAt)}–${formatTime(booth.closesAt)}`;
}

function icon(name) {
  const icons = {
    home: "⌂",
    map: "⌖",
    scan: "N",
    stamp: "印",
    star: "★",
    back: "‹",
    admin: "⚙",
    user: "●",
    heart: "♥",
  };
  return icons[name] || "";
}

let renderInProgress = false;

function render() {
  if (renderInProgress) return;
  renderInProgress = true;
  const app = document.querySelector("#app");
  try {
    const hasRenderedRoute = Boolean(app.dataset.route);
    const previousRoute = app.dataset.route || state.route;
    const nextRoute = state.route;
    const routeChanged = !hasRenderedRoute || previousRoute !== nextRoute;
    app.classList.toggle("route-change", routeChanged);
    app.classList.toggle("state-update", !routeChanged);
    if (state.route === "login") app.innerHTML = loginView();
    if (state.route === "home") app.innerHTML = homeView();
    if (state.route === "map") app.innerHTML = mapView();
    if (state.route === "scan") app.innerHTML = scanView();
    if (state.route === "detail") app.innerHTML = detailView();
    if (state.route === "stamps") app.innerHTML = stampView();
    if (state.route === "profile") app.innerHTML = profileView();
    if (state.route === "admin") app.innerHTML = adminView();
    app.dataset.previousRoute = previousRoute;
    app.dataset.route = nextRoute;
    bindEvents();
  } finally {
    renderInProgress = false;
  }
}

function loginView() {
  const profileStep = state.authStep === "profile" && state.pendingGoogle;
  return `
    <main class="screen login-screen">
      <div>
        <div class="brand-mark">P</div>
        <h1 class="title">판교고 축제<br />스탬프 맵</h1>
        <p class="subtitle">현재는 구글 계정 인증 화면만 먼저 확인하는 단계입니다. 버튼을 누르면 학생 모드로 바로 입장합니다.</p>
      </div>
      <section class="panel">
        ${profileStep ? profileForm() : googleForm()}
      </section>
    </main>
  `;
}

function googleForm() {
  return `
    <div class="auth-card">
      <div class="auth-step">1단계</div>
      <h2>구글 계정 인증</h2>
      <p class="subtitle">현재는 구글 계정 인증 UI 틀만 적용되어 있습니다. 버튼을 누르면 인증 완료로 처리되고 바로 지도 화면으로 이동합니다.</p>
      ${state.pendingNfcClaim ? `<p class="success-text">NFC 태그 인식됨 · 로그인 후 자동 적립 대기 중</p>` : ""}
      ${state.loginError ? `<p class="error-text">${state.loginError}</p>` : ""}
      <button id="googleLogin" type="button" class="primary-btn google-btn" ${state.loginBusy ? "disabled" : ""}>${state.loginBusy ? "로그인 확인 중..." : "G 구글 계정으로 계속"}</button>
      <button id="adminLogin" type="button" class="ghost-btn" ${state.loginBusy ? "disabled" : ""}>관리자 모드로 계속</button>
    </div>
  `;
}

function profileForm() {
  const google = state.pendingGoogle;
  return `
    <div class="auth-card">
      <div class="auth-step">2단계</div>
      <h2>학생 정보 등록</h2>
      <p class="account-chip">인증됨: ${google.email}</p>
      ${state.loginError ? `<p class="error-text">${state.loginError}</p>` : ""}
      <div class="input-stack">
        <label class="field">이름<input id="name" class="input" value="${google.displayName}" /></label>
        <label class="field">학번<input id="studentNumber" class="input" placeholder="예: 21001" inputmode="numeric" /></label>
        <label class="field">아이디<input id="schoolId" class="input" placeholder="예: pango-student" /></label>
        <button id="profileSubmit" type="button" class="primary-btn">등록하고 시작</button>
        <button id="backToGoogle" type="button" class="ghost-btn">구글 계정 다시 선택</button>
      </div>
    </div>
  `;
}

function homeView() {
  const stamps = repo.stampsForUser(state.user.id);
  const available = state.db.booths.filter((booth) => ["open", "crowded"].includes(booth.status));
  const crowded = state.db.booths.filter((booth) => booth.status === "crowded").length;
  const notice = state.db.announcements[0];
  return `
    <main class="screen p0-page home-screen">
      <header class="p0-header">
        <div>
          <span class="eyebrow">${state.db.event.status === "rehearsal" ? "UI TEST MODE" : "ORBIT"}</span>
          <h1>${state.user?.name || "학생"}님, 안녕하세요</h1>
          <p>${state.db.event.name}</p>
        </div>
        <button class="icon-btn" data-route="profile" aria-label="내 정보">${icon("user")}</button>
      </header>
      ${state.db.event.emergencyMode ? emergencyBanner() : ""}
      ${notice ? noticeBanner(notice) : ""}
      <section class="home-summary" aria-label="축제 현황">
        <div><span>방문</span><strong>${stamps.length}</strong><small>개 부스</small></div>
        <div><span>운영 중</span><strong>${available.length}</strong><small>개 부스</small></div>
        <div><span>혼잡</span><strong>${crowded}</strong><small>개 부스</small></div>
      </section>
      <section class="p0-section">
        <div class="section-heading"><div><span>빠른 시작</span><h2>지금 무엇을 할까요?</h2></div></div>
        <div class="quick-actions">
          <button type="button" data-route="map"><b>${icon("map")}</b><span><strong>부스 찾기</strong><small>층과 교실로 찾아보세요</small></span></button>
          <button type="button" data-route="scan"><b>${icon("scan")}</b><span><strong>NFC 방문 인증</strong><small>태그 결과를 확인하세요</small></span></button>
        </div>
      </section>
      <section class="p0-section">
        <div class="section-heading"><div><span>추천 부스</span><h2>현재 이용 가능해요</h2></div><button data-route="map">전체 보기</button></div>
        <div class="home-booth-list">${available.slice(0, 3).map(homeBoothCard).join("")}</div>
      </section>
      ${bottomNav("home")}
    </main>
  `;
}

function noticeBanner(notice) {
  return `
    <section class="notice-banner ${notice.severity}" role="status">
      <span>공지</span>
      <div><strong>${notice.title}</strong><p>${notice.body}</p><small>${formatTime(notice.publishedAt)} 게시</small></div>
    </section>
  `;
}

function emergencyBanner() {
  return `
    <section class="emergency-banner" role="alert">
      <strong>비상 모드가 켜졌어요</strong>
      <p>방문 적립이 제한됩니다. 현장 운영자의 안내를 따라 주세요.</p>
    </section>
  `;
}

function homeBoothCard(booth) {
  return `
    <button type="button" class="home-booth-card" data-list-select="${booth.id}">
      <span><strong>${booth.name}</strong><small>${booth.clubName} · ${booth.location}</small></span>
      ${statusBadge(booth.status)}
    </button>
  `;
}

function statusBadge(status) {
  const info = statusInfo(status);
  return `<span class="status-badge ${info.tone}"><i aria-hidden="true"></i>${info.label}</span>`;
}

function nfcTestBooths() {
  return ["g1-1", "g1-2"]
    .map((boothId) => state.db.booths.find((booth) => booth.id === boothId))
    .filter(Boolean);
}

function scanView() {
  const result = state.scanResult;
  const resultBooth = result?.boothId ? state.db.booths.find((booth) => booth.id === result.boothId) : null;
  const testBooths = nfcTestBooths();
  const completedTests = testBooths.filter((booth) => repo.hasStamp(state.user.id, booth.id)).length;
  return `
    <main class="screen p0-page scan-screen">
      <header class="p0-header compact">
        <div><span class="eyebrow">NFC</span><h1>방문 인증</h1><p>태그를 휴대전화 뒷면에 가까이 대세요.</p></div>
      </header>
      <section class="demo-boundary"><strong>UI 테스트 모드</strong><span>현재 기록은 이 브라우저에만 저장돼요.</span></section>
      ${state.db.event.emergencyMode ? emergencyBanner() : ""}
      <section class="scan-pad ${result ? `has-result ${result.type}` : ""}">
        ${result ? `
          <div class="scan-result-icon">${result.type === "success" ? "✓" : result.type === "duplicate" ? "↻" : "!"}</div>
          <span>${resultBooth?.location || "NFC 확인"}</span>
          <h2>${result.title}</h2>
          <p>${result.body}</p>
          ${resultBooth ? `<button type="button" class="primary-btn" data-detail="${resultBooth.id}">부스 상세 보기</button>` : ""}
          ${result.retryable ? `<button type="button" class="primary-btn" id="retryNfcClaim">같은 요청으로 다시 시도</button>` : ""}
          <button type="button" class="ghost-btn" id="clearScanResult">다른 태그 확인</button>
        ` : `
          <div class="nfc-waves" aria-hidden="true"><i></i><i></i><b>N</b></div>
          <span>태그 대기 중</span>
          <h2>NFC 태그를 인식하면<br />결과가 여기에 표시돼요</h2>
          <p>NFC를 읽지 못하면 부스 운영자에게 수동 승인을 요청하세요.</p>
        `}
      </section>
      ${STAMP_GATEWAY_MODE === "mock" ? `<section class="nfc-test-panel" aria-labelledby="nfcTestTitle">
        <div class="nfc-test-head">
          <span><strong id="nfcTestTitle">모의 NFC 태그</strong><small>서버 API와 같은 토큰·재시도 계약을 테스트합니다.</small></span>
          <b>${completedTests}/${testBooths.length}</b>
        </div>
        <div class="nfc-test-grid">
          ${testBooths.map((booth) => {
            const stamped = repo.hasStamp(state.user.id, booth.id);
            const tagLabel = booth.nfcTagId.replace(/^NFC-/, "");
            return `
              <button type="button" class="nfc-test-tag ${stamped ? "completed" : ""}" data-nfc-token="${escapeHtml(mockNfcTokenForTagId(booth.nfcTagId))}" data-nfc-source="mock-panel" data-nfc-test="${escapeHtml(booth.nfcTagId)}">
                <span>${escapeHtml(tagLabel)}</span>
                <strong>${escapeHtml(booth.clubName)}</strong>
                <small>${stamped ? "인증 완료 · 다시 누르면 중복 확인" : "눌러서 태그 인식"}</small>
              </button>
            `;
          }).join("")}
        </div>
        <button type="button" class="nfc-test-reset" id="resetNfcTestStamps" ${completedTests ? "" : "disabled"}>테스트 스탬프 초기화</button>
        ${state.nfcTestMessage ? `<p class="nfc-test-message" role="status" aria-live="polite">${escapeHtml(state.nfcTestMessage)}</p>` : ""}
      </section>` : ""}
      <section class="manual-help">
        <span>인식되지 않나요?</span>
        <strong>운영자에게 수동 승인을 요청하세요</strong>
        <p>실서비스에서는 운영자가 담당 부스와 단기 학생 코드를 확인한 뒤 승인합니다.</p>
      </section>
      ${bottomNav("scan")}
    </main>
  `;
}

function profileView() {
  const stampCount = repo.stampsForUser(state.user.id).length;
  return `
    <main class="screen p0-page profile-screen">
      <header class="p0-header compact">
        <div><span class="eyebrow">MY ORBIT</span><h1>내 정보</h1><p>현재 로그인과 기록은 데모 상태예요.</p></div>
      </header>
      <section class="profile-card">
        <div class="profile-avatar">${(state.user.name || "학").slice(0, 1)}</div>
        <div><strong>${state.user.name}</strong><span>${state.user.googleEmail || "학교 계정 미연결"}</span></div>
        <em>${state.user.role === "admin" ? "관리자 데모" : "학생 데모"}</em>
      </section>
      <section class="profile-list">
        <div><span>행사</span><strong>${state.db.event.name}</strong></div>
        <div><span>방문 기록</span><strong>${stampCount}개</strong></div>
        <div><span>저장 위치</span><strong>이 브라우저</strong></div>
      </section>
      ${state.user.role === "admin" ? `<button type="button" class="ghost-btn full-action" data-route="admin">관리자 데모 열기</button>` : ""}
      <button type="button" class="danger-btn full-action" data-route="login">로그아웃</button>
      ${bottomNav("profile")}
    </main>
  `;
}

function sortedBooths(booths) {
  return [...booths].sort((a, b) => {
    return a.name.localeCompare(b.name, "ko");
  });
}

function normalizeSearchText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("ko-KR")
    .replace(/[\s\u200B-\u200D\uFEFF]+/gu, "");
}

function matchesBoothSearch(booth) {
  const term = normalizeSearchText(state.search);
  if (!term) return true;
  const searchableText = normalizeSearchText(`${booth.name} ${booth.clubName} ${booth.location}`);
  return searchableText.includes(term);
}

function visibleBooths() {
  const booths = state.db.booths.filter((booth) => booth.floor === state.floor && matchesBoothSearch(booth));
  return sortedBooths(booths);
}

function searchResults() {
  let booths = state.db.booths;
  if (normalizeSearchText(state.search)) {
    booths = booths.filter(matchesBoothSearch);
  }
  return sortedBooths(booths);
}

function mapPlanForFloor(floor) {
  const room = (label, x, y, w, h, type = "facility") => ({ label, x, y, w, h, type });
  const corridor = (x, y, w, h, label = "복도") => ({ x, y, w, h, label });
  const connector = (x, y, w, h) => ({ x, y, w, h });

  if (floor === 1) {
    return {
      subtitle: "중앙 현관 · 보건실 · 시청각실",
      rooms: [
        room("계단", 4, 22, 8, 18, "core"),
        room("발간실", 12, 22, 14, 18),
        room("상담실", 26, 22, 11, 18),
        room("중앙 현관", 52, 22, 12, 38, "entrance"),
        room("계단", 64, 22, 8, 18, "core"),
        room("시청각실", 72, 22, 24, 38, "hall"),
        room("특수학급", 4, 46, 14, 14),
        room("보건실", 18, 46, 16, 14, "health"),
        room("교장실", 34, 46, 10, 14),
        room("행정실", 44, 46, 8, 14),
      ],
      corridors: [corridor(4, 40, 92, 6, "본관 복도")],
      connectors: [],
      exits: [{ label: "중앙 출입구", x: 58, y: 64 }],
    };
  }

  const grade = floor - 1;
  const classroomX = [4, 14, 24, 34, 44, 68, 78, 88];
  const classrooms = classroomX.map((x, index) => room(`${grade}-${index + 1}`, x, 34, 10, 14, "classroom"));
  const shared = [
    room("계단", 4, 8, 7, 20, "core"),
    room(floor === 2 ? "스튜디오" : floor === 3 ? "학생안전부" : "수준별교실", 11, 8, 16, 20, "special"),
    room(floor === 2 ? "본교무실" : floor === 3 ? "교사휴게실" : "교사휴게실", 27, 8, 20, 20),
    room("계단", 65, 8, 8, 20, "core"),
    room(`${grade}학년 교무실`, 58, 34, 10, 14, "grade-office"),
    ...classrooms,
  ];

  if (floor === 2) {
    return {
      subtitle: "1학년 교실 · 도서관 · 다목적강당",
      rooms: [
        ...shared,
        room("인문학실", 34, 63, 15, 12, "special"),
        room("계단", 49, 63, 8, 12, "core"),
        room("글빛누리 도서관", 34, 75, 23, 14, "library"),
        room("학사실", 57, 63, 14, 26),
        room("다목적강당", 76, 63, 22, 26, "auditorium"),
      ],
      corridors: [corridor(4, 28, 95, 6), corridor(34, 57, 64, 6, "연결 복도")],
      connectors: [connector(52, 48, 5, 9), connector(71, 68, 5, 6)],
      exits: [{ label: "본관 출입구", x: 51, y: 53 }, { label: "강당 연결", x: 73, y: 68 }],
    };
  }

  if (floor === 3) {
    return {
      subtitle: "2학년 교실 · 과학실 · 음악실",
      rooms: [
        ...shared,
        room("음악실", 50, 52, 12, 11, "special"),
        room("과학실", 31, 67, 18, 12, "science"),
        room("계단", 49, 67, 8, 20, "core"),
        room("과학실", 31, 79, 18, 12, "science"),
        room("진로상담부", 31, 91, 26, 5),
        room("학사실", 57, 67, 14, 29),
        room("다목적강당", 77, 67, 21, 27, "auditorium"),
      ],
      corridors: [corridor(4, 28, 95, 6), corridor(31, 61, 67, 6, "특별실 연결")],
      connectors: [connector(50, 48, 5, 13), connector(71, 72, 6, 6)],
      exits: [{ label: "본관 출입구", x: 49, y: 54 }, { label: "특별실 계단", x: 55, y: 89 }],
    };
  }

  return {
    subtitle: "3학년 교실 · 미술실 · 하늘정원",
    rooms: [
      ...shared,
      room("미술실", 53, 53, 12, 11, "special"),
      room("하늘정원", 31, 66, 35, 24, "garden"),
      room("다목적강당", 76, 66, 22, 24, "auditorium"),
    ],
    corridors: [corridor(4, 28, 95, 6), corridor(31, 60, 67, 6, "하늘정원 연결")],
    connectors: [connector(53, 48, 5, 12), connector(66, 72, 10, 6)],
    exits: [{ label: "본관 출입구", x: 52, y: 54 }, { label: "강당 연결", x: 71, y: 72 }],
  };
}

function boothMapPosition(booth) {
  const classMatch = /^g([1-3])-([1-8])$/.exec(booth.id);
  if (classMatch) return { x: classPositions[Number(classMatch[2]) - 1][0], y: 41 };
  const firstFloorPositions = {
    b1: { x: 26, y: 53 },
    b2: { x: 58, y: 41 },
    b3: { x: 48, y: 53 },
    b4: { x: 84, y: 41 },
    b5: { x: 31, y: 31 },
  };
  return firstFloorPositions[booth.id] || { x: booth.x, y: booth.y };
}

function boothForPlanRoom(item, booths) {
  if (item.type === "classroom") return booths.find((booth) => booth.id === `g${item.label}`) || null;
  return booths.find((booth) => booth.name === item.label || booth.location.includes(item.label)) || null;
}

function mapPlanMarkup(plan, booths) {
  return `
    <div class="plan-boundary" aria-hidden="true"></div>
    ${plan.connectors.map((item) => `<div class="plan-connector" style="left:${item.x}%;top:${item.y}%;width:${item.w}%;height:${item.h}%"></div>`).join("")}
    ${plan.corridors.map((item) => `<div class="plan-corridor" style="left:${item.x}%;top:${item.y}%;width:${item.w}%;height:${item.h}%"><span>${item.label}</span></div>`).join("")}
    ${plan.rooms.map((item, index) => {
      const booth = boothForPlanRoom(item, booths);
      if (!booth) return `<div class="plan-room ${item.type}" style="left:${item.x}%;top:${item.y}%;width:${item.w}%;height:${item.h}%;--stagger:${index * 12}ms"><span>${item.label}</span></div>`;
      const visited = repo.hasStamp(state.user.id, booth.id);
      const selected = state.selectedBoothId === booth.id;
      return `
        <button type="button" class="plan-room ${item.type} booth-room status-${booth.status} ${visited ? "visited" : ""} ${selected ? "selected" : ""}" style="left:${item.x}%;top:${item.y}%;width:${item.w}%;height:${item.h}%;--stagger:${index * 12}ms" data-map-select="${booth.id}" aria-label="${booth.name}, ${statusInfo(booth.status).label}" title="${booth.name}">
          <span>${item.label}</span>
          <small>${booth.category === "class" ? "부스" : "안내"}</small>
          <i class="room-state" aria-hidden="true"></i>
        </button>
      `;
    }).join("")}
    ${plan.exits.map((item) => `<div class="plan-exit" style="left:${item.x}%;top:${item.y}%">${item.label}</div>`).join("")}
  `;
}

function mapView() {
  const booths = visibleBooths();
  const globalSearchResults = searchResults();
  const floorInfo = FLOORS.find((item) => item.floor === state.floor);
  const plan = mapPlanForFloor(state.floor);
  const placedBoothIds = new Set(plan.rooms.map((item) => boothForPlanRoom(item, booths)?.id).filter(Boolean));
  const floatingBooths = booths.filter((booth) => !placedBoothIds.has(booth.id));
  const stampedCount = booths.filter((booth) => repo.hasStamp(state.user.id, booth.id)).length;
  const selectedBooth = booths.find((booth) => booth.id === state.selectedBoothId);
  const sheetHint = state.sheetLevel === "full" ? "탭해서 지도 보기" : "탭해서 전체 목록 보기";
  const sheetHandleLabel = state.sheetLevel === "full" ? "부스 목록 접기" : "부스 목록 펼치기";
  return `
    <main class="map-screen ${state.sheetLevel === "full" ? "sheet-full" : ""}">
      <header class="top-bar">
        <button class="icon-btn" data-route="home" title="홈" aria-label="홈">${icon("home")}</button>
        <div class="top-title"><strong>판교고 축제 맵</strong><span>${floorInfo.label} · ${floorInfo.caption} · ${state.user?.name || ""}님</span></div>
        <button class="icon-btn map-search-action ${state.search ? "has-query" : ""}" id="mapSearchBtn" type="button" aria-label="부스 검색">
          <span>⌕</span>
          ${state.search ? `<b>${globalSearchResults.length}</b>` : ""}
        </button>
        <button class="icon-btn" data-route="profile" title="내 정보" aria-label="내 정보">${state.user?.role === "admin" ? icon("admin") : icon("user")}</button>
      </header>
      <nav class="floor-tabs" aria-label="층 선택">
        ${FLOORS.map(({ floor, label, caption }) => `
          <button type="button" class="floor-tab ${state.floor === floor ? "active" : ""}" data-floor="${floor}" aria-pressed="${state.floor === floor}">
            <strong>${label}</strong><small>${caption}</small>
          </button>
        `).join("")}
      </nav>
      <section class="map-stage">
        <div class="map-context-bar">
          <span><strong>${floorInfo.label}</strong>${plan.subtitle}</span>
          <button type="button" id="resetMapView">전체보기</button>
        </div>
        <div class="map-legend" aria-label="지도 범례">
          <span><i class="classroom"></i>학급</span>
          <span><i class="facility"></i>시설</span>
          <span><i class="visited"></i>방문 완료</span>
        </div>
        <div class="map-card ${selectedBooth ? "has-preview" : ""}" id="mapCard" style="--map-zoom:${state.mapZoom};--map-x:${state.mapOffsetX}px;--map-y:${state.mapOffsetY}px">
          <div class="map-canvas">
            <div class="map-grid"></div>
            <div class="school-label">PANGYO HIGH SCHOOL · ${floorInfo.label}</div>
            ${mapPlanMarkup(plan, booths)}
            ${floatingBooths.map((booth, index) => {
              const position = boothMapPosition(booth);
              const markerLabel = booth.category === "class" ? booth.location.match(/(\d-\d)/)?.[1] || "부스" : "부스";
              return `<button class="${markerClass(booth)} ${state.selectedBoothId === booth.id ? "selected" : ""}" style="left:${position.x}%;top:${position.y}%;--stagger:${index * 18}ms" data-map-select="${booth.id}" aria-label="${booth.name}" title="${booth.name}"><span aria-hidden="true">${markerLabel}</span></button>`;
            }).join("")}
          </div>
          ${booths.length ? "" : mapEmptyCard()}
          ${selectedBooth ? mapPreviewCard(selectedBooth) : ""}
        </div>
      </section>
      <section class="sheet ${sheetClass()}" id="sheet">
        <button class="sheet-handle" id="sheetToggle" aria-label="${sheetHandleLabel}">
          <span class="sheet-grip"></span>
          <span class="sheet-snap-dots" aria-hidden="true">
            ${["peek", "mid", "full"].map((level) => `<i class="${state.sheetLevel === level || (level === "mid" && state.sheetOpen && state.sheetLevel !== "full") ? "active" : ""}"></i>`).join("")}
          </span>
        </button>
        <div class="sheet-head">
          <span>
            <strong>${floorInfo.label} 부스</strong>
            <small>${booths.length}개 · ${stampedCount}개 방문</small>
          </span>
          <small class="sheet-hint">${sheetHint}</small>
        </div>
        <div class="booth-list">${booths.length ? booths.map(boothItem).join("") : `<div class="empty-list">조건에 맞는 부스가 없습니다.</div>`}</div>
      </section>
      ${state.searchOpen ? searchOverlay(globalSearchResults) : ""}
      ${bottomNav("map")}
    </main>
  `;
}

function searchOverlay(booths) {
  return `
    <section class="search-screen" role="dialog" aria-modal="true" aria-label="부스 검색">
      <header class="search-screen-head">
        <button class="icon-btn" id="closeSearchScreen" type="button" aria-label="검색 닫기">${icon("back")}</button>
        <div class="search-screen-input ${state.search ? "has-clear" : ""}">
          <span aria-hidden="true">⌕</span>
          <input id="searchScreenInput" class="input" placeholder="부스 이름이나 위치 검색" value="${escapeHtml(state.search)}" autocomplete="off" enterkeyhint="search" />
          <button id="clearSearchScreen" type="button" class="clear-search-btn" aria-label="검색어 지우기" ${state.search ? "" : "hidden"}>×</button>
        </div>
      </header>
      <div class="search-screen-controls">
        ${choiceSelect({
          id: "search-sort",
          label: "이름순",
          caption: "정렬",
          options: [
            { label: "이름순", active: state.sort === "name", attr: `data-sort-option="name"` },
          ],
        })}
      </div>
      <div class="search-result-meta" aria-live="polite">
        <strong id="searchResultCount">${booths.length}개 결과</strong>
        <span id="searchResultQuery">${state.search ? `"${escapeHtml(state.search)}"` : "전체 부스"}</span>
      </div>
      <div class="search-result-list" id="searchResultList">
        ${booths.length ? booths.map(boothItem).join("") : `<div class="empty-list">조건에 맞는 부스가 없습니다.</div>`}
      </div>
    </section>
  `;
}

function updateSearchOverlay() {
  const input = document.querySelector("#searchScreenInput");
  const resultList = document.querySelector("#searchResultList");
  if (!input || !resultList) return;

  const booths = searchResults();
  const inputShell = input.closest(".search-screen-input");
  const clearButton = document.querySelector("#clearSearchScreen");
  const resultCount = document.querySelector("#searchResultCount");
  const resultQuery = document.querySelector("#searchResultQuery");

  inputShell?.classList.toggle("has-clear", Boolean(state.search));
  if (clearButton) clearButton.hidden = !state.search;
  if (resultCount) resultCount.textContent = `${booths.length}개 결과`;
  if (resultQuery) resultQuery.textContent = state.search ? `"${state.search}"` : "전체 부스";
  resultList.innerHTML = booths.length
    ? booths.map(boothItem).join("")
    : `<div class="empty-list">조건에 맞는 부스가 없습니다.</div>`;
  resultList.scrollTop = 0;
  bindBoothListButtons(resultList);
}

function mapEmptyCard() {
  return `
    <div class="map-empty-card">
      <strong>조건에 맞는 부스가 없어요</strong>
      <span>검색어를 지우고 다시 확인해보세요.</span>
      <button type="button" id="clearEmptySearch">검색 초기화</button>
    </div>
  `;
}

function choiceSelect({ id, label, caption = "", options }) {
  const open = state.openMenu === id;
  return `
    <div class="choice-select ${open ? "open" : ""}" data-choice-root="${id}">
      <button type="button" class="choice-trigger" data-toggle-menu="${id}" aria-expanded="${open}">
        <span><strong>${label}</strong>${caption ? `<small>${caption}</small>` : ""}</span>
        <i aria-hidden="true">⌄</i>
      </button>
      ${open ? `
        <div class="choice-menu" role="menu">
          ${options.map((option) => `
            <button type="button" class="choice-option ${option.active ? "active" : ""}" ${option.attr} role="menuitem">
              <span><strong>${option.label}</strong>${option.caption ? `<small>${option.caption}</small>` : ""}</span>
              ${Number.isFinite(option.count) ? `<b>${option.count}</b>` : ""}
            </button>
          `).join("")}
        </div>
      ` : ""}
    </div>
  `;
}

function markerClass(booth) {
  const classes = ["marker", booth.category || "class", `status-${booth.status}`];
  if (booth.favorite) classes.push("favorite");
  if (repo.hasStamp(state.user.id, booth.id)) classes.push("visited");
  return classes.join(" ");
}

function sheetClass() {
  if (state.sheetLevel === "full") return "full";
  if (state.sheetLevel === "mid" || state.sheetOpen) return "open";
  return "";
}

function boothItem(booth) {
  const stamped = repo.hasStamp(state.user.id, booth.id);
  const selected = state.selectedBoothId === booth.id;
  const visits = repo.boothVisits(booth.id);
  return `
    <button class="booth-item ${booth.category || "class"} ${stamped ? "visited" : ""} ${selected ? "selected" : ""}" data-list-select="${booth.id}">
      <span class="booth-main">
        <strong>${booth.favorite ? icon("heart") + " " : ""}${booth.name}</strong>
        <span class="meta">${booth.clubName} · ${booth.location} · ${formatOperatingHours(booth)}</span>
        <span class="booth-stats"><i>방문 ${visits}</i><i>${stamped ? "방문 인증 완료" : "방문 전"}</i></span>
      </span>
      ${statusBadge(booth.status)}
      <span class="stamp ${stamped ? "on" : ""}">${icon("stamp")}</span>
    </button>
  `;
}

function mapPreviewCard(booth) {
  const stamped = repo.hasStamp(state.user.id, booth.id);
  return `
    <article class="map-preview-card">
      <div>
        <strong>${booth.name}</strong>
        <span>${booth.location} · ${formatOperatingHours(booth)} · 방문 ${repo.boothVisits(booth.id)}</span>
        ${statusBadge(booth.status)}
        <span class="preview-status"><i class="${stamped ? "on" : ""}">${stamped ? "방문 인증 완료" : "방문 전"}</i></span>
      </div>
      <button type="button" class="preview-detail-btn" data-detail="${booth.id}">${stamped ? "다시보기" : "상세"}</button>
      <button type="button" class="preview-close-btn" data-clear-selection aria-label="선택 해제">×</button>
    </article>
  `;
}

function detailView() {
  const booth = state.db.booths.find((item) => item.id === state.selectedBoothId) || state.db.booths[0];
  const stamped = repo.hasStamp(state.user.id, booth.id);
  const mockNfcToken = STAMP_GATEWAY_MODE === "mock" ? mockNfcTokenForTagId(booth.nfcTagId) : "";
  return `
    <main class="screen detail-screen">
      <header class="top-bar">
        <button class="icon-btn" data-history-back="map" aria-label="지도 화면으로 돌아가기">${icon("back")}</button>
        <div class="top-title"><strong>부스 상세</strong><span>${booth.location}</span></div>
        ${mockNfcToken
          ? `<button class="icon-btn" data-nfc-token="${escapeHtml(mockNfcToken)}" data-nfc-source="detail-shortcut" title="NFC 모의 테스트">NFC</button>`
          : `<span class="icon-btn" aria-hidden="true"></span>`}
      </header>
      <section class="detail-hero">
        <div class="detail-status-row">${statusBadge(booth.status)}<span>${formatOperatingHours(booth)}</span></div>
        <div class="meta">${booth.clubName} · ${booth.floor}층 · ${booth.room}</div>
        <h1 class="title">${booth.name}</h1>
        <div class="meta"><span class="stamp ${stamped ? "on" : ""}">${icon("stamp")}</span> ${stamped ? "방문 인증 완료" : "아직 방문하지 않았어요"}</div>
      </section>
      <section class="panel section">
        <h2>부스 소개</h2>
        <p class="subtitle">${booth.description}</p>
      </section>
      <section class="panel section">
        <h2>방문 인증</h2>
        ${stamped
          ? `<p class="success-text">이 부스의 방문 기록이 축제 패스에 저장됐습니다.</p>`
          : `<p class="notice">부스의 NFC 태그를 인식해 방문을 인증하세요. 인식되지 않으면 운영자에게 수동 승인을 요청할 수 있습니다.</p>`}
        <button type="button" class="${stamped ? "ghost-btn" : "primary-btn"} full-action" ${mockNfcToken ? `data-nfc-token="${escapeHtml(mockNfcToken)}" data-nfc-source="detail-action"` : "disabled"}>${mockNfcToken ? (stamped ? "인증 결과 다시 확인" : "NFC 모의 방문 인증") : "NFC 태그를 스캔해 주세요"}</button>
      </section>
      ${bottomNav("map")}
    </main>
  `;
}

function reviewForm(enabled) {
  return `
    <div class="${enabled ? "" : "hidden"}">
      <div class="star-picker">${[1, 2, 3, 4, 5].map((n) => `<button class="star ${state.reviewRating >= n ? "on" : ""}" data-rating="${n}">${icon("star")}</button>`).join("")}</div>
      <textarea id="reviewContent" class="textarea" placeholder="방문 경험을 남겨주세요."></textarea>
      <button id="submitReview" class="primary-btn">리뷰 등록</button>
    </div>
    <button class="primary-btn" disabled ${enabled ? "hidden" : ""}>리뷰 작성</button>
  `;
}

function reviewView(review) {
  const user = state.db.users.find((item) => item.id === review.userId);
  return `<article class="review"><strong>${icon("star")} ${review.rating} · ${user?.name || "학생"}</strong><p>${review.content}</p></article>`;
}

function stampView() {
  const count = repo.stampsForUser(state.user.id).length;
  const total = state.db.booths.length;
  const percent = Math.min((count / Math.max(total, 1)) * 100, 100);
  return `
    <main class="screen p0-page stamp-screen">
      <header class="p0-header compact">
        <div><span class="eyebrow">FESTIVAL PASS</span><h1>나의 축제 패스</h1><p>내가 방문한 부스를 한눈에 확인하세요.</p></div>
      </header>
      <section class="pass-summary">
        <h1 class="title">현재 ${count}개 획득</h1>
        <p class="subtitle">전체 ${total}개 중 ${count}개를 모았습니다.</p>
        <div class="progress-wrap"><div class="progress" style="width:${percent}%"></div></div>
        <p class="pass-note">실제 계정·서버 연결 전까지 이 기기에만 저장돼요.</p>
      </section>
      <section class="p0-section">
        <div class="section-heading"><div><span>방문 목록</span><h2>${count ? "기록된 부스" : "아직 방문 기록이 없어요"}</h2></div></div>
        <div class="pass-list">
          ${state.db.booths.map((booth) => {
            const stamp = state.db.stamps.find((item) => item.userId === state.user.id && item.boothId === booth.id);
            return `<button type="button" class="pass-row ${stamp ? "earned" : ""}" data-list-select="${booth.id}"><span class="stamp ${stamp ? "on" : ""}">${icon("stamp")}</span><span><strong>${booth.name}</strong><small>${booth.location}${stamp ? ` · ${formatTime(stamp.createdAt)}` : " · 미방문"}</small></span></button>`;
          }).join("")}
        </div>
      </section>
      ${bottomNav("stamps")}
    </main>
  `;
}

function adminView() {
  const tabs = [
    ["dashboard", "현황"],
    ["booths", "부스/NFC"],
    ["visits", "방문 기록"],
    ["users", "참여자"],
  ];
  const currentTab = tabs.find(([id]) => id === state.adminTab) || tabs[0];
  return `
    <main class="screen admin-screen">
      <header class="top-bar">
        <button class="icon-btn" data-route="map">${icon("back")}</button>
        <div class="top-title"><strong>관리자 패널</strong><span>부스 운영, NFC, 방문 승인 관리</span></div>
        <button class="icon-btn" data-route="login">G</button>
      </header>
      <nav class="admin-tabs selector-bar">
        ${choiceSelect({
          id: "admin-tab",
          label: currentTab[1],
          caption: "관리 메뉴",
          options: tabs.map(([id, label]) => ({
            label,
            active: state.adminTab === id,
            attr: `data-admin-tab="${id}"`,
          })),
        })}
      </nav>
      ${adminPanel()}
      ${bottomNav("admin")}
    </main>
  `;
}

function adminPanel() {
  const regularUsers = state.db.users.filter((user) => user.role !== "admin");
  const totalVisits = state.db.stamps.length;
  const activeBooths = state.db.booths.filter((booth) => ["open", "crowded"].includes(booth.status)).length;
  const attentionBooths = state.db.booths.filter((booth) => ["crowded", "paused"].includes(booth.status)).length;

  if (state.adminTab === "dashboard") {
    const top = [...state.db.booths].sort((a, b) => repo.boothVisits(b.id) - repo.boothVisits(a.id)).slice(0, 5);
    return `
      <section class="admin-hero">
        <span class="admin-eyebrow">Festival Control</span>
        <h1>운영 현황</h1>
        <p>부스 운영 상태와 NFC 방문 인증 현황을 확인합니다.</p>
      </section>
      <section class="stats-grid admin-stats">
        <div class="stat"><span>총 방문 인증</span><strong>${totalVisits}</strong><small>스탬프 발급 수</small></div>
        <div class="stat"><span>운영 중 부스</span><strong>${activeBooths}</strong><small>혼잡 포함</small></div>
        <div class="stat"><span>참여자</span><strong>${regularUsers.length}</strong><small>관리자 제외</small></div>
        <div class="stat ${attentionBooths ? "warn" : ""}"><span>확인 필요</span><strong>${attentionBooths}</strong><small>혼잡·일시중지</small></div>
      </section>
      <section class="panel section admin-panel-card">
        <div class="admin-section-head"><h2>인기 부스 TOP 5</h2><span>방문수 기준</span></div>
        ${top.map((booth, index) => `<div class="rank-row"><b>${index + 1}</b><span><strong>${booth.name}</strong><small>${booth.location}</small></span><em>방문 ${repo.boothVisits(booth.id)}</em></div>`).join("")}
      </section>
      <section class="panel section admin-panel-card">
        <div class="admin-section-head"><h2>운영 체크</h2><span>빠른 점검</span></div>
        <div class="check-row ${state.db.booths.every((booth) => booth.nfcTagId) ? "ok" : "warn"}"><strong>NFC 태그</strong><span>${state.db.booths.filter((booth) => booth.nfcTagId).length}/${state.db.booths.length}개 등록</span></div>
        <div class="check-row ${attentionBooths ? "warn" : "ok"}"><strong>부스 상태</strong><span>${attentionBooths ? `${attentionBooths}개 확인 필요` : "모두 정상"}</span></div>
      </section>
    `;
  }
  if (state.adminTab === "booths") {
    return `
      <section class="panel admin-panel-card">
        <div class="admin-section-head"><h2>부스 추가</h2><span>NFC ID는 중복 불가</span></div>
        ${state.adminMessage ? `<p class="success-text">${state.adminMessage}</p>` : ""}
        <div class="input-stack admin-form-grid">
          <input id="boothName" class="input" placeholder="부스명" />
          <input id="boothLocation" class="input" placeholder="위치" />
          <select id="boothFloor" class="select"><option>1</option><option>2</option><option>3</option><option>4</option></select>
          <input id="boothNfc" class="input" placeholder="NFC 태그 ID" />
          <textarea id="boothDesc" class="textarea" placeholder="부스 설명"></textarea>
          <button id="addBooth" type="button" class="primary-btn">부스 추가</button>
        </div>
      </section>
      <section class="admin-table section">${state.db.booths.map(boothAdminRow).join("")}</section>
    `;
  }
  if (state.adminTab === "visits") {
    return `
      <section class="panel admin-panel-card">
        <div class="admin-section-head"><h2>수동 방문 승인</h2><span>테스트용 로컬 기록</span></div>
        ${state.adminMessage ? `<p class="success-text">${state.adminMessage}</p>` : ""}
        ${regularUsers.length ? `
          <div class="input-stack admin-form-grid">
            <select id="manualUser" class="select">${regularUsers.map((user) => `<option value="${user.id}">${user.name} · ${user.studentNumber}</option>`).join("")}</select>
            <select id="manualBooth" class="select">${state.db.booths.map((booth) => `<option value="${booth.id}">${booth.name} · ${booth.location}</option>`).join("")}</select>
            <button id="manualApproveStamp" type="button" class="primary-btn">수동 승인 기록</button>
          </div>
        ` : `<p class="notice">먼저 학생 계정으로 로그인한 기록이 필요합니다.</p>`}
      </section>
      ${state.db.stamps.length ? `<section class="admin-table section">${[...state.db.stamps].reverse().map(visitRow).join("")}</section>` : adminEmpty("아직 방문 기록이 없습니다.", "NFC 인식 또는 수동 승인 후 여기에 표시됩니다.")}
    `;
  }
  if (!regularUsers.length) return adminEmpty("아직 참여자가 없습니다.", "사용자가 로그인하고 학생 정보를 등록하면 여기에 표시됩니다.");
  return `<section class="admin-table">${regularUsers.map(userRow).join("")}</section>`;
}

function boothAdminRow(booth) {
  const visits = repo.boothVisits(booth.id);
  return `
    <div class="table-row admin-row">
      <div class="row-main">
        <strong>${booth.name}</strong>
        <p class="subtitle">${booth.floor}층 · ${booth.location}</p>
      </div>
      <div class="row-metrics"><span>방문 ${visits}</span>${statusBadge(booth.status)}</div>
      <label class="field compact-field">운영 상태
        <select class="select" id="status-${booth.id}">${Object.entries(BOOTH_STATUS).map(([value, info]) => `<option value="${value}" ${booth.status === value ? "selected" : ""}>${info.label}</option>`).join("")}</select>
      </label>
      <label class="field compact-field">NFC 태그 ID
        <input class="input" id="nfc-${booth.id}" value="${booth.nfcTagId}" />
      </label>
      <div class="row-actions">
        <button type="button" class="ghost-btn" data-save-nfc="${booth.id}">태그 저장</button>
        <button type="button" class="ghost-btn" data-save-status="${booth.id}">상태 저장</button>
        <button type="button" class="ghost-btn" data-test-nfc="${booth.id}">인식 테스트</button>
        <button type="button" class="danger-btn" data-delete-booth="${booth.id}">삭제</button>
      </div>
    </div>
  `;
}

function reviewRow(review) {
  const booth = state.db.booths.find((item) => item.id === review.boothId);
  const user = state.db.users.find((item) => item.id === review.userId);
  return `
    <div class="table-row admin-row">
      <div class="row-main">
        <strong>${booth?.name || "삭제된 부스"}</strong>
        <p class="subtitle">${user?.name || "알 수 없음"} · ${review.rating}점 · ${new Date(review.createdAt).toLocaleDateString("ko-KR")}</p>
      </div>
      <p class="admin-review-content">${review.content}</p>
      <div class="row-actions">
        <button type="button" class="danger-btn" data-delete-review="${review.id}">리뷰 삭제</button>
      </div>
    </div>
  `;
}

function userRow(user) {
  const stampCount = repo.stampsForUser(user.id).length;
  return `
    <div class="table-row admin-row">
      <div class="row-main">
        <strong>${user.name}</strong>
        <p class="subtitle">${user.studentNumber} · ${user.schoolId} · ${user.googleEmail || "Google 미연동"}</p>
      </div>
      <div class="row-metrics"><span>방문 인증 ${stampCount}개</span><span>활성 사용자</span></div>
    </div>
  `;
}

function visitRow(stamp) {
  const booth = state.db.booths.find((item) => item.id === stamp.boothId);
  const user = state.db.users.find((item) => item.id === stamp.userId);
  return `
    <div class="table-row admin-row">
      <div class="row-main"><strong>${booth?.name || "삭제된 부스"}</strong><p class="subtitle">${user?.name || "알 수 없음"} · ${stamp.method === "manual" ? "수동 승인" : "NFC"}</p></div>
      <div class="row-metrics"><span>${formatTime(stamp.createdAt)}</span><span>${booth?.location || "위치 없음"}</span></div>
    </div>
  `;
}

function adminEmpty(title, body) {
  return `
    <section class="panel admin-empty">
      <strong>${title}</strong>
      <p>${body}</p>
    </section>
  `;
}

function bottomNav(active) {
  return `
    <nav class="bottom-nav" aria-label="주요 메뉴">
      <button class="nav-btn ${active === "home" ? "active" : ""}" data-route="home"><span>${icon("home")}</span><span>홈</span></button>
      <button class="nav-btn ${active === "map" ? "active" : ""}" data-route="map"><span>${icon("map")}</span><span>부스</span></button>
      <button class="nav-btn scan-nav ${active === "scan" ? "active" : ""}" data-route="scan"><span>${icon("scan")}</span><span>NFC</span></button>
      <button class="nav-btn ${active === "stamps" ? "active" : ""}" data-route="stamps"><span>${icon("stamp")}</span><span>패스</span></button>
      <button class="nav-btn ${active === "profile" ? "active" : ""}" data-route="profile"><span>${icon("user")}</span><span>내 정보</span></button>
    </nav>
  `;
}

function bindBoothListButtons(root = document) {
  root.querySelectorAll("[data-list-select]").forEach((button) => {
    if (button.dataset.listSelectBound === "true") return;
    button.dataset.listSelectBound = "true";
    button.addEventListener("click", () => goDetail(button.dataset.listSelect));
  });
}

function bindEvents() {
  document.querySelectorAll(".choice-select").forEach((root) => {
    root.addEventListener("click", (event) => event.stopPropagation());
  });
  document.querySelectorAll("[data-toggle-menu]").forEach((button) => {
    button.addEventListener("click", () => {
      state.openMenu = state.openMenu === button.dataset.toggleMenu ? null : button.dataset.toggleMenu;
      render();
    });
  });
  document.body.onclick = () => {
    if (!state.openMenu) return;
    state.openMenu = null;
    render();
  };
  document.querySelectorAll("button[data-route]").forEach((button) => {
    button.addEventListener("click", () => {
      closeMenus();
      state.searchOpen = false;
      if (button.dataset.route === "admin" && state.user?.role !== "admin") {
        state.loginError = "관리자 계정으로 로그인해야 접근할 수 있습니다.";
        navigateTo("login", { replace: true });
        return;
      }
      if (button.dataset.route === "login") {
        resetLogin();
        navigateTo("login", { replace: true });
        return;
      }
      navigateTo(button.dataset.route);
    });
  });
  document.querySelectorAll("[data-history-back]").forEach((button) => {
    button.addEventListener("click", () => {
      const fallback = button.dataset.historyBack || "home";
      if (navigationIndex > 0) history.back();
      else navigateTo(fallback, { replace: true });
    });
  });
  document.querySelector("#googleLogin")?.addEventListener("click", () => runActionOnce("google-login", () => startGoogleLogin("student")));
  document.querySelector("#profileSubmit")?.addEventListener("click", completeProfile);
  document.querySelector("#backToGoogle")?.addEventListener("click", () => {
    resetLogin();
    render();
  });
  document.querySelector("#adminLogin")?.addEventListener("click", () => runActionOnce("admin-login", adminLogin));
  document.querySelectorAll("[data-floor]").forEach((button) => button.addEventListener("click", () => {
    const nextFloor = Number(button.dataset.floor);
    if (state.floor === nextFloor) return;
    closeMenus();
    state.floor = nextFloor;
    state.sheetOpen = false;
    state.sheetLevel = "peek";
    state.mapZoom = 1;
    state.mapOffsetX = 0;
    state.mapOffsetY = 0;
    state.searchOpen = false;
    render();
    writeNavigationHistory("push");
  }));
  document.querySelector("#sheetToggle")?.addEventListener("click", () => {
    if (state.sheetLevel === "peek") {
      setSheetLevel("mid");
    } else if (state.sheetLevel === "mid") {
      setSheetLevel("full");
    } else {
      setSheetLevel("peek");
    }
    render();
  });
  document.querySelector("#resetMapView")?.addEventListener("click", () => {
    state.mapZoom = 1;
    state.mapOffsetX = 0;
    state.mapOffsetY = 0;
    state.selectedBoothId = null;
    render();
  });
  document.querySelector(".sheet-head")?.addEventListener("click", () => {
    if (state.sheetLevel === "peek") {
      setSheetLevel("mid");
    } else if (state.sheetLevel === "mid") {
      setSheetLevel("full");
    } else {
      setSheetLevel("peek");
    }
    render();
  });
  document.querySelector("#mapSearchBtn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    openSearchScreen();
  });
  document.querySelector("#closeSearchScreen")?.addEventListener("click", () => {
    state.search = "";
    state.searchOpen = false;
    closeMenus();
    if (history.state?.key === HISTORY_KEY && history.state.searchOpen && navigationIndex > 0) history.back();
    else {
      render();
      writeNavigationHistory("replace");
    }
  });
  bindMapDrag();
  bindSheetDrag();
  const searchInput = document.querySelector("#searchScreenInput");
  const commitSearch = (value) => {
    if (state.search === value) return;
    state.search = value;
    state.searchOpen = true;
    updateSearchOverlay();
  };
  searchInput?.addEventListener("compositionstart", () => {
    searchInput.dataset.composing = "true";
  });
  searchInput?.addEventListener("compositionend", (event) => {
    delete searchInput.dataset.composing;
    commitSearch(event.target.value);
  });
  searchInput?.addEventListener("input", (event) => {
    if (event.isComposing || searchInput.dataset.composing === "true") return;
    commitSearch(event.target.value);
  });
  document.querySelector("#clearEmptySearch")?.addEventListener("click", () => {
    state.search = "";
    setSheetLevel("full");
    render();
  });
  document.querySelector("#clearSearchScreen")?.addEventListener("click", () => {
    state.search = "";
    state.searchOpen = true;
    if (searchInput) searchInput.value = "";
    updateSearchOverlay();
    searchInput?.focus();
  });
  document.querySelectorAll("[data-sort-option]").forEach((button) => button.addEventListener("click", () => {
    closeMenus();
    state.sort = button.dataset.sortOption;
    render();
  }));
  document.querySelectorAll("[data-map-select]").forEach((button) => button.addEventListener("click", () => {
    selectMapBooth(button.dataset.mapSelect);
  }));
  document.querySelector("#mapCard")?.addEventListener("click", (event) => {
    if (!state.selectedBoothId) return;
    if (event.target.closest("button") || event.target.closest(".map-preview-card")) return;
    state.selectedBoothId = null;
    state.mapZoom = 1;
    state.mapOffsetX = 0;
    state.mapOffsetY = 0;
    if (history.state?.key === HISTORY_KEY && history.state.selectedBoothId && navigationIndex > 0) history.back();
    else {
      render();
      writeNavigationHistory("replace");
    }
  });
  bindBoothListButtons();
  document.querySelectorAll("[data-clear-selection]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      state.selectedBoothId = null;
      state.mapZoom = 1;
      state.mapOffsetX = 0;
      state.mapOffsetY = 0;
      if (history.state?.key === HISTORY_KEY && history.state.selectedBoothId && navigationIndex > 0) history.back();
      else {
        render();
        writeNavigationHistory("replace");
      }
    });
  });
  document.querySelectorAll("[data-detail]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    goDetail(button.dataset.detail);
  }));
  document.querySelectorAll("[data-nfc-token]").forEach((button) => button.addEventListener("click", () => {
    const claim = createNfcClaim(button.dataset.nfcToken, button.dataset.nfcSource || "ui");
    runActionOnce("nfc-claim", () => nfcAdapter.scan(claim));
  }));
  document.querySelector("#retryNfcClaim")?.addEventListener("click", () => {
    if (!state.pendingNfcClaim) return;
    runActionOnce("nfc-claim", () => nfcAdapter.scan(state.pendingNfcClaim));
  });
  document.querySelector("#clearScanResult")?.addEventListener("click", () => {
    state.scanResult = null;
    state.pendingNfcClaim = null;
    render();
  });
  document.querySelector("#resetNfcTestStamps")?.addEventListener("click", resetNfcTestStamps);
  document.querySelectorAll("[data-rating]").forEach((button) => button.addEventListener("click", () => {
    state.reviewRating = Number(button.dataset.rating);
    render();
  }));
  document.querySelector("#submitReview")?.addEventListener("click", submitReview);
  document.querySelectorAll("[data-admin-tab]").forEach((button) => button.addEventListener("click", () => {
    closeMenus();
    state.adminTab = button.dataset.adminTab;
    render();
    requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "auto" }));
  }));
  document.querySelector("#addBooth")?.addEventListener("click", () => runActionOnce("admin:add-booth", addBooth));
  document.querySelectorAll("[data-delete-booth]").forEach((button) => button.addEventListener("click", () => deleteBooth(button.dataset.deleteBooth)));
  document.querySelectorAll("[data-save-nfc]").forEach((button) => button.addEventListener("click", () => runActionOnce(`admin:nfc:${button.dataset.saveNfc}`, () => saveNfcTag(button.dataset.saveNfc))));
  document.querySelectorAll("[data-save-status]").forEach((button) => button.addEventListener("click", () => runActionOnce(`admin:status:${button.dataset.saveStatus}`, () => saveBoothStatus(button.dataset.saveStatus))));
  document.querySelectorAll("[data-test-nfc]").forEach((button) => button.addEventListener("click", () => testNfcTag(button.dataset.testNfc)));
  document.querySelector("#manualApproveStamp")?.addEventListener("click", () => runActionOnce("admin:manual-approve", manualApproveStamp));
  document.querySelectorAll("[data-delete-review]").forEach((button) => button.addEventListener("click", () => deleteReview(button.dataset.deleteReview)));
  document.querySelectorAll("[data-exchange]").forEach((button) => button.addEventListener("click", () => completeExchange(button.dataset.exchange)));
}

function closeMenus() {
  state.openMenu = null;
}

function openSearchScreen() {
  if (state.searchOpen) return;
  state.searchOpen = true;
  closeMenus();
  render();
  writeNavigationHistory("push");
  focusSearchInput();
}

function focusSearchInput() {
  requestAnimationFrame(() => {
    const input = document.querySelector("#searchScreenInput");
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
}

function setSheetLevel(level) {
  state.sheetLevel = level;
  state.sheetOpen = level !== "peek";
}

function bindSheetDrag() {
  const handle = document.querySelector("#sheetToggle");
  const sheet = document.querySelector("#sheet");
  if (!handle || !sheet) return;
  let startY = 0;
  let startHeight = 0;
  let currentHeight = 0;
  let dragging = false;
  let moved = false;
  let peekHeight = 0;
  let midHeight = 0;
  let fullHeight = 0;
  let paintFrame = 0;
  let pendingHeight = 0;

  const measureTargets = () => {
    peekHeight = Number.parseFloat(getComputedStyle(sheet).getPropertyValue("--sheet-peek-height")) || 44;
    midHeight = Math.min(320, Math.max(220, window.innerHeight * 0.38));
    const navTop = document.querySelector(".bottom-nav")?.getBoundingClientRect().top || window.innerHeight - 72;
    fullHeight = Math.max(midHeight, navTop - 122);
  };
  const heightForLevel = (level) => {
    if (level === "full") return fullHeight;
    if (level === "mid") return midHeight;
    return peekHeight;
  };
  const clampHeight = (value) => Math.min(fullHeight, Math.max(peekHeight, value));
  const queuePaint = (height) => {
    pendingHeight = height;
    if (paintFrame) return;
    paintFrame = requestAnimationFrame(() => {
      paintFrame = 0;
      sheet.style.height = `${pendingHeight}px`;
    });
  };

  const finish = () => {
    if (!dragging) return;
    if (paintFrame) cancelAnimationFrame(paintFrame);
    paintFrame = 0;
    dragging = false;
    sheet.classList.remove("dragging");
    sheet.style.height = "";
    if (!moved) return;
    const targets = [
      ["full", fullHeight],
      ["mid", midHeight],
      ["peek", peekHeight],
    ];
    const [level] = targets.reduce((best, item) => (
      Math.abs(item[1] - currentHeight) < Math.abs(best[1] - currentHeight) ? item : best
    ), targets[0]);
    setSheetLevel(level);
    render();
  };

  handle.addEventListener("pointerdown", (event) => {
    measureTargets();
    dragging = true;
    moved = false;
    startY = event.clientY;
    startHeight = heightForLevel(state.sheetLevel);
    currentHeight = startHeight;
    sheet.classList.add("dragging");
    handle.setPointerCapture?.(event.pointerId);
  });
  handle.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    if (!moved && Math.abs(event.clientY - startY) < 4) return;
    moved = true;
    currentHeight = clampHeight(startHeight - (event.clientY - startY));
    queuePaint(currentHeight);
  });
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
}

function bindMapDrag() {
  const card = document.querySelector("#mapCard");
  const canvas = card?.querySelector(".map-canvas");
  if (!card || !canvas) return;

  const pointers = new Map();
  let startX = 0;
  let startY = 0;
  let baseX = state.mapOffsetX;
  let baseY = state.mapOffsetY;
  let baseZoom = state.mapZoom;
  let pinchStart = 0;
  let dragging = false;
  let moved = false;
  let lastTap = { time: 0, x: 0, y: 0 };
  let lastTouchZoomAt = 0;
  let transformFrame = 0;
  let pendingTransform = "";

  const clamp = (value, max) => Math.min(max, Math.max(-max, value));
  const distance = ([first, second]) => Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
  const queueTransform = (value) => {
    pendingTransform = value;
    if (transformFrame) return;
    transformFrame = requestAnimationFrame(() => {
      transformFrame = 0;
      canvas.style.transform = pendingTransform;
    });
  };
  const zoomAt = (clientX, clientY) => {
    const nextZoom = Number(Math.min(1.6, Math.max(1.1, state.mapZoom + 0.22)).toFixed(2));
    const rect = card.getBoundingClientRect();
    const maxX = 72 * nextZoom;
    const maxY = 92 * nextZoom;
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    state.mapZoom = nextZoom;
    state.mapOffsetX = clamp(state.mapOffsetX + (centerX - clientX) * 0.18, maxX);
    state.mapOffsetY = clamp(state.mapOffsetY + (centerY - clientY) * 0.18, maxY);
    render();
  };

  card.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button, input, select, textarea")) return;
    pointers.set(event.pointerId, event);
    dragging = true;
    moved = false;
    startX = event.clientX;
    startY = event.clientY;
    baseX = state.mapOffsetX;
    baseY = state.mapOffsetY;
    baseZoom = state.mapZoom;
    if (pointers.size === 2) pinchStart = distance([...pointers.values()]);
    card.classList.add("dragging");
    card.setPointerCapture?.(event.pointerId);
  });

  card.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    if (pointers.has(event.pointerId)) pointers.set(event.pointerId, event);
    if (Math.abs(event.clientX - startX) > 7 || Math.abs(event.clientY - startY) > 7) moved = true;
    if (pointers.size >= 2 && pinchStart) {
      moved = true;
      const nextZoom = Number(Math.min(1.6, Math.max(0.9, baseZoom * (distance([...pointers.values()].slice(0, 2)) / pinchStart))).toFixed(2));
      state.mapZoom = nextZoom;
      const maxX = 72 * nextZoom;
      const maxY = 92 * nextZoom;
      const nextX = clamp(state.mapOffsetX, maxX);
      const nextY = clamp(state.mapOffsetY, maxY);
      state.mapOffsetX = nextX;
      state.mapOffsetY = nextY;
      queueTransform(`translate(${nextX}px, ${nextY}px) scale(${nextZoom})`);
      return;
    }
    const maxX = 72 * state.mapZoom;
    const maxY = 92 * state.mapZoom;
    const nextX = clamp(baseX + event.clientX - startX, maxX);
    const nextY = clamp(baseY + event.clientY - startY, maxY);
    queueTransform(`translate(${nextX}px, ${nextY}px) scale(${state.mapZoom})`);
  });

  const finish = (event) => {
    if (!dragging) return;
    if (transformFrame) cancelAnimationFrame(transformFrame);
    transformFrame = 0;
    pointers.delete(event.pointerId);
    if (pointers.size >= 1) {
      const [remaining] = pointers.values();
      startX = remaining.clientX;
      startY = remaining.clientY;
      baseX = state.mapOffsetX;
      baseY = state.mapOffsetY;
      baseZoom = state.mapZoom;
      pinchStart = pointers.size === 2 ? distance([...pointers.values()]) : 0;
      return;
    }
    const maxX = 72 * state.mapZoom;
    const maxY = 92 * state.mapZoom;
    state.mapOffsetX = clamp(baseX + event.clientX - startX, maxX);
    state.mapOffsetY = clamp(baseY + event.clientY - startY, maxY);
    const now = Date.now();
    const tapDistance = Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y);
    dragging = false;
    pinchStart = 0;
    card.classList.remove("dragging");
    // A map tap re-renders during pointerup, so clear the preview here instead of
    // waiting for the later click event that would otherwise be discarded.
    if (!moved && state.selectedBoothId && !event.target.closest("button, input, select, textarea")) {
      state.selectedBoothId = null;
      state.mapZoom = 1;
      state.mapOffsetX = 0;
      state.mapOffsetY = 0;
      render();
      return;
    }
    if (!moved && now - lastTap.time < 320 && tapDistance < 36) {
      lastTap = { time: 0, x: 0, y: 0 };
      lastTouchZoomAt = now;
      zoomAt(event.clientX, event.clientY);
      return;
    }
    if (!moved) lastTap = { time: now, x: event.clientX, y: event.clientY };
    render();
  };

  card.addEventListener("pointerup", finish);
  card.addEventListener("pointercancel", finish);
  card.addEventListener("dblclick", (event) => {
    if (event.target.closest("button, input, select, textarea")) return;
    event.preventDefault();
    if (Date.now() - lastTouchZoomAt < 360) return;
    zoomAt(event.clientX, event.clientY);
  });
}

function resetLogin() {
  state.user = null;
  state.authStep = "google";
  state.pendingGoogle = null;
  state.authIntent = "student";
  state.loginBusy = false;
  state.loginError = "";
  state.openMenu = null;
}

async function startGoogleLogin(intent = "student") {
  if (state.loginBusy) return;
  state.authIntent = intent;
  state.loginError = "";
  state.loginBusy = true;
  render();
  try {
    state.pendingGoogle = await authProvider.signInWithGoogle();
    if (intent === "admin") {
      state.loginBusy = false;
      finishAdminGoogleLogin(state.pendingGoogle);
      return;
    }
    let user = state.db.users.find((item) => item.googleUid === state.pendingGoogle.uid);
    if (!user) {
      user = { id: makeId(), role: "user", exchangedAt: null };
      state.db.users.push(user);
    }
    Object.assign(user, {
      googleUid: state.pendingGoogle.uid,
      googleEmail: state.pendingGoogle.email,
      studentNumber: user.studentNumber || "demo-student",
      schoolId: user.schoolId || "google-demo-user",
      name: user.name || state.pendingGoogle.displayName || "판교고 학생",
      role: user.role || "user",
    });
    saveDb();
    state.user = user;
    state.authStep = "google";
    state.loginBusy = false;
    state.loginError = "";
    state.openMenu = null;
    navigateTo("home", { replace: true });
    consumePendingNfc();
  } catch (error) {
    state.loginBusy = false;
    state.loginError = error.message || "로그인 처리 중 문제가 생겼습니다.";
    state.route = "login";
    render();
  }
}

function completeProfile() {
  const google = state.pendingGoogle;
  const name = document.querySelector("#name").value.trim();
  const studentNumber = document.querySelector("#studentNumber").value.trim();
  const schoolId = document.querySelector("#schoolId").value.trim();
  if (!name || !studentNumber || !schoolId) {
    state.loginError = "이름, 학번, 아이디를 모두 입력해주세요.";
    render();
    return;
  }
  const sameStudent = state.db.users.find((user) => user.studentNumber === studentNumber && user.googleUid !== google.uid);
  const sameSchoolId = state.db.users.find((user) => user.schoolId === schoolId && user.googleUid !== google.uid);
  if (sameStudent || sameSchoolId) {
    state.loginError = "이미 다른 구글 계정에 등록된 학번 또는 아이디입니다.";
    render();
    return;
  }
  let user = state.db.users.find((item) => item.googleUid === google.uid);
  if (!user) {
    user = { id: makeId(), role: "user", exchangedAt: null };
    state.db.users.push(user);
  }
  Object.assign(user, {
    googleUid: google.uid,
    googleEmail: google.email,
    studentNumber,
    schoolId,
    name,
    role: user.role || "user",
  });
  saveDb();
  state.user = user;
  state.loginError = "";
  navigateTo("home", { replace: true });
  consumePendingNfc();
}

function adminLogin() {
  finishAdminGoogleLogin(authProvider.signInAdmin());
}

function finishAdminGoogleLogin(google) {
  let admin = state.db.users.find((user) => user.googleUid === google.uid || user.role === "admin");
  if (!admin) {
    admin = { id: "u-admin", role: "admin", exchangedAt: null };
    state.db.users.push(admin);
  }
  Object.assign(admin, {
    googleUid: google.uid,
    googleEmail: google.email,
    studentNumber: "admin",
    schoolId: "festival-admin",
    name: "축제 관리자",
    role: "admin",
  });
  saveDb();
  state.user = admin;
  state.loginError = "";
  state.openMenu = null;
  navigateTo("admin", { replace: true });
}

function consumePendingNfc() {
  if (!state.pendingNfcClaim || !state.user) return;
  const claim = state.pendingNfcClaim;
  nfcAdapter.scan(claim);
}

function goDetail(id) {
  if (state.route === "detail" && state.selectedBoothId === id) return;
  state.selectedBoothId = id;
  state.searchOpen = false;
  state.sheetOpen = false;
  state.sheetLevel = "peek";
  state.openMenu = null;
  navigateTo("detail");
}

function selectMapBooth(id) {
  if (state.selectedBoothId === id) return;
  state.selectedBoothId = id;
  state.searchOpen = false;
  if (state.sheetLevel === "full") setSheetLevel("mid");
  state.openMenu = null;
  render();
  writeNavigationHistory("push");
}

function focusMapOnBooth(id, targetZoom = state.mapZoom) {
  const booth = state.db.booths.find((item) => item.id === id);
  if (!booth) return;
  const position = boothMapPosition(booth);
  state.mapZoom = Math.min(1.52, Math.max(state.mapZoom, targetZoom));
  const maxX = 72 * state.mapZoom;
  const maxY = 92 * state.mapZoom;
  const targetX = (50 - position.x) * 1.35;
  const targetY = (48 - position.y) * 1.15;
  state.mapOffsetX = Math.min(maxX, Math.max(-maxX, targetX));
  state.mapOffsetY = Math.min(maxY, Math.max(-maxY, targetY));
}

function submitReview() {
  const content = document.querySelector("#reviewContent").value.trim();
  if (!content) return;
  if (!repo.hasStamp(state.user.id, state.selectedBoothId) || repo.hasReview(state.user.id, state.selectedBoothId)) return;
  state.db.reviews.push({ id: makeId(), userId: state.user.id, boothId: state.selectedBoothId, rating: state.reviewRating, content, createdAt: new Date().toISOString() });
  saveDb();
  render();
}

function addBooth() {
  const name = document.querySelector("#boothName").value.trim();
  if (!name) return;
  const nfcTagId = document.querySelector("#boothNfc").value.trim() || `NFC-${Date.now()}`;
  if (state.db.booths.some((booth) => booth.nfcTagId === nfcTagId)) {
    state.adminMessage = "이미 등록된 NFC 태그 ID입니다.";
    render();
    return;
  }
  state.db.booths.push({
    id: makeId(),
    eventId: EVENT.id,
    clubName: name,
    name,
    floor: Number(document.querySelector("#boothFloor").value),
    room: document.querySelector("#boothLocation").value.trim() || "위치 미정",
    location: document.querySelector("#boothLocation").value.trim(),
    description: document.querySelector("#boothDesc").value.trim(),
    status: "preparing",
    opensAt: EVENT.startsAt,
    closesAt: EVENT.endsAt,
    nfcTagId,
    x: 28 + Math.floor(Math.random() * 42),
    y: 30 + Math.floor(Math.random() * 38),
    favorite: false,
    category: "custom",
  });
  saveDb();
  state.adminMessage = "부스가 추가되었습니다.";
  render();
}

function deleteBooth(id) {
  state.db.booths = state.db.booths.filter((booth) => booth.id !== id);
  state.db.stamps = state.db.stamps.filter((stamp) => stamp.boothId !== id);
  state.db.idempotencyRecords = state.db.idempotencyRecords.filter((record) => record.boothId !== id);
  state.db.reviews = state.db.reviews.filter((review) => review.boothId !== id);
  saveDb();
  render();
}

function saveNfcTag(id) {
  const booth = state.db.booths.find((item) => item.id === id);
  const next = document.getElementById(`nfc-${id}`).value.trim();
  if (!next) return;
  if (state.db.booths.some((item) => item.id !== id && item.nfcTagId === next)) {
    state.adminMessage = "이미 다른 부스에 등록된 NFC 태그 ID입니다.";
    render();
    return;
  }
  booth.nfcTagId = next;
  saveDb();
  state.adminMessage = `${booth.name} NFC 태그가 저장되었습니다.`;
  render();
}

function saveBoothStatus(id) {
  const booth = state.db.booths.find((item) => item.id === id);
  const select = document.getElementById(`status-${id}`);
  if (!booth || !select || !BOOTH_STATUS[select.value]) return;
  booth.status = select.value;
  saveDb();
  state.adminMessage = `${booth.name} 상태를 ${statusInfo(booth.status).label}(으)로 변경했습니다.`;
  render();
}

function manualApproveStamp() {
  const userId = document.getElementById("manualUser")?.value;
  const boothId = document.getElementById("manualBooth")?.value;
  const user = state.db.users.find((item) => item.id === userId && item.role !== "admin");
  const booth = state.db.booths.find((item) => item.id === boothId);
  if (!user || !booth) return;
  if (repo.hasStamp(user.id, booth.id)) {
    state.adminMessage = `${user.name} 학생은 이미 ${booth.name} 방문 인증을 완료했습니다.`;
    render();
    return;
  }
  const earnedAt = new Date().toISOString();
  state.db.stamps.push({
    id: makeId(),
    eventId: EVENT.id,
    userId: user.id,
    boothId: booth.id,
    method: "manual",
    status: "active",
    earnedAt,
    createdAt: earnedAt,
  });
  saveDb();
  state.adminMessage = `${user.name} 학생의 ${booth.name} 방문을 수동 승인했습니다.`;
  render();
}

function resetNfcTestStamps() {
  if (!state.user) return;
  const testBoothIds = new Set(nfcTestBooths().map((booth) => booth.id));
  const before = state.db.stamps.length;
  state.db.stamps = state.db.stamps.filter((stamp) => (
    stamp.userId !== state.user.id || !testBoothIds.has(stamp.boothId)
  ));
  state.db.idempotencyRecords = state.db.idempotencyRecords.filter((record) => (
    record.actorId !== state.user.id || !testBoothIds.has(record.boothId)
  ));
  const removed = before - state.db.stamps.length;
  if (removed) saveDb();
  state.scanResult = null;
  state.nfcTestMessage = removed
    ? `테스트 스탬프 ${removed}개를 초기화했어요.`
    : "초기화할 테스트 스탬프가 없어요.";
  render();
}

function testNfcTag(id) {
  const booth = state.db.booths.find((item) => item.id === id);
  if (!booth) return;
  state.adminMessage = `${booth.name} 태그 인식 테스트 완료`;
  state.selectedBoothId = id;
  navigateTo("detail");
}

function deleteReview(id) {
  state.db.reviews = state.db.reviews.filter((review) => review.id !== id);
  saveDb();
  render();
}

function completeExchange(id) {
  const user = state.db.users.find((item) => item.id === id);
  user.exchangedAt = new Date().toISOString();
  saveDb();
  render();
}

function showStampPop() {
  const pop = document.createElement("div");
  pop.className = "stamp-pop";
  pop.setAttribute("role", "status");
  pop.setAttribute("aria-live", "polite");
  pop.textContent = "스탬프 획득";
  document.body.appendChild(pop);
  setTimeout(() => pop.remove(), 900);
}

initializeNavigation();
if (state.pendingNfcClaim) nfcAdapter.scan(state.pendingNfcClaim);
else render();
