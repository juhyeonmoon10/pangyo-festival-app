const DB_KEY = "pangyo-festival-db-v3";
const SESSION_KEY = "pangyo-festival-demo-session-v1";
// Everything a demo visitor earns. Cleared when the app is closed, unlike the booth setup.
const SESSION_FIELDS = ["users", "stamps", "idempotencyRecords", "reviews"];
const MAP_ZOOM_MIN = 0.9;
const MAP_ZOOM_MAX = 1.6;
const MAP_ZOOM_STEP = 0.2;
const STAMP_GATEWAY_MODE = new URL(location.href).searchParams.get("demo") === "1" ? "mock" : "supabase";
const isServerMode = () => STAMP_GATEWAY_MODE === "supabase";
let festivalAccount = null;
let serverCompletedBooths = [];
// Server-mode caches. Keys are DB booth enum values, never local booth ids.
let serverMyReviews = null;
const serverReviews = new Map();
const serverAdmin = { busy: false, boothId: null, result: null, label: "", tags: null, tagsEnabled: true, tagsLoading: false, tagsError: "", tagBooth: "all", tagStatus: "all", tagBusy: null, editingTag: null, registerNote: "", registerTone: "", tagReading: false };
const MOCK_NFC_TOKEN_PREFIX = "mock-v1.";
const SUN_LAST_READ_KEY = "festival-sun-last-read";
const ADMIN_ONLY_NFC_SOURCES = new Set(["mock-panel", "detail-shortcut", "detail-action"]);
const CLUB_CATALOG_VERSION = 1;
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
  paused: { label: "일시 중지", tone: "warning" },
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
  reviewRating: 0,
  reviewDraft: "",
  reviewBusy: false,
  reviewPickerOpen: false,
  boothReviewsExpanded: false,
  stampTrailExpanded: false,
  authStep: "google",
  pendingGoogle: null,
  authIntent: "student",
  loginBusy: false,
  loginError: "",
  nameEdit: { open: false, draft: "", busy: false, error: "", message: "" },
  adminMessage: "",
  scanResult: null,
  nfcTestMessage: "",
  pendingNfcClaim: null,
};

const HISTORY_KEY = "pangyo-festival-navigation-v1";
const actionLocks = new Set();
let navigationIndex = 0;
let navigationReady = false;
let pendingNavigation = null;

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
    reviewPickerOpen: state.reviewPickerOpen,
    noticeId: state.noticeId || null,
    mapSelection: state.route === "map" && Boolean(state.selectedBoothId && state.mapSelectionEntry),
  };
}

function writeNavigationHistory(mode = "push") {
  try {
    if (mode === "push") navigationIndex += 1;
    const snapshot = navigationSnapshot();
    const url = window.FestivalRouter?.href(snapshot, location.href, pendingNavigation);
    history[mode === "replace" ? "replaceState" : "pushState"](snapshot, "", url);
  } catch {
    // Local file previews can restrict History API writes in some browsers.
  }
}

function navigateTo(route, { replace = false } = {}) {
  const changed = state.route !== route || (window.FestivalRouter?.isWeb(location)
    && window.FestivalRouter.pathname({route,selectedBoothId:state.selectedBoothId,noticeId:state.noticeId}) !== location.pathname);
  if (window.FestivalRouter && !state.user && route !== "login") {
    pendingNavigation = { ...navigationSnapshot(), route };
    route = "login";
  }
  state.route = route;
  writeNavigationHistory(replace || !changed ? "replace" : "push");
  render();
  loadNavigationContent();
}

function applyNavigationSnapshot(snapshot) {
  state.route = snapshot.route || "home";
  state.floor = Number(snapshot.floor) || 1;
  if (!FLOORS.some(item => item.floor === state.floor)) state.floor = 1;
  state.selectedBoothId = snapshot.selectedBoothId || null;
  state.mapSelectionEntry = Boolean(snapshot.mapSelection);
  state.noticeId = snapshot.noticeId || null;
  state.sheetLevel = snapshot.sheetLevel || "peek";
  state.sheetOpen = state.sheetLevel !== "peek";
  state.searchOpen = Boolean(snapshot.searchOpen);
  state.adminTab = snapshot.adminTab || "dashboard";
  state.reviewPickerOpen = Boolean(snapshot.reviewPickerOpen);
  if (state.user && state.route === "detail" && state.selectedBoothId) {
    const draft = festivalWeb.draft(state.selectedBoothId);
    state.reviewDraft = draft.content;
    state.reviewRating = festivalWeb.ownReview(state.selectedBoothId)?.rating || draft.rating;
  }
  if (!state.user && state.route !== "login") {
    pendingNavigation = snapshot;
    state.route = "login";
    state.searchOpen = false;
    state.reviewPickerOpen = false;
  }
}

function loadNavigationContent() {
  if (!state.user) return;
  if (state.route === "reviews") festivalWeb.loadReviewContents();
  if (["detail", "boothReviews"].includes(state.route) && state.selectedBoothId) {
    loadBoothReviews(state.selectedBoothId, {force: state.route === "boothReviews"});
  }
}

function resumeRequestedNavigation() {
  const target = pendingNavigation || { route: "home" };
  pendingNavigation = null;
  applyNavigationSnapshot(target);
}

function syncNavigationAddress() {
  const router = window.FestivalRouter;
  if (!navigationReady || !router?.isWeb(location)) return;
  if (!state.user && state.route !== "login") {
    pendingNavigation = navigationSnapshot();
    state.route = "login";
  }
  if (router.href(navigationSnapshot(), location.href, pendingNavigation) !== location.href) writeNavigationHistory("replace");
}

function initializeNavigation() {
  const current = history.state;
  const router = window.FestivalRouter;
  if (current?.key === HISTORY_KEY) navigationIndex = Number(current.index) || 0;
  if (router?.isWeb(location)) {
    const url = new URL(location.href);
    const target = router.parse(url.pathname) || { route: "home" };
    pendingNavigation = target.route === "login" ? router.safeReturn(url.searchParams.get("next")) : target;
    if (target.route !== "login" && current?.key === HISTORY_KEY && current.route === target.route
      && (!target.selectedBoothId || current.selectedBoothId === target.selectedBoothId)) {
      pendingNavigation = { ...current, ...target };
    }
    if (url.searchParams.has("code")) {
      try { pendingNavigation = router.takeRemembered(sessionStorage) || pendingNavigation; } catch { /* Use the URL target. */ }
    }
  }
  navigationReady = true;
  writeNavigationHistory("replace");
  window.addEventListener("popstate", (event) => {
    dismissNfcFeedback();
    const urlTarget = router?.isWeb(location) ? router.parse(location.pathname) : null;
    const saved = event.state?.key === HISTORY_KEY ? event.state : null;
    const snapshot = urlTarget ? { ...(saved || {}), ...urlTarget } : saved;
    if (!snapshot) return;
    navigationIndex = Number(saved?.index) || 0;
    if (snapshot.route === "login" && state.user) snapshot.route = "home";
    if (snapshot.route === "login" && router) pendingNavigation = router.safeReturn(new URL(location.href).searchParams.get("next"));
    applyNavigationSnapshot(snapshot);
    closeMenus();
    writeNavigationHistory("replace");
    render();
    loadNavigationContent();
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

// Demo progress lives in session storage so closing the app clears it. Booth setup stays in
// local storage. A real Google account keeps its visits on the server instead.
function readSessionStorage(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSessionStorage(key, value) {
  try {
    sessionStorage.setItem(key, value);
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

function isAdminUser() {
  return state.user?.role === "admin";
}

function canUseMockNfcTools() {
  return STAMP_GATEWAY_MODE === "mock" && isAdminUser();
}

// The DB booth enum value for a local booth, or null for local-only facility rows.
function boothKeyFor(booth) {
  if (booth?.opsKey) return booth.opsKey;
  if (!booth?.officialClubId) return null;
  return window.FestivalCatalog.CLUB_IDS[booth.officialClubId] || null;
}

function boothForKey(key) {
  return key ? state.db.booths.find(booth => boothKeyFor(booth) === key) || null : null;
}

function reviewEligibility(boothId) {
  const denied = reason => ({ allowed: false, reason, authorName: null });
  if (!state.user) return denied("AUTH_REQUIRED");
  if (isServerMode()) {
    const response = serverReviewState(boothId);
    return response?.status === "ready" && window.FestivalAccount
      ? window.FestivalAccount.validateReviewPolicy(response.reviewPolicy) : denied("REVIEW_POLICY_REQUIRED");
  }
  // Synthetic preview roster only. Production always uses the server's decision.
  const identity = state.db.reviewIdentities?.find(row => row.userId === state.user.id && row.verified === true);
  if (!identity || !identity.realName?.trim() || !Array.isArray(identity.boothIds)) return denied("REVIEW_IDENTITY_REQUIRED");
  if (identity.boothIds.includes(boothId)) return denied("OWN_CLUB_REVIEW");
  return { allowed: true, reason: null, authorName: identity.realName };
}

// Own-club booths are known from the confirmed identity before any per-booth review request,
// so the rating form never appears for them, even after a stamp.
function isOwnClubBooth(boothId) {
  if (reviewEligibility(boothId).reason === "OWN_CLUB_REVIEW") return true;
  if (!isServerMode()) return false;
  const identity = festivalOpsUI.identity?.();
  const key = boothKeyFor(state.db.booths.find(booth => booth.id === boothId));
  return Boolean(identity?.verified && key && identity.boothKeys.includes(key));
}

function reviewEligibilityMessage(policy) {
  return ({ OWN_CLUB_REVIEW: "본인 동아리에는 별점과 후기를 남길 수 없어요.",
    REVIEW_IDENTITY_REQUIRED: "홈에서 본인 소속을 먼저 확인해 주세요.",
    AUTH_REQUIRED: "로그인 후 작성할 수 있어요." })[policy.reason] || "리뷰 작성 가능 여부를 확인 중이에요.";
}

function serverReviewState(boothId) {
  const key = boothKeyFor(state.db.booths.find(booth => booth.id === boothId));
  return key ? serverReviews.get(key) || null : null;
}

function isAdminOnlyNfcSource(source) {
  return ADMIN_ONLY_NFC_SOURCES.has(String(source || ""));
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

// NTAG 424 DNA secure cards write a one-time link (picc_data, cmac). The link is removed from the
// address bar like a signed tag, and the last read is kept for this tab so an operator can register
// a new card from 관리 마법사.
function readInitialSunClaim() {
  const read = window.FestivalSun?.parse(window.location.href);
  if (!read) return null;
  try {
    history.replaceState(history.state, "", window.FestivalSun.strip(window.location.href));
  } catch {
    // Local file previews can restrict History API writes.
  }
  const token = window.FestivalSun.toToken(read);
  try { sessionStorage.setItem(SUN_LAST_READ_KEY, token); } catch { /* Optional for registration only. */ }
  return createNfcClaim(token, "sun-url");
}

state.pendingNfcClaim = readInitialNfcClaim() || readInitialSunClaim();

// Public club profiles imported from Chatdong. Classroom assignments are temporary
// until the festival operator provides the final placement sheet.
const OFFICIAL_CLUBS = [
  {
    id: "709a90e2-b234-46f9-9675-0ebe14f856b6",
    name: "글빛누리",
    aliases: ["독서", "인문학"],
    description: "인문학으로 인간과 사회를 깊이 이해하는 것을 목표로 하는 독서 동아리입니다. 문학, 역사, 철학, 사회과학을 탐구하며 폭넓은 지식과 관심을 쌓습니다.",
    image: "./assets/clubs/709a90e2-b234-46f9-9675-0ebe14f856b6.webp",
    imageKind: "poster",
  },
  {
    id: "97717b20-8448-4a30-8379-c7a7029541eb",
    name: "메커니즘",
    aliases: ["공학", "프로젝트"],
    description: "관심 분야별로 팀을 구성해 공학 프로젝트를 진행하는 동아리입니다. 활동을 자율적으로 기획하고 심도 있게 탐구하며 문제 해결 능력과 공학적 사고력을 기릅니다.",
    image: null,
    imageKind: "initial",
  },
  {
    id: "edc2df72-fae6-4016-b42f-a67ff85c29c6",
    name: "인사이트(인문사회동아리)",
    aliases: ["인사이트", "INSIGHT", "인문사회"],
    description: "인간 삶의 본질을 탐구하는 인문학적 소양과 사회 현상을 분석하는 사회과학적 시각을 기르는 동아리입니다. 모둠 탐구, 아카이브 제작, 지역사회 문제 해결 프로젝트와 개인 자유 탐구를 진행합니다.",
    image: "./assets/clubs/edc2df72-fae6-4016-b42f-a67ff85c29c6.webp",
    imageKind: "logo",
  },
  {
    id: "7f339a02-ea01-419e-ae56-6b03722092c2",
    name: "패러다임(사회문제탐구동아리)",
    aliases: ["패러다임", "사회문제탐구"],
    description: "우리나라의 다양한 사회 문제를 탐구하고, 문제의 원인과 해결 방법을 부원들과 토론하는 동아리입니다.",
    image: "./assets/clubs/7f339a02-ea01-419e-ae56-6b03722092c2.webp",
    imageKind: "poster",
  },
  {
    id: "8e992f2a-3f62-4e35-a533-9a7a511de3c1",
    name: "Re:chem(리켐)",
    aliases: ["리켐", "Rechem", "화학"],
    description: "일상 속 다양한 현상을 화학의 원리로 탐구하는 학문 공동체입니다. 실험과 토론을 통해 원리를 이해하고 화학적 사고력과 탐구 능력을 기릅니다.",
    image: "./assets/clubs/8e992f2a-3f62-4e35-a533-9a7a511de3c1.webp",
    imageKind: "poster",
  },
  {
    id: "bd986569-f15e-4202-9eb7-a37006639c2a",
    name: "invelix-인벨릭스",
    aliases: ["invelix", "인벨릭스", "코딩", "개발"],
    description: "판교고 운영의 기반이 되는 여러 웹 서비스를 개발하고 운영하며 교내 서버를 관리하는 대표 코딩 동아리입니다. 찾동 개발에도 참여했습니다.",
    image: "./assets/clubs/bd986569-f15e-4202-9eb7-a37006639c2a.webp",
    imageKind: "logo",
  },
  {
    id: "22031dff-ac7a-4653-92de-05efa5ba1660",
    name: "건축학부",
    aliases: ["건축", "실내건축", "디자인"],
    description: "건축과 실내 건축 디자인에 관심 있는 학생들이 스케치, 우드락 건축물 제작, 건축 주제 발표 등의 활동을 하는 동아리입니다.",
    image: "./assets/clubs/22031dff-ac7a-4653-92de-05efa5ba1660.webp",
    imageKind: "poster",
  },
  {
    id: "ef2c47d3-47ec-4a27-a96b-740a5d5281c7",
    name: "머큐리",
    aliases: ["과학", "실험", "의생명"],
    description: "물리·화학·생명·지구과학 분야별 그룹을 구성해 관심 분야의 실험을 직접 기획하고 수행하는 과학 동아리입니다. 대학 전문가와 연계한 심화 탐구 프로그램도 진행합니다.",
    image: "./assets/clubs/ef2c47d3-47ec-4a27-a96b-740a5d5281c7.webp",
    imageKind: "logo",
  },
  {
    id: "f058e380-c7e3-4739-8780-6d7f8960cdc6",
    name: "neon (네온 밴드동아리)",
    aliases: ["neon", "네온", "밴드", "음악"],
    description: "수요음악회와 축제를 중심으로 공연하며 교외 공연에도 참여하는 판교고 밴드 동아리입니다. 꾸준한 합주와 공연 준비를 함께합니다.",
    image: "./assets/clubs/f058e380-c7e3-4739-8780-6d7f8960cdc6.webp",
    imageKind: "poster",
  },
  {
    id: "6cc4bd63-7652-4068-bca3-1a7e0c5b25b8",
    name: "티치스트",
    aliases: ["교육", "교사", "모의수업"],
    description: "수업 설계, 모의수업, 교육 이슈 탐구를 진행하며 교육 분야 진로를 희망하는 학생들이 전문성을 키우는 교육 동아리입니다.",
    image: "./assets/clubs/6cc4bd63-7652-4068-bca3-1a7e0c5b25b8.webp",
    imageKind: "logo",
  },
  {
    id: "3bda73fa-9f6a-4cd9-8b1b-a274dabe600f",
    name: "케미스트",
    aliases: ["화학", "실험", "탐구"],
    description: "화학 실험과 탐구 활동을 중심으로 과학적 사고력과 문제 해결 능력을 기르는 동아리입니다.",
    image: "./assets/clubs/3bda73fa-9f6a-4cd9-8b1b-a274dabe600f.webp",
    imageKind: "poster",
  },
  {
    id: "238d8ed9-94b6-47ee-aa13-bc43ef56de9b",
    name: "아트 캔버스",
    aliases: ["아트캔버스", "미술", "그림", "디자인"],
    description: "그림과 디자인에 관심 있는 학생들이 드로잉, 채색, 디자인 작업 등 다양한 창작 활동을 하며 서로의 작품을 공유하고 성장하는 미술 동아리입니다.",
    image: "./assets/clubs/238d8ed9-94b6-47ee-aa13-bc43ef56de9b.webp",
    imageKind: "poster",
  },
  {
    id: "5add1187-1512-4ca2-9ac4-b5fbf61f9d3c",
    name: "창업특허연구소",
    aliases: ["창업", "특허", "지식재산", "IP"],
    description: "현직 변리사의 멘토링을 통해 아이디어를 특허와 창업으로 발전시키는 지식재산 탐구 동아리입니다. 선행기술 조사, 특허 명세서 작성, 비즈니스 모델 설계와 시제품 제작을 경험합니다.",
    image: "./assets/clubs/5add1187-1512-4ca2-9ac4-b5fbf61f9d3c.webp",
    imageKind: "logo",
  },
  {
    id: "43e29cde-458b-45cb-bab5-2d773a87ef98",
    name: "모멘트 (문화콘텐츠 탐구 동아리)",
    aliases: ["모멘트", "문화콘텐츠", "콘텐츠", "미디어"],
    description: "케이팝, 영화, 음식 등 문화콘텐츠의 산업 구조와 시장 전략을 탐구합니다. 트렌드와 데이터를 바탕으로 보고서를 작성하고 콘텐츠 기획·제작·홍보 전략을 설계합니다.",
    image: "./assets/clubs/43e29cde-458b-45cb-bab5-2d773a87ef98.webp",
    imageKind: "logo",
  },
  {
    id: "060d9426-5617-47b7-afd6-c06d8f16c4e2",
    name: "배구사랑",
    aliases: ["배구", "스포츠", "운동"],
    description: "배구 강습으로 기본기를 익히고 자체 경기와 다른 학교와의 연습 경기, 성남시 배구 대회에 참여하며 팀워크와 도전 정신을 기르는 동아리입니다.",
    image: "./assets/clubs/060d9426-5617-47b7-afd6-c06d8f16c4e2.webp",
    imageKind: "logo",
  },
  {
    id: "fb4bff77-acc9-4335-91bb-ce4a5b5ac441",
    name: "월드 스코프(세계사회문화탐구반)",
    aliases: ["월드스코프", "세계사회문화", "문화"],
    description: "세계 각국의 문화를 역사·정치·사회적 배경과 연계해 조사하고 한국 사회와 비교해 발표와 토론을 진행합니다. 설문과 문화 체험을 바탕으로 비교 분석 보고서를 작성합니다.",
    image: "./assets/clubs/fb4bff77-acc9-4335-91bb-ce4a5b5ac441.webp",
    imageKind: "poster",
  },
  {
    id: "9b11a808-3916-4791-b2f6-eda7a1d8ba64",
    name: "방송부",
    aliases: ["방송", "미디어", "행사"],
    description: "교내 방송을 관리하고 학교 행사와 축제 진행을 담당하는 동아리입니다. 방송 기술과 현장 운영을 경험하며 협업 능력과 책임감을 기릅니다.",
    image: "./assets/clubs/9b11a808-3916-4791-b2f6-eda7a1d8ba64.webp",
    imageKind: "poster",
  },
  {
    id: "2908ebef-b57c-4ec2-94ec-bea7c9b6fad2",
    name: "심장박동 (심리동아리)",
    aliases: ["심장박동", "심리", "심리학"],
    description: "심리학을 여러 진로와 연계해 탐구하고, 심리 주제를 확장한 프로젝트와 봉사활동을 진행하는 동아리입니다.",
    image: "./assets/clubs/2908ebef-b57c-4ec2-94ec-bea7c9b6fad2.webp",
    imageKind: "poster",
  },
  {
    id: "b61ab2bb-2d0d-47d3-8c87-2b36baf28ffc",
    name: "레브 (경영,경제 동아리)",
    aliases: ["레브", "REVE", "경영", "경제"],
    description: "경제와 경영에 관심 있는 학생들이 주식 투자 분석, 마케팅 전략, 주제별 심화 발표, 국제 경제·사회 이슈 분석을 진행하는 동아리입니다.",
    image: "./assets/clubs/b61ab2bb-2d0d-47d3-8c87-2b36baf28ffc.webp",
    imageKind: "poster",
  },
  {
    id: "077557c9-0d54-41dd-a4ed-2bd9d9bce364",
    name: "다이나믹스",
    aliases: ["공학", "프로젝트", "로봇", "소프트웨어"],
    description: "구성원이 직접 공학 프로젝트를 기획·설계·실행하는 자율 중심 동아리입니다. 환경, 에너지, 로봇, 소프트웨어, 제품 설계 등 다양한 주제를 팀 또는 개인 단위로 탐구합니다.",
    image: "./assets/clubs/077557c9-0d54-41dd-a4ed-2bd9d9bce364.webp",
    imageKind: "logo",
  },
].map((club) => ({
  ...club,
  sourceUrl: `https://chatdong.xyz/clubs/${club.id}`,
}));

function makeClassBooths(grade, floor) {
  return classPositions.map(([x, y], index) => {
    const klass = index + 1;
    const club = OFFICIAL_CLUBS[((grade - 1) * classPositions.length) + index] || null;
    return {
      id: `g${grade}-${klass}`,
      eventId: EVENT.id,
      clubName: club?.name || `${grade}학년 ${klass}반`,
      name: club?.name || `${grade}학년 ${klass}반 배정 예정`,
      floor,
      room: `${grade}-${klass}`,
      location: `${floor}층 ${grade}-${klass} 교실`,
      description: club?.description || "동아리 배정이 확정되는 대로 업데이트할 예정입니다.",
      status: index === 7 ? "paused" : "open",
      opensAt: EVENT.startsAt,
      closesAt: EVENT.endsAt,
      nfcTagId: `NFC-G${grade}-${String(klass).padStart(2, "0")}`,
      x,
      y,
      favorite: index === 0,
      category: "class",
      officialClubId: club?.id || null,
      aliases: club?.aliases || [],
      image: club?.image || null,
      imageKind: club?.imageKind || "initial",
      sourceUrl: club?.sourceUrl || null,
      assignmentStatus: club ? "provisional" : "unassigned",
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
  clubCatalogVersion: CLUB_CATALOG_VERSION,
  stamps: [],
  idempotencyRecords: [],
  reviews: [],
};

state.db = loadDb();

function readSessionProgress() {
  try {
    const saved = JSON.parse(readSessionStorage(SESSION_KEY) || "null");
    if (!saved || typeof saved !== "object") return null;
    return Object.fromEntries(SESSION_FIELDS
      .filter(field => Array.isArray(saved[field]))
      .map(field => [field, saved[field]]));
  } catch {
    return null;
  }
}

function persistDb(db) {
  // Booth setup, event and notices persist; the visitor's own progress does not.
  const durable = Object.fromEntries(Object.entries(db).filter(([field]) => !SESSION_FIELDS.includes(field)));
  const stored = writeStorage(DB_KEY, JSON.stringify(durable));
  writeSessionStorage(SESSION_KEY, JSON.stringify(Object.fromEntries(SESSION_FIELDS.map(field => [field, db[field] || []]))));
  return stored;
}

function loadDb() {
  const saved = readStorage(DB_KEY);
  if (!saved) {
    const fresh = structuredClone(seed);
    persistDb(fresh);
    return fresh;
  }
  let db;
  try {
    db = JSON.parse(saved);
  } catch {
    const fresh = structuredClone(seed);
    persistDb(fresh);
    return fresh;
  }
  // Progress written by an older build sat in local storage; a new app run starts empty.
  const progress = readSessionProgress();
  SESSION_FIELDS.forEach(field => { db[field] = progress?.[field] || []; });
  const legacyFacilityUpdates = {
    b3: { legacyName: "교무실", name: "행정실", location: "1층 행정실", description: "축제 운영 문의와 긴급 연락을 처리하는 관리 공간입니다." },
    b4: { legacyName: "방송실", name: "시청각실", location: "1층 시청각실", description: "축제 영상과 안내 프로그램을 운영할 수 있는 공간입니다." },
    b5: { legacyName: "매점", name: "상담실", location: "1층 상담실", description: "조용한 안내와 상담이 필요한 경우 이용하는 공간입니다." },
  };
  const shouldImportClubCatalog = Number(db.clubCatalogVersion || 0) < CLUB_CATALOG_VERSION;
  let didMigrateBoothStatus = false;
  db.event = { ...seed.event, ...(db.event || {}) };
  db.announcements = Array.isArray(db.announcements) ? db.announcements : structuredClone(seed.announcements);
  db.booths = (Array.isArray(db.booths) ? db.booths : structuredClone(seed.booths)).map((booth) => {
    const update = legacyFacilityUpdates[booth.id];
    let migrated = update && booth.name === update.legacyName
      ? { ...booth, name: update.name, location: update.location, description: update.description }
      : booth;
    if (shouldImportClubCatalog && booth.category === "class") {
      const catalogBooth = seed.booths.find((item) => item.id === booth.id);
      if (catalogBooth) {
        migrated = {
          ...migrated,
          clubName: catalogBooth.clubName,
          name: catalogBooth.name,
          description: catalogBooth.description,
          officialClubId: catalogBooth.officialClubId,
          aliases: catalogBooth.aliases,
          image: catalogBooth.image,
          imageKind: catalogBooth.imageKind,
          sourceUrl: catalogBooth.sourceUrl,
          assignmentStatus: catalogBooth.assignmentStatus,
        };
      }
    }
    // Retire the old device-only status without losing booth settings or visits.
    if (migrated.status === "crowded") {
      migrated = { ...migrated, status: "open" };
      didMigrateBoothStatus = true;
    }
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
  db.clubCatalogVersion = CLUB_CATALOG_VERSION;
  if (shouldImportClubCatalog || didMigrateBoothStatus) persistDb(db);
  return db;
}

function saveDb() {
  persistDb(state.db);
}

const repo = {
  avgRating(boothId) {
    if (isServerMode()) return serverReviewState(boothId)?.average || 0;
    const list = state.db.reviews.filter((review) => review.boothId === boothId);
    if (!list.length) return 0;
    return list.reduce((sum, review) => sum + Number(review.rating), 0) / list.length;
  },
  reviewsForBooth(boothId) {
    if (isServerMode()) {
      return (serverReviewState(boothId)?.reviews || []).map((review, index) => ({
        id: `server-${boothId}-${index}`, boothId, rating: review.rating,
        content: review.content || "", createdAt: review.createdAt,
        author: review.author, mine: review.mine,
      }));
    }
    return state.db.reviews
      .filter((review) => review.boothId === boothId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  },
  hasStamp(userId, boothId) {
    if (isServerMode()) return this.stampsForUser(userId).some(stamp => stamp.boothId === boothId);
    return state.db.stamps.some((stamp) => stamp.userId === userId && stamp.boothId === boothId && stamp.status !== "revoked");
  },
  hasReview(userId, boothId) {
    if (isServerMode()) {
      if (userId !== state.user?.id) return false;
      const key = boothKeyFor(state.db.booths.find(booth => booth.id === boothId));
      // A null cache means "not loaded yet"; never claim an unrated booth is already rated.
      if (key && serverMyReviews) return serverMyReviews.has(key);
      return serverReviewState(boothId)?.myRating != null;
    }
    return state.db.reviews.some((review) => review.userId === userId && review.boothId === boothId);
  },
  reviewCount(boothId) {
    if (isServerMode()) return serverReviewState(boothId)?.count ?? null;
    return state.db.reviews.filter((review) => review.boothId === boothId).length;
  },
  boothVisits(boothId) {
    if (isServerMode()) return 0;
    return state.db.stamps.filter((stamp) => stamp.boothId === boothId && stamp.status !== "revoked").length;
  },
  stampsForUser(userId) {
    if (isServerMode() && festivalOpsUI.snapshot()?.ready) return userId === state.user?.id
      ? festivalOpsUI.snapshot().visits.map(v => ({ boothId: boothForKey(v.booth_key)?.id, userId, status: "active", method: v.method, createdAt: v.created_at })).filter(v => v.boothId) : [];
    if (isServerMode()) return userId === state.user?.id ? state.db.booths
      .filter(booth => serverCompletedBooths.includes(boothKeyFor(booth)))
      .map(booth => ({ boothId: booth.id, userId, status: "active", method: "nfc", createdAt: null })) : [];
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
    if (!userId) return nfcFailure("AUTH_REQUIRED", "로그인이 필요해요.", { status: 401, requestId });
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(String(idempotencyKey || ""))) {
      return nfcFailure("INVALID_IDEMPOTENCY_KEY", "요청 정보가 올바르지 않아요.", { status: 400, requestId });
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
        return nfcFailure("IDEMPOTENCY_KEY_REUSED", "같은 요청을 다른 태그에 다시 쓸 수 없어요.", { status: 409, requestId });
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
      return finish(nfcFailure("EVENT_NOT_FOUND", "현재 축제와 맞지 않는 요청이에요.", { status: 404, requestId }));
    }
    if (typeof nfcToken !== "string" || !nfcToken || nfcToken.length > 512) {
      return finish(nfcFailure("NFC_TAG_INVALID", "등록되지 않았거나 잘못된 NFC 태그예요.", { requestId }));
    }

    const tagId = tagIdFromMockNfcToken(nfcToken);
    const booth = tagId
      ? state.db.booths.find((item) => item.eventId === eventId && item.nfcTagId === tagId)
      : null;
    if (!booth) {
      return finish(nfcFailure("NFC_TAG_INVALID", "등록되지 않았거나 잘못된 NFC 태그예요.", { requestId }));
    }
    if (booth.nfcEnabled === false) {
      return finish(nfcFailure("NFC_TAG_DISABLED", "이 부스의 NFC 적립이 중지돼 있어요.", { boothId: booth.id, requestId }));
    }
    if (state.db.event.emergencyMode) {
      return finish(nfcFailure("EMERGENCY_MODE", "비상 모드에서는 NFC 적립이 잠시 중지돼요.", { status: 503, boothId: booth.id, requestId }));
    }
    if (!["active", "rehearsal"].includes(state.db.event.status)) {
      return finish(nfcFailure("EVENT_NOT_ACTIVE", "현재 행사가 방문 적립 가능한 상태가 아닙니다.", { boothId: booth.id, requestId }));
    }
    if (booth.status !== "open") {
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

const stampGateway = isServerMode() ? {
  async claimNfc({ nfcToken }) {
    if (!festivalAccount) return nfcFailure("AUTH_REQUIRED", "로그인이 필요해요.");
    const actingUser = state.user?.id;
    const result = await festivalAccount.claim(nfcToken);
    if (!result.ok) return result;
    if (state.user?.id !== actingUser) return nfcFailure("AUTH_REQUIRED", "계정이 변경되었어요. 다시 확인해 주세요.");
    festivalOpsUI.markVisitPending();
    await festivalOpsUI.refresh(false);
    if (state.user?.id !== actingUser) return nfcFailure("AUTH_REQUIRED", "계정이 변경되었어요. 다시 확인해 주세요.");
    serverCompletedBooths = result.completedBooths;
    const booth = boothForKey(result.boothKey);
    return { ...result, boothId: booth?.id || null, earnedAt: null, syncPending: festivalOpsUI.visitSyncPending() };
  },
} : mockStampGateway;

const NFC_ERROR_TITLES = {
  NFC_TAG_INVALID: "등록되지 않은 태그예요",
  NFC_TAG_DISABLED: "사용 중지된 태그예요",
  NFC_TAG_EXPIRED: "사용 기간이 지난 태그예요",
  BOOTH_NOT_OPEN: "지금은 적립할 수 없어요",
  BOOTH_CLOSED: "부스가 운영 중이 아니에요",
  EVENT_NOT_ACTIVE: "행사가 운영 중이 아니에요",
  EVENT_CLOSED: "축제가 운영 중이 아니에요",
  OPS_NOT_READY: "축제 운영 정보를 확인할 수 없어요",
  NFC_DISABLED: "방문 인증이 잠시 중지됐어요",
  OWN_CLUB_STAMP: "본인 동아리 부스예요",
  EMERGENCY_MODE: "방문 적립이 잠시 중지됐어요",
  IDEMPOTENCY_KEY_REUSED: "요청을 다시 확인해 주세요",
  NETWORK_ERROR: "네트워크 연결이 불안정해요",
  SUN_DISABLED: "보안 카드 적립이 잠시 중지됐어요",
  SUN_CARD_INVALID: "확인되지 않은 카드예요",
  SUN_CARD_UNKNOWN: "등록되지 않은 보안 카드예요",
  SUN_CARD_STOPPED: "사용 중지된 보안 카드예요",
  SUN_CARD_REPLAYED: "이미 사용한 카드 주소예요",
};

let nfcQueue = Promise.resolve();
const nfcAdapter = {
  scan(claim) {
    const next = nfcQueue.then(() => this.process(claim));
    nfcQueue = next.catch(() => {});
    return next;
  },
  async process(claim) {
    state.nfcTestMessage = "";
    const request = {
      nfcToken: String(claim?.nfcToken || ""),
      idempotencyKey: claim?.idempotencyKey || makeId(),
      source: claim?.source || "ui",
    };
    if (isAdminOnlyNfcSource(request.source) && !isAdminUser()) {
      const denied = nfcFailure("ADMIN_REQUIRED", "모의 방문 인증은 관리자만 사용할 수 있어요.", { status: 403 });
      state.pendingNfcClaim = null;
      if (state.user) {
        state.scanResult = {
          type: "blocked",
          title: "관리자 전용 기능이에요",
          body: denied.message,
        };
        showNfcFeedback();
      } else {
        state.loginError = "모의 방문 인증은 관리자 계정으로 로그인해야 사용할 수 있어요.";
        state.route = "login";
      }
      render();
      return denied;
    }
    if (!request.nfcToken) {
      state.scanResult = { type: "error", title: "태그 정보를 읽지 못했어요", body: "다시 인식하거나 운영자에게 수동 승인을 요청하세요." };
      if (state.user) showNfcFeedback();
      else { state.route = "login"; render(); }
      return nfcFailure("NFC_TAG_INVALID", "태그 정보가 비어 있어요.");
    }
    if (!state.user) {
      state.pendingNfcClaim = request;
      if (isServerMode()) festivalAccount?.savePending(request);
      state.route = "login";
      state.loginError = "NFC 태그가 인식됐어요. 로그인하면 같은 요청 식별자로 자동 적립을 이어갑니다.";
      render();
      return { ok: false, queued: true };
    }

    const actingUser = state.user.id;
    const result = await stampGateway.claimNfc({
      eventId: state.db.event.id,
      userId: state.user.id,
      nfcToken: request.nfcToken,
      idempotencyKey: request.idempotencyKey,
    });
    if (state.user?.id !== actingUser) return result;
    const booth = result.boothId ? state.db.booths.find((item) => item.id === result.boothId) : null;

    if (["AUTH_REQUIRED", "GOOGLE_AUTH_REQUIRED", "PROFILE_REQUIRED"].includes(result.code)) {
      state.pendingNfcClaim = request;
      if (isServerMode()) festivalAccount?.savePending(request);
      state.user = null;
      state.route = "login";
      state.loginError = "로그인이 만료됐어요. 다시 로그인하면 방문 인증을 이어갑니다.";
      render();
      return result;
    }

    if (result.ok) {
      state.pendingNfcClaim = null;
      const duplicate = result.result === "ALREADY_EARNED";
      state.scanResult = {
        type: duplicate ? "duplicate" : "success",
        boothId: result.boothId,
        syncPending: Boolean(result.syncPending),
        title: duplicate ? "이미 적립한 부스예요" : "스탬프 1개 적립 완료",
        body: result.syncPending ? "방문 기록은 저장됐어요. 스탬프 수를 갱신하지 못해 다시 불러와야 해요." : duplicate
          ? "기존 방문 기록을 그대로 유지했어요."
          : result.replayed
            ? "같은 요청의 기존 성공 결과를 다시 불러왔어요."
            : "방문을 인증하고 스탬프 1개를 적립했어요.",
      };
    } else {
      state.pendingNfcClaim = result.retryable ? request : null;
      const blocked = ["BOOTH_NOT_OPEN", "BOOTH_CLOSED", "EVENT_NOT_ACTIVE", "EVENT_CLOSED", "OPS_NOT_READY", "NFC_DISABLED", "SUN_DISABLED", "EMERGENCY_MODE"].includes(result.code);
      state.scanResult = {
        type: blocked ? "blocked" : "error",
        boothId: result.boothId,
        title: NFC_ERROR_TITLES[result.code] || "방문 인증을 처리하지 못했어요",
        body: result.message,
        retryable: Boolean(result.retryable),
      };
    }
    if (isServerMode()) festivalAccount?.savePending(state.pendingNfcClaim);
    const editing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
    if (["home", "scan", "stamps", "detail", "reviews"].includes(state.route) && !editing && !state.searchOpen) {
      const scrollY = window.scrollY;
      render();
      window.scrollTo(0, scrollY);
    }
    refreshVisitIndicators();
    showNfcFeedback();
    return result;
  },
};

function dismissNfcFeedback() {
  const node = document.querySelector("#nfcFeedback");
  const previous = node?.returnFocus;
  if (node?.open) node.close();
  node?.remove();
  if (previous?.element?.isConnected) {
    previous.element.focus({ preventScroll: true });
    if (Number.isInteger(previous.start)) previous.element.setSelectionRange(previous.start, previous.end, previous.direction);
  }
}

function showNfcFeedback() {
  dismissNfcFeedback();
  const result = state.scanResult;
  if (!result || !state.user) return;
  const booth = state.db.booths.find(item => item.id === result.boothId);
  const canReview = !result.syncPending && booth && ["success", "duplicate"].includes(result.type) && !repo.hasReview(state.user.id, booth.id) && reviewEligibility(booth.id).allowed;
  const completed = ["success", "duplicate"].includes(result.type);
  const node = document.createElement(completed ? "dialog" : "aside");
  node.id = "nfcFeedback";
  node.className = `nfc-feedback ${result.type}${completed ? " is-complete" : ""}`;
  node.innerHTML = completed ? `
    <span class="nfc-complete-icon" aria-hidden="true">${icon("check")}</span>
    <h2 id="nfcFeedbackTitle">${escapeHtml(result.title)}</h2>
    ${booth ? `<p class="nfc-complete-booth">${escapeHtml(booth.name)}</p>` : ""}
    <p id="nfcFeedbackDescription">${escapeHtml(result.body)}</p>
    <div class="nfc-complete-actions">
      ${result.syncPending ? `<button type="button" class="primary-btn" data-visit-sync-retry autofocus>기록 다시 불러오기 ${icon("refresh")}</button>` : ""}
      ${canReview ? `<button type="button" class="primary-btn feedback-action" autofocus>별점 남기기 ${icon("arrow")}</button>` : ""}
      <button type="button" class="${canReview || result.syncPending ? "secondary-btn" : "primary-btn"} feedback-close" ${canReview || result.syncPending ? "" : "autofocus"}>${canReview ? "나중에" : "확인"}</button>
    </div>` : `<div class="nfc-feedback-content" role="status" aria-live="polite"><span class="nfc-feedback-icon">${icon("notice")}</span><div><strong>${escapeHtml(result.title)}</strong><p>${booth ? `${escapeHtml(booth.name)} · ` : ""}${escapeHtml(result.body)}</p></div></div>
    <button type="button" class="icon-btn feedback-close" aria-label="인증 알림 닫기">${icon("close")}</button>
    ${result.retryable ? `<button type="button" class="feedback-action">다시 시도 ${icon("refresh")}</button>` : ""}`;
  node.querySelector(".feedback-close").onclick = dismissNfcFeedback;
  node.querySelector('[data-visit-sync-retry]')?.addEventListener('click', retryVisitSync);
  node.querySelector(".feedback-action")?.addEventListener("click", () => {
    dismissNfcFeedback();
    if (canReview) openBoothReview(booth.id);
    else if (state.pendingNfcClaim) runActionOnce("nfc-claim", () => nfcAdapter.scan(state.pendingNfcClaim));
  });
  document.body.append(node);
  if (completed) {
    const element = document.activeElement;
    node.returnFocus = { element, start: element?.selectionStart, end: element?.selectionEnd, direction: element?.selectionDirection };
    node.setAttribute("aria-labelledby", "nfcFeedbackTitle");
    node.setAttribute("aria-describedby", "nfcFeedbackDescription");
    node.addEventListener("cancel", event => { event.preventDefault(); dismissNfcFeedback(); });
    node.addEventListener("keydown", event => {
      if (event.key !== "Tab") return;
      const buttons = [...node.querySelectorAll("button:not([disabled])")];
      const first = buttons[0], last = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
    node.addEventListener("close", () => node.remove());
    node.showModal();
  }
}

async function retryVisitSync(event) {
  const button=event.currentTarget, actor=state.user?.id, result=state.scanResult;
  if(button.disabled) return;
  button.disabled=true; button.textContent='불러오는 중...';
  await festivalOpsUI.refresh();
  if(state.user?.id!==actor) return;
  if(!festivalOpsUI.visitSyncPending()) {
    if(state.scanResult===result && result?.syncPending) {
      result.syncPending=false; result.body='저장된 방문 기록과 스탬프 수를 확인했어요.';
      if(document.querySelector('#nfcFeedback')) showNfcFeedback();
    }
    refreshVisitIndicators();
  } else if(button.isConnected) {
    button.disabled=false; button.textContent='연결 확인 후 다시 불러오기';
  }
}

function updateVisitSyncNotice() {
  document.querySelector('[data-visit-sync-notice]')?.remove();
  if(!isServerMode() || !state.user || !festivalOpsUI.visitSyncPending()) return;
  const screen=document.querySelector('#app main');
  if(!screen) return;
  const notice=document.createElement('div');
  notice.className='visit-sync-notice'; notice.dataset.visitSyncNotice=''; notice.setAttribute('role','status');
  notice.innerHTML=`<span>방문 저장 완료 · 스탬프 수 갱신 대기</span><button type="button" class="text-link" data-visit-sync-retry>다시 불러오기 ${icon('refresh')}</button>`;
  screen.prepend(notice);
  notice.querySelector('button').onclick=retryVisitSync;
}

function refreshVisitIndicators() {
  updateVisitSyncNotice();
  festivalWeb.refreshIndicators();
  const count = repo.stampsForUser(state.user.id).length;
  document.querySelectorAll("[data-stamp-count]").forEach(node => { node.textContent = count; });
  document.querySelectorAll("[data-map-select]").forEach(node => {
    const visited = repo.hasStamp(state.user.id, node.dataset.mapSelect);
    node.classList.toggle("visited", visited);
    node.classList.toggle("stamped", visited);
  });
  document.querySelectorAll("[data-booth-visited]").forEach(node => {
    const visited = repo.hasStamp(state.user.id, node.dataset.boothVisited);
    node.textContent = visited ? "방문 완료" : "방문 전";
    node.classList.toggle("visit-complete", visited);
    node.closest(".booth-item")?.querySelector(".stamp")?.classList.toggle("on", visited);
  });
  const floorCount = document.querySelector("[data-floor-stamp-count]");
  if (floorCount) floorCount.textContent = visibleBooths().filter(booth => repo.hasStamp(state.user.id, booth.id)).length;
  updatePendingReviewCount();
}

function statusInfo(status) {
  if (isServerMode() && (!festivalOpsUI.snapshot()?.ready || status === 'unregistered')) return { label: "상태 미등록", tone: "muted" };
  return BOOTH_STATUS[status] || BOOTH_STATUS.preparing;
}

function formatTime(value) {
  if (!value) return "시각 미기록";
  return new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Seoul" }).format(new Date(value));
}

function formatOperatingHours(booth) {
  // Booth managers enter the hours (program.hours). Plain text: escape before putting it in HTML.
  if (isServerMode()) return booth.opsRecord?.program?.hours || "운영 시간 미등록";
  return `${formatTime(booth.opensAt)}–${formatTime(booth.closesAt)}`;
}

// One place for a booth on every screen: the manager's location, else the chosen map room, else
// the bundled classroom marked as temporary. Plain text: escape before putting it in HTML.
function boothPlace(booth) {
  if (!isServerMode() || !booth.officialClubId) return { text: booth.location || "", temporary: false };
  if (booth.placed) return { text: booth.opsRecord?.location || `${booth.floor}층 ${booth.mapRoom}`, temporary: false };
  return { text: `${booth.floor}층 ${booth.room || ""}`.trim(), temporary: true };
}
function boothPlaceText(booth) {
  const place = boothPlace(booth);
  return place.temporary ? `${place.text} (임시 배치)` : place.text;
}

function formatReviewDate(value) {
  return new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric" }).format(new Date(value));
}

function ratingInfo(boothId) {
  const reviews = repo.reviewsForBooth(boothId);
  const count = isServerMode() ? (serverReviewState(boothId)?.count ?? 0) : reviews.length;
  const average = repo.avgRating(boothId);
  return {
    reviews,
    count,
    status: isServerMode() ? serverReviewState(boothId)?.status || "idle" : "ready",
    message: isServerMode() ? serverReviewState(boothId)?.message || "" : "",
    average: count && average ? Number(average).toFixed(1) : null,
    distribution: isServerMode() ? serverReviewState(boothId)?.distribution || null
      : Object.fromEntries([1, 2, 3, 4, 5].map(n => [n, reviews.filter(review => Math.round(review.rating) === n).length])),
  };
}

// Server reviews are fetched per booth and patched into the open screen so that a reply never
// replaces a text input, the map, or a scroll position.
async function loadBoothReviews(boothId, { force = false } = {}) {
  if (!isServerMode() || !festivalAccount) return null;
  const actingUser = state.user?.id;
  const booth = state.db.booths.find(item => item.id === boothId);
  const key = boothKeyFor(booth);
  if (!key) return null;
  const cached = serverReviews.get(key);
  if (!force && cached && ["ready", "loading"].includes(cached.status)) return cached;
  const request = { ...(cached || { count: 0, average: null, myRating: null, reviews: [] }), status: "loading" };
  serverReviews.set(key, request);
  updateReviewSection(boothId);
  const response = await festivalAccount.reviews(key);
  if (state.user?.id !== actingUser || serverReviews.get(key) !== request) return null;
  if (!response.ok) {
    serverReviews.set(key, { ...(serverReviews.get(key) || {}), status: "error", message: response.message });
  } else {
    serverReviews.set(key, { ...response, status: "ready" });
    if (serverMyReviews) {
      if (response.myRating != null) serverMyReviews.add(key);
      else serverMyReviews.delete(key);
    }
  }
  updateReviewSection(boothId);
  return serverReviews.get(key);
}

async function loadMyReviews() {
  if (!isServerMode() || !festivalAccount) return;
  const actingUser = state.user?.id;
  const response = await festivalAccount.myReviews();
  if (state.user?.id !== actingUser) return;
  if (!response.ok) return;
  serverMyReviews = new Set(response.boothKeys);
  updatePendingReviewCount();
  if (["home", "stamps"].includes(state.route) && !state.searchOpen) render();
}

function updatePendingReviewCount() {
  const pending = document.querySelector(".home-review-action small");
  if (!pending) return;
  const text = pendingReviewText();
  if (pending.textContent !== text) pending.textContent = text;
}

function pendingReviewText() {
  if (isServerMode() && !serverMyReviews) return "방문한 부스를 확인하는 중이에요";
  const pending = unreviewedBooths().length;
  return pending ? `별점을 기다리는 부스 ${pending}개` : "방문한 부스에 별점을 남겨주세요";
}

function updateReviewSection(boothId) {
  if (state.route === "boothReviews" && state.selectedBoothId === boothId) {
    const body = document.querySelector("#boothReviewsBody");
    if (body) body.innerHTML = boothReviewsBody(boothId);
    return;
  }
  if (state.route !== "detail" || state.selectedBoothId !== boothId) return;
  if (isOwnClubBooth(boothId) !== Boolean(document.querySelector("#boothReviewSection.own-club-review"))) { render(); return; }
  const linkCount = document.querySelector("[data-review-count-link]");
  if (linkCount) linkCount.textContent = reviewCountText(ratingInfo(boothId));
  const info = ratingInfo(boothId);
  const list = document.querySelector("#boothReviewSection .review-list");
  if (list) list.innerHTML = reviewListMarkup(info);
  const average = document.querySelector("[data-review-average]");
  if (average) average.textContent = reviewAverageText(info);
  const count = document.querySelector("[data-review-count]");
  if (count) count.textContent = reviewCountText(info);
  const own = festivalWeb.ownReview(boothId);
  const policy = reviewEligibility(boothId);
  const enabled = policy.allowed && repo.hasStamp(state.user.id, boothId) && !own?.content?.trim();
  const compose = document.querySelector("#boothReviewSection .review-compose");
  if (compose) {
    compose.classList.toggle("locked", !enabled);
    compose.querySelectorAll("[data-rating]").forEach(star => { star.disabled = !enabled || Boolean(own); });
    compose.querySelector("textarea").disabled = !enabled;
    compose.querySelector("#submitReview").disabled = !enabled || state.reviewBusy;
    compose.querySelector("#submitReview").textContent = !policy.allowed ? "리뷰 작성 제한" : !enabled ? "방문 후 작성 가능" : own ? "글 후기 등록" : "별점 등록하고 날인 완료";
    compose.querySelector(".review-guidance").textContent = !policy.allowed ? reviewEligibilityMessage(policy) : enabled ? "별점은 필수, 글 후기는 선택이에요." : "방문 인증 후 작성할 수 있어요.";
    const identity = compose.querySelector(".review-identity");
    identity.textContent = policy.allowed ? `${policy.authorName} 이름으로 공개돼요.` : "";
    identity.hidden = !policy.allowed;
    compose.querySelector(".review-identity-link").hidden = !(isServerMode() && policy.reason === "REVIEW_IDENTITY_REQUIRED");
    compose.querySelector("#saveReviewDraft").hidden = !enabled;
  }
  if (own) {
    state.reviewRating = own.rating;
    document.querySelectorAll("[data-rating]").forEach(star => {
      star.disabled = true;
      star.classList.toggle("on", Number(star.dataset.rating) <= own.rating);
      star.setAttribute("aria-pressed", String(Number(star.dataset.rating) === own.rating));
    });
    const submit = document.querySelector("#submitReview");
    if (submit) {
      submit.disabled = !enabled || state.reviewBusy;
      submit.textContent = !policy.allowed ? "리뷰 작성 제한" : own.content?.trim() ? "이미 등록한 후기예요" : "글 후기 등록";
    }
  }
}

function reviewAverageText(info) {
  if (info.status === "loading") return "불러오는 중";
  if (info.status === "error") return "확인 실패";
  return info.average || "평가 전";
}

function reviewCountText(info) {
  if (info.status === "loading") return "…";
  if (info.status === "error") return "확인 실패";
  return `${info.count}개`;
}

function reviewListMarkup(info) {
  if (info.status === "loading") return `<div class="review-empty"><strong>후기를 불러오는 중이에요</strong></div>`;
  if (info.status === "error") return `<div class="review-empty"><strong>후기를 불러오지 못했어요</strong><p>${escapeHtml(info.message || "연결을 확인하고 다시 시도해 주세요.")}</p></div>`;
  if (!info.reviews.length) return `<div class="review-empty"><strong>아직 등록된 후기가 없어요</strong></div>`;
  return info.reviews.map(reviewView).join("");
}

let publicCatalogStorage = null;
try { publicCatalogStorage = window.localStorage; } catch { /* Storage is optional. */ }
const publicCatalog = window.FestivalCatalog.createClient({ storage: publicCatalogStorage });

function catalogBooth(booth) {
  if (isServerMode() && booth.opsRecord) return { name: booth.opsRecord.name, position: booth.opsRecord.location, rating: serverReviewState(booth.id)?.average || Number(booth.opsRecord.rating) || 0 };
  return publicCatalog.forClub(booth.officialClubId);
}

function catalogName(booth) {
  return `<span data-catalog-name="${booth.id}">${escapeHtml(catalogBooth(booth)?.name || booth.name)}</span>`;
}

function catalogRatingText(booth) {
  if (!booth.officialClubId) return "";
  const remote = catalogBooth(booth);
  if (!remote) return "별점 정보 없음";
  const cached = publicCatalog.getSnapshot().status !== "ready" ? " · 이전 정보" : "";
  return `${remote.rating > 0 ? `${remote.rating.toFixed(1)}점` : "평가 전"}${cached}`;
}

function catalogRating(booth) {
  return `<span data-catalog-rating="${booth.id}">${escapeHtml(catalogRatingText(booth))}</span>`;
}

function catalogPositionText(booth) {
  if (!booth.officialClubId) return "시설";
  const remote = catalogBooth(booth);
  return remote?.position ? `위치: ${remote.position}` : "위치 미확정";
}

// Update only server-data slots; never replace inputs, scroll containers, or map nodes.
function updateCatalogDom() {
  ["name", "rating", "position"].forEach((field) => {
    document.querySelectorAll(`[data-catalog-${field}]`).forEach((node) => {
      const booth = state.db.booths.find((item) => item.id === node.dataset[`catalog${field[0].toUpperCase()}${field.slice(1)}`]);
      if (!booth) return;
      const value = field === "name" ? catalogBooth(booth)?.name || booth.name
        : field === "rating" ? catalogRatingText(booth) : catalogPositionText(booth);
      if (node.textContent !== value) node.textContent = value;
    });
  });
}

function icon(name) {
  if (window.FestivalIcons?.[name]) return window.FestivalIcons[name];
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
    external: "↗",
  };
  return icons[name] || "";
}

let renderInProgress = false;

function render() {
  if (renderInProgress) return;
  syncNavigationAddress();
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
    if (state.route === "home") app.innerHTML = festivalWeb.home();
    if (state.route === "map") app.innerHTML = mapView();
    if (state.route === "scan") app.innerHTML = scanView();
    if (state.route === "detail") app.innerHTML = detailView();
    if (state.route === "stamps") app.innerHTML = festivalWeb.stamps();
    if (state.route === "vouchers") app.innerHTML = isServerMode() ? festivalOpsUI.vouchers() : festivalWeb.vouchers();
    if (state.route === "reviews") app.innerHTML = festivalWeb.reviews();
    if (state.route === "identity") app.innerHTML = festivalOpsUI.identityView();
    if (state.route === "notices") app.innerHTML = festivalNotices.listView();
    if (state.route === "notice") app.innerHTML = festivalNotices.detailView();
    if (state.route === "manage") app.innerHTML = festivalBoothManager.view();
    if (state.route === "boothReviews") app.innerHTML = boothReviewsView();
    if (state.route === "profile") app.innerHTML = profileView();
    if (state.route === "admin") app.innerHTML = adminView();
    if (state.reviewPickerOpen && state.user) app.insertAdjacentHTML("beforeend", reviewPickerView());
    if (app.querySelector("main")) app.querySelector("main").inert = state.reviewPickerOpen;
    app.dataset.previousRoute = previousRoute;
    app.dataset.route = nextRoute;
    bindEvents();
    festivalWeb.afterRender();
    updateCatalogDom();
    updateVisitSyncNotice();
  } finally {
    renderInProgress = false;
  }
}

function loginView() {
  const profileStep = state.authStep === "profile" && state.pendingGoogle;
  return `
    <main class="screen login-screen${profileStep ? " login-profile" : ""}">
      <header class="login-brand"><span class="brand-symbol" aria-hidden="true">P.</span><span>PANGYO FESTIVAL</span></header>
      <div class="login-content">
        <div class="login-intro">
          <h1 class="title">판교고 축제</h1>
          ${profileStep ? "" : `<img class="login-art" src="./assets/festival-school-1.4.webp" width="1536" height="1024" alt="" fetchpriority="high" />`}
        </div>
        <section class="login-panel" aria-label="${profileStep ? "참가자 정보 확인" : "축제 로그인"}">
          ${profileStep ? profileForm() : googleForm()}
        </section>
      </div>
    </main>
  `;
}

function googleForm() {
  return `
    <div class="auth-card">
      ${state.pendingNfcClaim ? `<p class="success-text" role="status">${icon("stamp")}<span>방문 태그를 읽었어요.<br />로그인하면 방문 인증이 이어집니다.</span></p>` : ""}
      ${state.loginError ? `<p class="error-text" role="alert">${escapeHtml(state.loginError)}</p>` : ""}
      <button id="googleLogin" type="button" class="primary-btn google-btn" aria-busy="${Boolean(state.loginBusy)}" ${state.loginBusy ? "disabled" : ""}>
        ${isServerMode() ? `<svg class="google-symbol" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65Z"/><path fill="#FBBC05" d="M10.53 28.59A14.4 14.4 0 0 1 9.75 24c0-1.59.27-3.13.79-4.59l-7.98-6.19A23.9 23.9 0 0 0 0 24c0 3.87.93 7.53 2.56 10.78l7.97-6.19Z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.91-5.8l-7.73-6c-2.15 1.45-4.92 2.3-8.18 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48Z"/></svg>` : `<span class="google-symbol" aria-hidden="true">${icon("user")}</span>`}
        <span>${state.loginBusy ? "확인 중..." : isServerMode() ? "Google 계정으로 계속" : "학생 데모로 계속"}</span>
      </button>
      ${isServerMode() ? "" : `<p class="login-note">체험 기록은 앱을 닫으면 사라집니다.</p>`}
      ${isServerMode() ? "" : `<button id="adminLogin" type="button" class="ghost-btn" ${state.loginBusy ? "disabled" : ""}>관리자 데모로 계속</button>`}
      ${isServerMode() ? "" : `<button id="switchMode" type="button" class="ghost-btn">실제 로그인으로 돌아가기</button>`}
    </div>
  `;
}

function profileForm() {
  const google = state.pendingGoogle;
  const needsName = !isServerMode() || !google.displayName?.trim() || google.displayName.trim().length > 60;
  return `
    <div class="auth-card">
      <h2>${needsName ? "학생 정보 등록" : "학번 확인"}</h2>
      <div class="login-account"><span class="login-account-avatar" aria-hidden="true">${icon("user")}</span><div><strong>${needsName ? "Google 계정" : escapeHtml(google.displayName)}</strong><span>${escapeHtml(google.email)}</span></div></div>
      ${state.loginError ? `<p class="error-text" role="alert">${escapeHtml(state.loginError)}</p>` : ""}
      <div class="input-stack">
        ${needsName ? `${isServerMode() ? `<p class="subtitle">Google 계정에서 사용할 이름을 가져오지 못했어요. 이름을 한 번만 입력해 주세요.</p>` : ""}<label class="field">이름<input id="name" class="input" maxlength="60" autocomplete="name" value="${escapeHtml(google.nameDraft ?? google.displayName ?? "")}" ${state.loginBusy ? "disabled" : ""} /></label>` : ""}
        <label class="field">학번<input id="studentNumber" class="input" placeholder="예: 21001" inputmode="numeric" maxlength="5" value="${escapeHtml(google.studentNumber || "")}" ${state.loginBusy ? "disabled" : ""} /></label>
        ${isServerMode() ? "" : `<label class="field">아이디<input id="schoolId" class="input" placeholder="예: pango-student" /></label>`}
        <button id="profileSubmit" type="button" class="primary-btn" aria-busy="${Boolean(state.loginBusy)}" ${state.loginBusy ? "disabled" : ""}>${state.loginBusy ? "저장 중..." : "등록하고 시작"}</button>
        <button id="backToGoogle" type="button" class="ghost-btn" ${state.loginBusy ? "disabled" : ""}>구글 계정 다시 선택</button>
      </div>
    </div>
  `;
}

function homeView() {
  const stamps = repo.stampsForUser(state.user.id);
  const notice = isServerMode() ? null : state.db.announcements[0];
  return `
    <main class="home-screen home-v2">
      <header class="festival-header">
        <div><span class="eyebrow">PANGYO FESTIVAL</span><h1>오늘, 판교고 축제</h1></div>
        <button type="button" class="icon-btn" data-route="profile" aria-label="내 정보" title="내 정보">${icon("user")}</button>
      </header>
      <section class="home-identity" aria-label="내 축제 현황">
        <div><strong>${escapeHtml(state.user.name)}님</strong><span>${escapeHtml(isServerMode() ? state.user.studentNumber || "축제 참가자" : "체험 계정")}</span></div>
        <button type="button" data-route="stamps">${icon("stamp")}<span>나의 스탬프 <b data-stamp-count>${stamps.length}</b></span>${icon("arrow")}</button>
      </section>
      ${state.db.event.emergencyMode ? emergencyBanner() : ""}
      <section class="home-map" aria-label="학교 부스 지도">
        <div class="section-heading"><h2>어디부터 가볼까?</h2><button type="button" class="icon-btn" id="mapSearchBtn" aria-label="부스 검색" title="부스 검색">${icon("search")}</button></div>
        ${floorTabsView()}
        ${mapCanvasView(visibleBooths(), mapPlanForFloor(state.floor))}
        <div class="home-map-caption"><span>${state.floor}층 · ${floorPlaceNote(state.floor)}</span><button type="button" data-route="map">지도 크게 보기 ${icon("external")}</button></div>
      </section>
      <section class="home-notice" aria-label="공지사항">
        ${icon("notice")}<div><span>공지사항</span><strong>${notice ? escapeHtml(notice.title) : "새로운 공지를 기다리고 있어요"}</strong>${notice ? `<p>${escapeHtml(notice.body)}</p>` : ""}</div>
      </section>
      <button type="button" class="home-review-action" data-open-reviews>
        <span class="review-action-icon">${icon("message")}</span><span><strong>오늘의 부스는 어땠나요?</strong><small>${escapeHtml(pendingReviewText())}</small></span>${icon("arrow")}
      </button>
      ${state.searchOpen ? searchOverlay(searchResults()) : ""}
      ${bottomNav("home")}
    </main>
  `;
}

function unreviewedBooths() {
  return state.db.booths.filter(festivalWeb.reviewPending);
}

function reviewPickerView() {
  const booths = unreviewedBooths();
  return `<div class="review-picker-backdrop" data-close-reviews>
    <section class="review-picker" role="dialog" aria-modal="true" aria-labelledby="reviewPickerTitle">
      <header><div><span class="eyebrow">MY VISITS</span><h2 id="reviewPickerTitle">방문 기록 평가하기</h2></div><button type="button" class="icon-btn" data-close-reviews aria-label="닫기">${icon("close")}</button></header>
      ${isServerMode() && !serverMyReviews ? `<p class="notice">이미 남긴 별점을 확인하는 중이에요. 목록이 곧 정확해집니다.</p>` : ""}
      <div class="review-picker-list">${booths.length ? booths.map(booth => `<button type="button" data-review-booth="${booth.id}"><span><strong>${catalogName(booth)}</strong><small>${escapeHtml(booth.location)}</small></span>${icon("arrow")}</button>`).join("") : `<div class="empty-state">${icon("star")}<h3>${repo.stampsForUser(state.user.id).length ? "모든 별점을 남겼어요" : "아직 방문한 부스가 없어요"}</h3><p>부스를 방문하면 이곳에서 평가할 수 있어요.</p></div>`}</div>
    </section></div>`;
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
      <p>방문 적립이 제한돼요. 현장 운영자의 안내를 따라 주세요.</p>
    </section>
  `;
}

function homeBoothCard(booth) {
  return `
    <button type="button" class="home-booth-card" data-list-select="${booth.id}">
      <span><strong>${catalogName(booth)}</strong><small>${escapeHtml(boothPlaceText(booth))}${booth.officialClubId ? ` · ${catalogRating(booth)}` : ""}</small></span>
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
  const showMockNfcTools = canUseMockNfcTools();
  const testBooths = showMockNfcTools ? nfcTestBooths() : [];
  const completedTests = testBooths.filter((booth) => repo.hasStamp(state.user.id, booth.id)).length;
  return `
    <main class="screen p0-page scan-screen">
      ${festivalWeb.header("방문 인증", "NFC 태그로 방문을 확인해요")}
      ${festivalWeb.scanControls()}
      ${isServerMode() ? "" : `<section class="demo-boundary"><strong>체험용 방문 인증</strong><span>앱을 닫으면 이 기록은 사라져요.</span></section>`}
      ${state.db.event.emergencyMode ? emergencyBanner() : ""}
      <section class="scan-pad ${result ? `has-result ${result.type}` : ""}">
        ${result ? `
          <div class="scan-result-icon">${result.type === "success" ? "✓" : result.type === "duplicate" ? "↻" : "!"}</div>
          <span>${escapeHtml(resultBooth ? boothPlaceText(resultBooth) : "NFC 확인")}</span>
          <h2>${escapeHtml(result.title)}</h2>
          <p>${escapeHtml(result.body)}</p>
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
      ${showMockNfcTools ? `<section class="nfc-test-panel" aria-labelledby="nfcTestTitle">
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
        <strong>운영자에게 현장 확인을 요청하세요</strong>
        <p>${isServerMode() ? "앱 내 수동 승인은 아직 준비 중입니다. 현재 태그와 부스를 운영자에게 알려주세요." : "실서비스에서는 운영자가 담당 부스와 단기 학생 코드를 확인한 뒤 승인합니다."}</p>
      </section>
      ${bottomNav("scan")}
    </main>
  `;
}

function profileView() {
  const stampCount = repo.stampsForUser(state.user.id).length;
  return `
    <main class="screen p0-page profile-screen">
      ${festivalWeb.header("MY", "", true)}
      <section class="profile-card">
        <div class="profile-avatar">${escapeHtml((state.user.name || "학").slice(0, 1))}</div>
        <div><strong>${escapeHtml(state.user.name)}</strong><span>${escapeHtml(state.user.googleEmail || "학교 계정 미연결")}</span></div>
        ${state.user.role === "admin" ? "<em>관리자</em>" : ""}
      </section>
      <section class="profile-name-section" aria-label="이름 변경">
        ${state.nameEdit.open ? `
          <form id="profileNameForm" class="profile-name-form" novalidate aria-busy="${state.nameEdit.busy}">
            <label for="profileName">앱에서 사용할 이름</label>
            <input id="profileName" class="input" autocomplete="name" maxlength="60" value="${escapeHtml(state.nameEdit.draft)}" aria-describedby="profileNameHint profileNameError" aria-invalid="${Boolean(state.nameEdit.error)}" ${state.nameEdit.busy ? "disabled" : ""} />
            <p id="profileNameHint">Google 계정 이름과 학번은 바뀌지 않아요.</p>
            <p id="profileNameError" class="error-text" role="alert">${escapeHtml(state.nameEdit.error)}</p>
            <div class="profile-name-actions">
              <button id="cancelNameEdit" type="button" class="ghost-btn" ${state.nameEdit.busy ? "disabled" : ""}>${icon("close")} 취소</button>
              <button type="submit" class="primary-btn" ${state.nameEdit.busy ? "disabled" : ""}>${icon("save")} ${state.nameEdit.busy ? "저장 중..." : "저장"}</button>
            </div>
          </form>` : `<button id="editProfileName" type="button" class="text-link">${icon("user")} 이름 변경</button>`}
        <p class="profile-name-feedback" role="status">${escapeHtml(state.nameEdit.message)}</p>
      </section>
      <dl class="festival-profile-stats"><div><dt>스탬프</dt><dd>${festivalWeb.completed().length}<small>개</small></dd></div><div><dt>바우처</dt><dd>${festivalWeb.walletSummary().available}<small>장</small></dd></div><div><dt>방문 기록</dt><dd>${stampCount}<small>개</small></dd></div></dl>
      <section class="profile-list">
        ${isServerMode() ? festivalOpsUI.identityRow() : ""}
        <div><span>${isServerMode() ? "보유 포인트" : "체험 포인트"}</span><strong>${festivalWeb.points() ?? "—"} P</strong></div>
      </section>
      <nav class="profile-shortcuts" aria-label="내 축제 메뉴">
        ${[["stamps", "stamp", "나의 스탬프"], ["vouchers", "ticket", "나의 바우처"], ["reviews", "message", "나의 리뷰"]].map(([route, symbol, label]) => `<button type="button" data-route="${route}"><span class="shortcut-symbol ${route}">${icon(symbol)}</span><strong>${label}</strong>${icon("arrow")}</button>`).join("")}
      </nav>
      ${state.user.role === "admin" ? `<button type="button" class="ghost-btn full-action" data-route="admin">${isServerMode() ? "관리 마법사 열기" : "관리 마법사 열기"}</button>` : ""}
      ${typeof festivalBoothManager !== "undefined" ? festivalBoothManager.profileButton() : ""}
      <section class="festival-profile-history"><div class="section-heading"><h2>방문 기록</h2><span>${stampCount}개</span></div>${stampCount ? repo.stampsForUser(state.user.id).slice().reverse().map(v => festivalWeb.visitRow(v)).join('') : '<p class="web-muted">아직 방문 기록이 없어요.</p>'}</section>
      ${state.loginError ? `<p class="error-text" role="status">${escapeHtml(state.loginError)}</p>` : ""}
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

function boothSearchText(booth) {
  const classroom = /^([1-3])-([1-8])$/.exec(booth.room || "");
  const classLabel = classroom ? `${classroom[1]}학년 ${classroom[2]}반` : "";
  const remote = catalogBooth(booth);
  return normalizeSearchText(`${booth.name} ${booth.clubName} ${booth.location} ${classLabel} ${(booth.aliases || []).join(" ")} ${remote?.name || ""} ${remote?.position || ""}`);
}

const HANGUL_INITIALS = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
// "판교 고" -> "ㅍㄱ ㄱ": each Hangul syllable becomes its initial consonant.
function hangulInitials(value) {
  return Array.from(String(value ?? ""), ch => {
    const code = ch.charCodeAt(0) - 0xAC00;
    return code >= 0 && code < 11172 ? HANGUL_INITIALS[Math.floor(code / 588)] : ch.toLocaleLowerCase("ko-KR");
  }).join("");
}

// Names people see on the list: the booth, its club and where it is.
function boothVisibleNames(booth) {
  const remote = catalogBooth(booth);
  return [catalogName(booth), booth.name, booth.clubName, remote?.name, booth.location, remote?.position].filter(Boolean).map(String);
}

// 0 = no match, higher = better. A one-letter query (one syllable or consonants) only matches the
// start of a visible word, so it never pulls in a booth through a hidden alias or a word's middle.
function boothSearchScore(booth, query = state.search) {
  const raw = String(query ?? "").replace(/[\s\u200B-\u200D\uFEFF]+/gu, "");
  if (!raw) return 1;
  const words = boothVisibleNames(booth).flatMap(name => name.split(/[\s()\-·,:/]+/u)).filter(Boolean);
  if (/^[ㄱ-ㅎ]+$/u.test(raw)) {
    if (words.some(word => hangulInitials(word).startsWith(raw))) return 3;
    return raw.length > 1 && hangulInitials(boothVisibleNames(booth).join("")).replace(/\s+/gu, "").includes(raw) ? 1 : 0;
  }
  const needle = normalizeSearchText(raw);
  if (normalizeSearchText(catalogName(booth)).startsWith(needle)) return 4;
  if (words.some(word => normalizeSearchText(word).startsWith(needle))) return 3;
  if (Array.from(needle).length < 2) return 0;
  if (normalizeSearchText(boothVisibleNames(booth).join(" ")).includes(needle)) return 2;
  return boothSearchText(booth).includes(needle) ? 1 : 0;
}

function matchesBoothSearch(booth) {
  return boothSearchScore(booth) > 0;
}

function visibleBooths() {
  const booths = state.db.booths.filter((booth) => booth.floor === state.floor && matchesBoothSearch(booth));
  return sortedBooths(booths);
}

function searchResults() {
  let booths = state.db.booths;
  if (normalizeSearchText(state.search)) {
    // Best matches first, then by name.
    const scores = new Map(booths.map(booth => [booth.id, boothSearchScore(booth)]));
    return sortedBooths(booths.filter(booth => scores.get(booth.id) > 0)).sort((a, b) => scores.get(b.id) - scores.get(a.id));
  }
  return sortedBooths(booths);
}

function mapPlanForFloor(floor) {
  const room = (label, x, y, w, h, type = "facility") => ({ label, x, y, w, h, type });
  const corridor = (x, y, w, h, label = "복도", labelAt = 50) => ({ x, y, w, h, label, labelAt });
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
      corridors: [corridor(4, 40, 92, 6, "본관 복도", 24)],
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
        room("음악실", 60, 49, 12, 10, "special"),
        room("과학실", 31, 65, 18, 8, "science"),
        room("계단", 49, 65, 8, 16, "core"),
        room("과학실", 31, 73, 18, 8, "science"),
        room("진로상담부", 31, 81, 26, 9),
        room("학사실", 57, 65, 14, 25),
        room("다목적강당", 77, 65, 21, 25, "auditorium"),
      ],
      corridors: [corridor(4, 28, 95, 6), corridor(31, 59, 67, 6, "특별실 연결", 72)],
      connectors: [connector(50, 48, 5, 11), connector(71, 70, 6, 6)],
      exits: [{ label: "본관 출입구", x: 52.5, y: 53 }],
    };
  }

  return {
    subtitle: "3학년 교실 · 미술실 · 하늘정원",
    rooms: [
      ...shared,
      room("미술실", 60, 49, 12, 10, "special"),
      room("하늘정원", 31, 66, 35, 24, "garden"),
      room("다목적강당", 76, 66, 22, 24, "auditorium"),
    ],
    corridors: [corridor(4, 28, 95, 6), corridor(31, 60, 67, 6, "하늘정원 연결")],
    connectors: [connector(53, 48, 5, 12), connector(66, 72, 10, 6)],
    exits: [{ label: "본관 출입구", x: 52, y: 54 }, { label: "강당 연결", x: 71, y: 72 }],
  };
}

// Markers for booths without a room of their own on the plan.
function boothMapPosition(booth, plan, index = 0) {
  // Several booths in one chosen room: markers inside that room, a little apart.
  const room = booth.mapRoom && plan?.rooms.find(item => item.label === booth.mapRoom);
  if (room) return { x: room.x + room.w / 2 + ((index % 3) - 1) * 3, y: room.y + room.h / 2 + 3 };
  // A booth moved to another floor without a room has no place on the plan; the list still shows it.
  if (booth.placed && booth.homeFloor && booth.floor !== booth.homeFloor) return null;
  const classMatch = /^g([1-3])-([1-8])$/.exec(booth.id);
  if (classMatch) return { x: classPositions[Number(classMatch[2]) - 1][0], y: 41 };
  const firstFloorPositions = {
    b1: { x: 26, y: 53 },
    b2: { x: 58, y: 41 },
    b3: { x: 48, y: 53 },
    b4: { x: 84, y: 41 },
    b5: { x: 31, y: 31 },
  };
  const fixed = firstFloorPositions[booth.id] || { x: booth.x, y: booth.y };
  return Number.isFinite(fixed.x) && Number.isFinite(fixed.y) ? fixed : null;
}

// Which booth each room of the plan shows. A room a booth manager chose comes first; otherwise the
// classroom's provisional booth, or a booth named after the room. Each booth takes one room at most.
function planAssignments(plan, booths) {
  const used = new Set(), take = booth => { if (booth) used.add(booth.id); return booth || null; };
  const chosen = plan.rooms.map(item => item.type === "core" ? null : take(booths.find(booth => !used.has(booth.id) && booth.mapRoom === item.label)));
  return plan.rooms.map((item, index) => chosen[index] || (item.type === "core" ? null : take(booths.find(booth => !used.has(booth.id) && !booth.mapRoom && (item.type === "classroom"
    ? booth.id === `g${item.label}`
    : booth.name === item.label || booth.location.includes(item.label))))));
}

// Room labels wrap only between words; the CSS scales the text to the widest word and the line count.
function planLabelFit(label) {
  const words = String(label).split(/\s+/u).filter(Boolean);
  const width = Math.max(1.5, ...words.map(word => Array.from(word).reduce((sum, ch) => sum + (/[가-힣ㄱ-ㅎ]/u.test(ch) ? 1 : 0.62), 0)));
  return `--label-units:${width.toFixed(2)};--label-lines:${Math.max(1, words.length)}`;
}

function mapPlanMarkup(plan, booths) {
  const assigned = planAssignments(plan, booths);
  return `
    <div class="plan-boundary" aria-hidden="true"></div>
    ${plan.connectors.map((item) => `<div class="plan-connector" style="left:${item.x}%;top:${item.y}%;width:${item.w}%;height:${item.h}%"></div>`).join("")}
    ${plan.corridors.map((item) => `<div class="plan-corridor" style="left:${item.x}%;top:${item.y}%;width:${item.w}%;height:${item.h}%"><span style="--label-at:${item.labelAt}%">${item.label}</span></div>`).join("")}
    ${plan.rooms.map((item, index) => {
      const booth = assigned[index];
      if (!booth) return `<div class="plan-room ${item.type}" style="left:${item.x}%;top:${item.y}%;width:${item.w}%;height:${item.h}%;--stagger:${index * 12}ms;${planLabelFit(item.label)}"><span>${item.label}</span></div>`;
      const visited = repo.hasStamp(state.user.id, booth.id);
      const selected = state.selectedBoothId === booth.id;
      return `
        <button type="button" class="plan-room ${item.type} booth-room status-${booth.status} ${visited ? "visited" : ""} ${selected ? "selected" : ""}" style="left:${item.x}%;top:${item.y}%;width:${item.w}%;height:${item.h}%;--stagger:${index * 12}ms;${planLabelFit(item.label)}" data-map-select="${booth.id}" aria-label="${escapeHtml(booth.name)}, ${statusInfo(booth.status).label}" title="${escapeHtml(booth.name)}">
          <span>${item.label}</span>
          <small>${booth.category === "class" ? "부스" : "안내"}</small>
          <i class="room-state" aria-hidden="true">${icon("check")}</i>
        </button>
      `;
    }).join("")}
    ${plan.exits.map((item) => `<div class="plan-exit" style="left:${item.x}%;top:${item.y}%">${item.label}</div>`).join("")}
  `;
}

function floorTabsView() {
  return `<nav class="floor-tabs indoor-floors" aria-label="층 선택">${[...FLOORS].reverse().map(({floor, label, caption}) => `<button type="button" class="floor-tab ${state.floor === floor ? "active" : ""}" data-floor="${floor}" aria-label="${label} ${caption}" aria-pressed="${state.floor === floor}"><strong>${floor}F</strong><small>${caption}</small></button>`).join("")}</nav>`;
}

function mapCanvasView(booths, plan) {
  const placed = new Set(planAssignments(plan, booths).filter(Boolean).map(booth => booth.id));
  const selected = booths.find(booth => booth.id === state.selectedBoothId);
  return `<div class="map-card ${selected ? "has-preview" : ""}" id="mapCard" style="--map-zoom:${state.mapZoom};--map-x:${state.mapOffsetX}px;--map-y:${state.mapOffsetY}px">
    <div class="map-canvas"><div class="map-grid"></div><div class="school-label">PANGYO HIGH SCHOOL · ${state.floor}층</div>${mapPlanMarkup(plan, booths)}
      ${booths.filter(booth => !placed.has(booth.id)).map((booth, index) => {
        const position = boothMapPosition(booth, plan, index);
        if (!position) return "";
        return `<button class="${markerClass(booth)} ${state.selectedBoothId === booth.id ? "selected" : ""}" style="left:${position.x}%;top:${position.y}%" data-map-select="${booth.id}" aria-label="${escapeHtml(booth.name)}" title="${escapeHtml(booth.name)}"><span aria-hidden="true">${icon("map")}</span></button>`;
      }).join("")}
    </div>
    <div class="map-zoom-controls" role="group" aria-label="지도 확대 및 축소">
      <button type="button" class="map-zoom-btn" id="mapZoomIn" aria-label="지도 확대" title="지도 확대" ${state.mapZoom >= MAP_ZOOM_MAX ? "disabled" : ""}>${icon("plus")}</button>
      <button type="button" class="map-zoom-btn" id="mapZoomOut" aria-label="지도 축소" title="지도 축소" ${state.mapZoom <= MAP_ZOOM_MIN ? "disabled" : ""}>${icon("minus")}</button>
      <button type="button" class="map-zoom-btn" id="resetMapView" aria-label="지도 처음 보기" title="지도 처음 보기">${icon("refresh")}</button>
    </div>
    ${booths.length ? "" : mapEmptyCard()}${selected ? mapPreviewCard(selected) : ""}
  </div>`;
}

function mapView() {
  const booths = visibleBooths();
  const globalSearchResults = searchResults();
  const list = state.search ? globalSearchResults : booths;
  const floorInfo = FLOORS.find((item) => item.floor === state.floor);
  const plan = mapPlanForFloor(state.floor);
  const stampedCount = booths.filter((booth) => repo.hasStamp(state.user.id, booth.id)).length;
  const sheetHandleLabel = state.sheetLevel === "full" ? "부스 목록 접기" : state.sheetLevel === "mid" ? "부스 목록 더 펼치기" : "부스 목록 펼치기";
  return `
    <main class="map-screen ${state.sheetLevel === "full" ? "sheet-full" : ""}">
      <header class="top-bar">
        <button class="icon-btn" data-route="home" aria-label="홈으로">${icon("back")}</button>
        <h1>부스 지도</h1>
        <span class="map-location-note">${floorPlaceNote(state.floor)}</span>
      </header>
      <div class="festival-map-tools"><label class="map-search-bar search-screen-input ${state.search ? 'has-clear' : ''}">
        ${icon('search')}<input id="searchScreenInput" aria-label="부스 이름이나 위치 검색" placeholder="부스, 동아리, 교실 검색" value="${escapeHtml(state.search)}" autocomplete="off" enterkeyhint="search" /><button id="clearSearchScreen" class="icon-btn" type="button" aria-label="검색어 지우기" ${state.search ? '' : 'hidden'}>${icon('close')}</button>
      </label><div class="festival-map-filter"><span>${floorInfo.label} · ${floorInfo.caption}</span><span>${icon('check')} 방문 완료</span></div></div>
      <section class="map-stage">
        ${floorTabsView()}
        <div class="map-context-bar"><span>${plan.subtitle}</span></div>
        ${mapCanvasView(booths, plan)}
      </section>
      <section class="sheet ${sheetClass()}" id="sheet">
        <button type="button" class="sheet-handle" id="sheetToggle" aria-label="${sheetHandleLabel}" aria-expanded="${state.sheetLevel !== "peek"}" aria-controls="floorBoothList">
          <span class="sheet-grip" aria-hidden="true"></span>
          <span class="map-sheet-summary">
            <span class="map-sheet-title"><strong id="mapResultTitle">${state.search ? '검색 결과' : floorListTitle(floorInfo.label, list)}</strong><small id="mapResultCount">${listCountText(list)} · 방문 <span data-floor-stamp-count>${stampedCount}</span></small></span>
            <span class="map-sheet-chevron" aria-hidden="true">${icon("back")}</span>
          </span>
        </button>
        <div class="booth-list" id="floorBoothList">${list.length ? list.map(boothItem).join("") : `<div class="empty-list">조건에 맞는 부스가 없어요.</div>`}</div>
      </section>
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
          <span aria-hidden="true">${icon("search")}</span>
          <input id="searchScreenInput" class="input" aria-label="부스 이름이나 위치 검색" placeholder="부스 이름이나 위치 검색" value="${escapeHtml(state.search)}" autocomplete="off" enterkeyhint="search" />
          <button id="clearSearchScreen" type="button" class="clear-search-btn" aria-label="검색어 지우기" ${state.search ? "" : "hidden"}>${icon("close")}</button>
        </div>
      </header>
      <div class="search-result-meta" aria-live="polite">
        <strong id="searchResultCount">${booths.length}개 결과</strong>
        <span id="searchResultQuery">${state.search ? `"${escapeHtml(state.search)}"` : "전체 부스"}</span>
      </div>
      <div class="search-result-list" id="searchResultList">
        ${booths.length ? booths.map(boothItem).join("") : `<div class="empty-list">조건에 맞는 부스가 없어요.</div>`}
      </div>
    </section>
  `;
}

function updateSearchOverlay() {
  const input = document.querySelector("#searchScreenInput");
  const resultList = document.querySelector("#searchResultList") || document.querySelector('#floorBoothList');
  if (!input || !resultList) return;

  const booths = state.search ? searchResults() : visibleBooths();
  const inputShell = input.closest(".search-screen-input");
  const clearButton = document.querySelector("#clearSearchScreen");
  const resultCount = document.querySelector("#searchResultCount");
  const resultQuery = document.querySelector("#searchResultQuery");

  inputShell?.classList.toggle("has-clear", Boolean(state.search));
  if (clearButton) clearButton.hidden = !state.search;
  if (resultCount) resultCount.textContent = `${booths.length}개 결과`;
  if (resultQuery) resultQuery.textContent = state.search ? `"${state.search}"` : "전체 부스";
  const title = document.querySelector('#mapResultTitle'), count = document.querySelector('#mapResultCount');
  if (title) title.textContent = state.search ? '검색 결과' : floorListTitle(`${state.floor}층`, booths);
  if (count) count.innerHTML = `${listCountText(booths)} · 방문 <span data-floor-stamp-count>${booths.filter(b => repo.hasStamp(state.user.id, b.id)).length}</span>`;
  resultList.innerHTML = booths.length
    ? booths.map(boothItem).join("")
    : `<div class="empty-list">조건에 맞는 부스가 없어요.</div>`;
  resultList.scrollTop = 0;
  bindBoothListButtons(resultList);
}

// Facilities (보건실, 행정실 …) are listed with the booths but not counted as booths.
function listCountText(list) {
  const facilities = list.filter(b => b.category === "facility").length;
  return `부스 ${list.length - facilities}개${facilities ? ` · 시설 ${facilities}곳` : ""}`;
}
function floorListTitle(label, list) {
  return list.some(b => b.category === "facility") ? `${label} 부스·시설` : `${label} 부스`;
}
function floorPlaceNote(floor) {
  if (!isServerMode()) return "판교고";
  return state.db.booths.some(b => b.officialClubId && Number(b.floor) === Number(floor) && !b.placed) ? "일부 위치 임시 배치" : "판교고";
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
  if (repo.hasStamp(state.user.id, booth.id)) classes.push("visited");
  return classes.join(" ");
}

function clubVisual(booth, variant = "list") {
  const label = String(booth.name || booth.clubName || "부스").trim();
  if (booth.image) {
    const alt = variant === "detail" ? `${label} 대표 이미지` : "";
    return `<span class="club-visual ${variant} kind-${escapeHtml(booth.imageKind || "poster")}"><img src="${escapeHtml(booth.image)}" alt="${escapeHtml(alt)}" loading="${variant === "detail" ? "eager" : "lazy"}" decoding="async" /></span>`;
  }
  return `<span class="club-visual ${variant} fallback" aria-hidden="true">${escapeHtml(label.slice(0, 1) || "부")}</span>`;
}

function sheetClass() {
  if (state.sheetLevel === "full") return "full";
  if (state.sheetLevel === "mid" || state.sheetOpen) return "open";
  return "";
}

function boothItem(booth) {
  const stamped = repo.hasStamp(state.user.id, booth.id);
  const selected = state.selectedBoothId === booth.id;
  const rating = ratingInfo(booth.id);
  const officialClub = Boolean(booth.officialClubId);
  const facility = booth.category === "facility";
  const metaText = escapeHtml(officialClub
    ? `${boothPlaceText(booth)} · ${formatOperatingHours(booth)}`
    : facility ? `${booth.clubName} · ${booth.location}` : `${booth.clubName} · ${booth.location} · ${formatOperatingHours(booth)}`);
  return `
    <button class="booth-item ${booth.category || "class"} ${officialClub || booth.image ? "has-club-visual" : ""} ${stamped ? "visited" : ""} ${selected ? "selected" : ""}" data-list-select="${booth.id}">
      ${officialClub || booth.image ? clubVisual(booth) : ""}
      <span class="booth-main">
        <strong>${catalogName(booth)}</strong>
        <span class="meta">${metaText}</span>
        <span class="booth-stats">${facility ? '<i>시설 안내</i>' : `<i class="rating-stat">${icon("star")} ${catalogRating(booth)}</i>`}${isServerMode() ? (stamped ? `<i>${repo.hasReview(state.user.id, booth.id) ? "별점 남김" : "별점 남기기"}</i>` : "") : `<i>평가 ${rating.count}</i>`}<i data-booth-visited="${booth.id}" class="${stamped ? "visit-complete" : ""}">${stamped ? "방문 완료" : "방문 전"}</i></span>
      </span>
      ${facility && isServerMode() ? "" : statusBadge(booth.status)}
      <span class="stamp ${stamped ? "on" : ""}">${icon("stamp")}</span>
    </button>
  `;
}

function mapPreviewCard(booth) {
  const stamped = repo.hasStamp(state.user.id, booth.id);
  const rating = ratingInfo(booth.id);
  return `
    <article class="map-preview-card">
      <div>
        <strong>${catalogName(booth)}</strong>
        <span>${escapeHtml(boothPlaceText(booth))}</span>
        <span class="preview-rating">${icon("star")} ${isServerMode() ? catalogRating(booth) : rating.average || "평가 전"}<span class="preview-visit" data-booth-visited="${booth.id}">${stamped ? "방문 완료" : "방문 전"}</span></span>
      </div>
      <button type="button" class="preview-detail-btn" data-detail="${booth.id}">상세 ${icon("arrow")}</button>
      <button type="button" class="preview-close-btn" data-clear-selection aria-label="선택 해제">${icon("close")}</button>
    </article>
  `;
}

function detailView() {
  const booth = state.db.booths.find((item) => item.id === state.selectedBoothId);
  if (!booth) return missingBoothView();
  const stamped = repo.hasStamp(state.user.id, booth.id);
  const rating = ratingInfo(booth.id);
  const reviewed = repo.hasReview(state.user.id, booth.id);
  const mockNfcToken = canUseMockNfcTools() ? mockNfcTokenForTagId(booth.nfcTagId) : "";
  return `
    <main class="screen detail-screen">
      <header class="top-bar">
        <button class="icon-btn" data-history-back="map" aria-label="지도 화면으로 돌아가기">${icon("back")}</button>
        <div class="top-title"><strong>부스 상세</strong><span>${escapeHtml(boothPlaceText(booth))}</span></div>
        ${mockNfcToken
          ? `<button class="icon-btn" data-nfc-token="${escapeHtml(mockNfcToken)}" data-nfc-source="detail-shortcut" title="NFC 모의 테스트">NFC</button>`
          : `<button type="button" class="icon-btn" data-route="home" aria-label="홈">${icon("home")}</button>`}
      </header>
      <section class="detail-hero">
        <div class="detail-status-row">${statusBadge(booth.status)}<span>${escapeHtml(formatOperatingHours(booth))}</span></div>
        <div class="detail-club-heading${booth.officialClubId || booth.image ? '' : ' is-text-only'}">
          ${booth.officialClubId || booth.image ? clubVisual(booth, "detail") : ""}
          <div>
            <div class="meta">${booth.officialClubId ? "판교고 동아리" : escapeHtml(booth.clubName)} · ${escapeHtml(boothPlaceText(booth))}</div>
            <h1 class="title">${catalogName(booth)}</h1>
            ${isServerMode() ? "" : `<p class="catalog-position" data-catalog-position="${booth.id}">${escapeHtml(catalogPositionText(booth))}</p>`}
          </div>
        </div>
        <div class="meta"><span class="stamp ${stamped ? "on" : ""}">${icon("stamp")}</span> ${stamped ? "스탬프 적립 완료" : "아직 방문하지 않았어요"}</div>
        <div class="detail-metrics" aria-label="부스 평가와 방문 상태">
          <span><small>별점</small><strong data-review-average>${escapeHtml(reviewAverageText(rating))}</strong></span>
          <span><small>${isServerMode() ? "리뷰" : "평가"}</small><strong data-review-count>${escapeHtml(reviewCountText(rating))}</strong></span>
          <span><small>내 방문</small><strong>${stamped ? "방문 완료" : "방문 전"}</strong></span>
        </div>
        <button type="button" class="ghost-btn full-action detail-review-link" data-open-booth-reviews="${escapeHtml(booth.id)}">${icon("message")}<span>리뷰 보기</span><b data-review-count-link>${escapeHtml(reviewCountText(rating))}</b>${icon("arrow")}</button>
        <button type="button" class="text-link festival-locate" data-locate-booth="${escapeHtml(booth.id)}">${icon('map')} 지도에서 위치 보기</button>
      </section>
      <p class="detail-data-note">${isServerMode() ? (booth.placed ? "부스 위치는 부스 담당자가 등록했어요." : "지도 위치는 임시 배치예요. 실제 부스 위치는 운영 안내를 확인해 주세요.") : "데모 화면 · 방문과 평가는 앱을 닫으면 사라집니다."}</p>
      <section class="panel section">
        <h2>부스 소개</h2>
        <p class="subtitle">${escapeHtml(booth.description)}</p>
      </section>
      ${festivalWeb.program(booth)}
      <section class="panel section">
        <h2>방문 인증</h2>
        ${stamped
          ? `<p class="success-text">이 부스의 방문 기록이 축제 패스에 저장됐어요.</p>`
          : `<p class="notice">부스의 NFC 태그를 휴대폰에 대서 방문을 인증해 주세요. 인식되지 않으면 운영자에게 수동 승인을 요청할 수 있어요.</p>`}
        <button type="button" class="${stamped ? "ghost-btn" : "primary-btn"} full-action" ${mockNfcToken ? `data-nfc-token="${escapeHtml(mockNfcToken)}" data-nfc-source="detail-action"` : `data-route="${stamped ? "stamps" : "scan"}"`}>${mockNfcToken ? (stamped ? "인증 결과 다시 확인" : "NFC 모의 방문 인증") : stamped ? "내 스탬프 보기" : "NFC 방문 인증"}</button>
      </section>
      ${reviewSectionMarkup(booth, { stamped, reviewed, rating })}
      ${bottomNav("map")}
    </main>
  `;
}

function reviewSectionMarkup(booth, { stamped, reviewed, rating }) {
  if (isOwnClubBooth(booth.id)) return `<section class="panel section review-section own-club-review" id="boothReviewSection">
        <div class="review-heading"><h2>리뷰</h2></div>
        <p class="review-guidance">본인 동아리 부스에는 별점을 남길 수 없어요.</p>
        <div class="review-list">${reviewListMarkup(rating)}</div>
      </section>`;
  return `
      <section class="panel section review-section" id="boothReviewSection">
        <div class="review-heading">
          <h2>어떤 경험이었나요?</h2>
        </div>
        ${reviewed && festivalWeb.ownReview(booth.id)?.content?.trim()
          ? `<p class="review-guidance success">별점과 글 후기를 모두 남겼어요. 고마워요!</p>`
          : reviewForm({
            enabled: stamped,
            message: reviewed ? "별점은 이미 저장됐어요. 못 쓴 글 후기를 이어서 남겨주세요." : stamped ? "방문한 부스를 평가해 주세요. 글 후기는 나중에 써도 돼요." : "방문 인증 후 별점을 남길 수 있어요.",
          })}
        <div class="review-list">${reviewListMarkup(rating)}</div>
      </section>
  `;
}

function reviewForm({ enabled, message }) {
  const own = festivalWeb.ownReview(state.selectedBoothId);
  const policy = reviewEligibility(state.selectedBoothId);
  enabled = enabled && policy.allowed;
  if (!policy.allowed) message = reviewEligibilityMessage(policy);
  const value = own?.rating || state.reviewRating;
  return `
    <div class="review-compose ${enabled ? "" : "locked"}">
      <p class="review-guidance">${message}</p>
      <button type="button" class="text-link review-identity-link" data-route="identity" ${isServerMode() && policy.reason === "REVIEW_IDENTITY_REQUIRED" ? "" : "hidden"}>${icon("user")} 본인 소속 확인하기</button>
      <p class="review-identity" ${policy.allowed ? "" : "hidden"}>${policy.allowed ? `${escapeHtml(policy.authorName)} 이름으로 공개돼요.` : ""}</p>
      <div class="star-picker" aria-label="별점 선택">
        ${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="star ${value >= n ? "on" : ""}" data-rating="${n}" aria-label="${n}점" aria-pressed="${value === n}" ${enabled && !own ? "" : "disabled"}>${icon("star")}</button>`).join("")}
      </div>
      <label class="review-field" for="reviewContent">글 후기 <small>선택 · 최대 500자</small></label>
      <textarea id="reviewContent" class="textarea" maxlength="500" placeholder="좋았던 경험을 나눠주세요." ${enabled ? "" : "disabled"}>${escapeHtml(state.reviewDraft)}</textarea>
      ${isServerMode() ? `<p class="web-review-hint">글 후기 최초 등록 시 ${festivalOpsUI.snapshot()?.event?.review_points || 0}P · 부스당 한 번</p>` : `<p class="web-review-hint">글 후기 최초 등록 시 체험 ${festivalWeb.REVIEW_POINTS}P · 부스당 한 번</p>`}
      <p class="review-feedback" id="reviewFeedback" role="status" aria-live="polite"></p>
      <button id="submitReview" type="button" class="primary-btn full-action" ${enabled && !state.reviewBusy ? "" : "disabled"}>${state.reviewBusy ? "등록 중..." : !policy.allowed ? "리뷰 작성 제한" : !enabled ? "방문 후 작성 가능" : own ? "글 후기 등록" : "별점 등록하고 날인 완료"}</button>
      <button id="saveReviewDraft" class="ghost-btn full-action" type="button" ${enabled ? "" : "hidden"}>임시저장하고 나중에 쓰기</button>
    </div>
  `;
}

function reviewView(review) {
  // New reviews carry a verified-name snapshot. Old anonymous reviews stay anonymous.
  const author = review.author || review.authorName || "참여자";
  return `<article class="review${review.mine ? " mine" : ""}"><div class="review-meta"><strong>${icon("star")} ${Number(review.rating).toFixed(1)}</strong><span>방문 인증 · ${escapeHtml(author)}${review.mine ? " (나)" : ""} · ${formatReviewDate(review.createdAt)}</span></div>${review.content ? `<p>${escapeHtml(review.content)}</p>` : ""}</article>`;
}

function openBoothReviews(boothId) {
  state.selectedBoothId = boothId;
  state.boothReviewsExpanded = false;
  navigateTo("boothReviews");
}

function reviewStars(value) {
  const filled = Math.round(Number(value) || 0);
  return [1, 2, 3, 4, 5].map(n => `<span class="booth-star${n <= filled ? " on" : ""}">${icon("star")}</span>`).join("");
}

// Registration time on the single festival day, e.g. "오전 09시 23분".
function formatReviewTime(value) {
  // 24-hour parts keep the 오전/오후 label independent of the device's locale data.
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Seoul" })
    .formatToParts(new Date(value)).map(part => [part.type, Number(part.value)]));
  const hour = parts.hour % 12 || 12;
  return `${parts.hour < 12 ? "오전" : "오후"} ${String(hour).padStart(2, "0")}시 ${String(parts.minute).padStart(2, "0")}분`;
}

// Two-character initials and a stable colour per author, like a profile avatar.
function reviewAvatar(author) {
  const name = String(author || "참여자").replace(/\s/g, "");
  const initials = name.length > 2 ? name.slice(-2) : name;
  const palette = ["#e07b39", "#7b3fa6", "#2f7d6d", "#3d6fb6", "#c2477a", "#8a6d1f"];
  const hue = [...name].reduce((sum, char) => sum + char.codePointAt(0), 0) % palette.length;
  return `<span class="booth-review-avatar" style="background:${palette[hue]}" aria-hidden="true">${escapeHtml(initials)}</span>`;
}

function boothReviewItem(review) {
  const author = review.author || review.authorName || "참여자";
  return `<article class="booth-review-item${review.mine ? " mine" : ""}">
    ${reviewAvatar(author)}
    <div class="booth-review-item-body">
      <strong class="booth-review-author">${escapeHtml(author)}${review.mine ? '<span class="booth-review-mine">내 리뷰</span>' : ""}</strong>
      <p class="booth-review-item-meta"><span class="booth-review-item-stars" role="img" aria-label="별점 ${Number(review.rating)}점">${reviewStars(review.rating)}</span><time datetime="${escapeHtml(review.createdAt)}">${formatReviewTime(review.createdAt)}</time></p>
      ${review.content?.trim() ? `<p class="booth-review-text">${escapeHtml(review.content)}</p>` : ""}
    </div>
  </article>`;
}

function boothReviewsView() {
  const booth = state.db.booths.find(item => item.id === state.selectedBoothId);
  if (!booth) return missingBoothView();
  return `
    <main class="screen booth-reviews-screen">
      <header class="top-bar">
        <button class="icon-btn" data-history-back="detail" aria-label="부스 상세로 돌아가기">${icon("back")}</button>
        <div class="top-title"><strong>${escapeHtml(catalogBooth(booth)?.name || booth.name)} 리뷰</strong><span>${escapeHtml(boothPlaceText(booth))}</span></div>
        <button type="button" class="icon-btn" data-route="home" aria-label="홈">${icon("home")}</button>
      </header>
      <div id="boothReviewsBody" aria-live="polite">${boothReviewsBody(booth.id)}</div>
      ${bottomNav("boothReviews")}
    </main>
  `;
}

function missingBoothView() {
  return `<main class="screen web-page">${festivalWeb.header("부스를 찾을 수 없어요")}<p class="web-muted">주소를 확인하거나 지도에서 부스를 다시 선택해 주세요.</p><button class="primary-btn" data-route="map">${icon("map")} 부스 지도</button>${bottomNav("map")}</main>`;
}

function boothReviewsBody(boothId) {
  const info = ratingInfo(boothId);
  if (info.status === "error") return `<div class="review-empty"><strong>리뷰를 불러오지 못했어요</strong><p>${escapeHtml(info.message || "연결을 확인하고 다시 시도해 주세요.")}</p><button type="button" class="ghost-btn" data-reload-booth-reviews>${icon("refresh")} 다시 불러오기</button></div>`;
  if (info.status !== "ready" && !info.reviews.length) return `<div class="review-empty"><strong>리뷰를 불러오는 중이에요</strong></div>`;
  const reviews = info.reviews;
  const total = info.count;
  // Exact counts from the server; a list-only fallback is used only when it holds every review.
  const fallback = reviews.length >= total ? Object.fromEntries([1, 2, 3, 4, 5].map(n => [n, reviews.filter(r => Math.round(r.rating) === n).length])) : null;
  const distribution = info.distribution || fallback;
  const PREVIEW = 4;
  const shown = state.boothReviewsExpanded ? reviews : reviews.slice(0, PREVIEW);
  return `
    <section class="booth-review-summary" aria-label="평균 별점과 분포">
      <div class="booth-review-score">
        <strong>${info.average || "0.0"}</strong>
        <span class="booth-review-stars" role="img" aria-label="평균 ${info.average || 0}점">${reviewStars(info.average)}</span>
        <small>총 ${icon("user")}${total.toLocaleString("ko-KR")}건</small>
      </div>
      ${distribution ? `<ol class="booth-review-bars" aria-label="별점 분포">${[5, 4, 3, 2, 1].map(score => {
        const n = distribution[score] || 0;
        return `<li class="score-${score}"><span>${score}</span><span class="booth-review-bar" role="img" aria-label="${score}점 ${n}개"><i style="width:${total ? Math.round(n / total * 100) : 0}%"></i></span></li>`;
      }).join("")}</ol>` : ""}
    </section>
    <section class="booth-review-list" aria-label="리뷰 목록">
      ${shown.length ? shown.map(boothReviewItem).join("") : `<div class="review-empty"><strong>아직 등록된 리뷰가 없어요</strong><p>방문한 참여자가 별점을 남기면 여기에 표시돼요.</p></div>`}
      ${!state.boothReviewsExpanded && reviews.length > PREVIEW ? '<button type="button" class="booth-review-more" data-booth-reviews-more>리뷰 모두 보기</button>' : ""}
      ${state.boothReviewsExpanded && reviews.length < total ? `<p class="booth-review-note">최근 리뷰 ${reviews.length}개를 보여 주고 있어요.</p>` : ""}
    </section>
  `;
}

function stampView() {
  return festivalWeb.stamps();
}


// Operator screen for the real server. The DB re-checks the admin flag on every issue call.
function serverAdminView() {
  const booths = state.db.booths.filter(booth => booth.officialClubId && boothKeyFor(booth));
  const selected = booths.find(booth => booth.id === serverAdmin.boothId) || booths[0] || null;
  const result = serverAdmin.result;
  return `
    <main class="screen admin-screen server-admin">
      <header class="top-bar">
        <button class="icon-btn" data-route="home" aria-label="홈으로 돌아가기">${icon("back")}</button>
        <div class="top-title"><strong>관리 마법사</strong><span>NFC 태그 발급·관리</span></div>
        <span class="icon-btn" aria-hidden="true"></span>
      </header>
      ${festivalOpsUI.navigation()}
      <section class="nfc-manager">
        <header class="nfc-manager-heading"><div><h1>NFC 태그 발급</h1><p>부스 카드에 기록할 서명 주소를 만듭니다</p></div><span class="nfc-demo-badge">서버 연결</span></header>
        <p class="nfc-scope-note">발급한 주소는 학생 계정에서 방문 인증에 쓰여요. 화면을 공유하거나 촬영하지 마세요.</p>
        ${booths.length ? `
        <form id="serverAdminForm" novalidate>
          <label class="field" for="serverAdminBooth">부스
            <select class="select" id="serverAdminBooth">
              ${booths.map(booth => `<option value="${escapeHtml(booth.id)}" ${selected?.id === booth.id ? "selected" : ""}>${escapeHtml(catalogBooth(booth)?.name || booth.name)} · ${escapeHtml(booth.location)}</option>`).join("")}
            </select>
          </label>
          <label class="field" for="serverAdminLabel">카드 메모 (선택)
            <input class="input" id="serverAdminLabel" maxlength="40" autocomplete="off" placeholder="예: 정문 카드" value="${escapeHtml(serverAdmin.label)}" />
          </label>
          <div class="nfc-save-row">
            <span id="serverAdminStatus" role="status">${serverAdmin.busy ? "발급하는 중이에요" : "발급 준비됨"}</span>
            <button type="submit" class="primary-btn" id="serverAdminIssue" ${serverAdmin.busy ? "disabled" : ""}>${icon("scan")} 태그 발급</button>
          </div>
        </form>
        ${result ? `
        <section class="nfc-saved-tools" id="serverAdminResult" aria-label="발급 결과">
          <div class="nfc-manager-result ${result.tone}"><strong>${escapeHtml(result.title)}</strong><p>${escapeHtml(result.body)}</p></div>
          ${result.url ? `
          <label class="field" for="serverAdminUrl">카드에 기록할 주소
            <div class="nfc-tag-input">
              <input id="serverAdminUrl" class="input" value="${escapeHtml(result.url)}" readonly spellcheck="false" />
              <button type="button" class="icon-btn" data-server-admin="copy" aria-label="발급 주소 복사" title="발급 주소 복사">${icon("copy")}</button>
            </div>
          </label>
          <p class="nfc-field-note">NFC 쓰기 앱에서 URL(URI) 레코드로 기록하세요. 길이 ${result.url.length}자 · NTAG215 이상이 필요해요.</p>` : ""}
        </section>` : ""}
        ` : `<p class="nfc-empty">서버 카탈로그에 연결된 부스가 없어요.</p>`}
        ${issuedTagsSection(booths)}
      </section>
      ${bottomNav("admin")}
    </main>
  `;
}

const TAG_STATUS_LABELS = { active: "사용 중", revoked: "사용 중지", expired: "만료" };

function formatShortDateTime(value) {
  return new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Seoul" }).format(new Date(value));
}

function tagBoothName(key) {
  const booth = state.db.booths.find(item => boothKeyFor(item) === key);
  return booth ? catalogBooth(booth)?.name || booth.name : key;
}

function issuedTagItem(tag) {
  const busy = serverAdmin.tagBusy === tag.id;
  const tone = tag.status === "revoked" ? "disabled" : tag.status === "expired" ? "missing" : "enabled";
  const editing = serverAdmin.editingTag === tag.id;
  // A failed action on this tag is shown in the tag's own row; a failed memo keeps what was typed.
  const failed = serverAdmin.tagNote?.id === tag.id ? serverAdmin.tagNote : null;
  return `<li class="nfc-issued-tag is-${tag.status}" data-tag-id="${escapeHtml(tag.id)}">
      <div class="nfc-issued-head"><strong>${escapeHtml(tagBoothName(tag.boothKey))}</strong><span class="nfc-tag-state ${tone}">${TAG_STATUS_LABELS[tag.status]}</span></div>
      <p class="nfc-issued-memo ${tag.label ? "" : "empty"}">${escapeHtml(tag.label || "메모 없음")}</p>
      <p class="nfc-issued-meta">${tag.source === "discovered" ? `이전 발급 · ${formatShortDateTime(tag.issuedAt)} 첫 인식` : `${formatShortDateTime(tag.issuedAt)} 발급${tag.issuerName ? ` · ${escapeHtml(tag.issuerName)}` : ""}`}</p>
      <p class="nfc-issued-meta">인식 ${tag.useCount}회${tag.lastUsedAt ? ` · 마지막 ${formatShortDateTime(tag.lastUsedAt)}` : ""}${tag.revokedAt ? ` · ${formatShortDateTime(tag.revokedAt)} 중지` : ""}</p>
      ${editing ? `<form class="nfc-issued-label" data-tag-label-form="${escapeHtml(tag.id)}"><input class="input" name="label" maxlength="40" value="${escapeHtml(failed?.label ?? tag.label)}" aria-label="카드 메모" autocomplete="off" /><button type="submit" class="primary-btn" ${busy ? "disabled" : ""}>저장</button><button type="button" class="ghost-btn" data-server-tag="cancel" data-tag="${escapeHtml(tag.id)}">취소</button></form>` : ""}
      <div class="nfc-issued-actions">
        ${tag.status === "active" ? `<button type="button" class="ghost-btn" data-server-tag="url" data-tag="${escapeHtml(tag.id)}" ${busy ? "disabled" : ""}>${icon("copy")} 주소 보기</button>` : ""}
        ${editing ? "" : `<button type="button" class="ghost-btn" data-server-tag="edit" data-tag="${escapeHtml(tag.id)}" ${busy ? "disabled" : ""}>메모</button>`}
        ${tag.status === "active" ? `<button type="button" class="ghost-btn danger" data-server-tag="revoke" data-tag="${escapeHtml(tag.id)}" ${busy ? "disabled" : ""}>사용 중지</button>` : ""}
        ${tag.status === "revoked" ? `<button type="button" class="ghost-btn" data-server-tag="restore" data-tag="${escapeHtml(tag.id)}" ${busy ? "disabled" : ""}>다시 사용</button>` : ""}
      </div>
      ${spotMarkup(failed, `tag:${tag.id}`)}
    </li>`;
}

// Cards issued before the registry are unknown to the server until they are read once.
function tagRegisterSection() {
  const nfc = window.isSecureContext && "NDEFReader" in window;
  return `<section class="nfc-register" aria-labelledby="serverTagRegisterTitle">
      <h3 id="serverTagRegisterTitle">기존 카드 등록</h3>
      <p>이 목록이 생기기 전에 발급한 카드는 서버에 기록이 없어요. 카드를 읽거나 카드 주소를 붙여 넣으면 목록에 추가돼 관리할 수 있어요. 스탬프는 적립되지 않아요.</p>
      <button type="button" class="${serverAdmin.tagReading ? "primary-btn" : "ghost-btn"} nfc-register-read" data-server-tag-read ${nfc ? "" : "disabled"}>${icon("scan")} ${serverAdmin.tagReading ? "카드 읽기 중지" : "NFC로 카드 읽기"}</button>
      ${nfc ? (serverAdmin.tagReading ? '<p class="nfc-field-note">카드를 휴대폰 뒷면에 차례로 대세요. 읽을 때마다 등록돼요.</p>' : "") : '<p class="nfc-field-note">NFC 읽기는 안드로이드 크롬에서만 돼요. 다른 기기에서는 카드 주소를 붙여 넣어 주세요.</p>'}
      <form class="nfc-register-form" data-server-tag-register>
        <input class="input" name="address" autocomplete="off" spellcheck="false" placeholder="카드 주소 붙여넣기 (…#t=nf1.…)" aria-label="카드 주소" />
        <input class="input" name="label" maxlength="40" autocomplete="off" placeholder="메모 (선택)" aria-label="카드 메모" />
        <button type="submit" class="primary-btn">등록</button>
      </form>
      <p class="nfc-register-status ${serverAdmin.registerTone}" id="serverTagRegisterStatus" role="status" aria-live="polite">${escapeHtml(serverAdmin.registerNote)}</p>
    </section>`;
}

// Accepts a card address in any form the cards were written with, or the bare token.
function extractTagToken(text) {
  const value = String(text || "").trim();
  if (window.FestivalAccount.TOKEN_PATTERN.test(value)) return value;
  const hash = value.includes("#") ? value.slice(value.indexOf("#") + 1) : "";
  const query = value.includes("?") ? value.slice(value.indexOf("?") + 1).split("#")[0] : "";
  for (const part of [hash, query]) {
    const token = new URLSearchParams(part).get("t");
    if (window.FestivalAccount.TOKEN_PATTERN.test(token || "")) return token;
  }
  return null;
}

let serverTagReader = null;
let serverTagGeneration = 0;
async function registerServerTag(text, label = "") {
  if (!isServerMode() || !state.user || !isAdminUser()) return false;
  const token = extractTagToken(text);
  if (!token) {
    Object.assign(serverAdmin, { registerNote: "카드 주소를 확인해 주세요. 주소 끝에 #t=nf1.로 시작하는 부분이 있어야 해요.", registerTone: "error" });
    renderTagRegisterStatus();
    return false;
  }
  const actingUser = state.user.id;
  const generation = serverTagGeneration;
  Object.assign(serverAdmin, { registerNote: "확인하는 중이에요...", registerTone: "" });
  renderTagRegisterStatus();
  let response;
  try {
    response = await festivalAccount.nfcTags("register", label ? { token, label } : { token });
  } catch {
    response = { ok: false, message: "카드를 등록하지 못했어요. 연결을 확인하고 다시 시도해 주세요." };
  }
  if (state.user?.id !== actingUser || !isAdminUser() || generation !== serverTagGeneration) return false;
  Object.assign(serverAdmin, response.ok
    ? { registerNote: `${tagBoothName(response.boothKey)} 카드를 ${response.added ? "목록에 추가했어요" : "확인했어요. 이미 목록에 있어요"}.`, registerTone: "success" }
    : { registerNote: response.message, registerTone: "error" });
  if (response.ok) await loadServerTags();
  else renderTagRegisterStatus();
  return response.ok;
}

function renderTagRegisterStatus() {
  const node = document.querySelector("#serverTagRegisterStatus");
  if (!node) return;
  node.textContent = serverAdmin.registerNote;
  node.className = `nfc-register-status ${serverAdmin.registerTone}`;
}

function stopServerTagReading() {
  serverTagGeneration++;
  serverTagReader?.abort();
  serverTagReader = null;
  serverAdmin.tagReading = false;
}

async function toggleServerTagReading() {
  if (serverAdmin.tagReading) { stopServerTagReading(); render(); return; }
  if (!isServerMode() || !state.user || !isAdminUser() || !window.isSecureContext || !("NDEFReader" in window)) return;
  const controller = new AbortController();
  serverTagReader = controller;
  serverAdmin.tagReading = true;
  Object.assign(serverAdmin, { registerNote: "카드를 대 주세요.", registerTone: "" });
  render();
  try {
    const reader = new NDEFReader();
    reader.onreading = event => {
      if (controller.signal.aborted) return;
      for (const record of event.message.records) {
        if (record.recordType !== "url" && record.recordType !== "absolute-url" && record.recordType !== "text") continue;
        const text = new TextDecoder(record.encoding || "utf-8").decode(record.data);
        if (extractTagToken(text)) { registerServerTag(text); return; }
      }
      Object.assign(serverAdmin, { registerNote: "축제 방문 태그가 아니에요.", registerTone: "error" });
      renderTagRegisterStatus();
    };
    reader.onreadingerror = () => {
      if (controller.signal.aborted) return;
      Object.assign(serverAdmin, { registerNote: "카드를 읽지 못했어요. 다시 가까이 대 주세요.", registerTone: "error" });
      renderTagRegisterStatus();
    };
    await reader.scan({ signal: controller.signal });
  } catch {
    if (controller.signal.aborted) return;
    stopServerTagReading();
    Object.assign(serverAdmin, { registerNote: "NFC를 켤 수 없어요. 휴대폰 NFC 설정과 권한을 확인해 주세요.", registerTone: "error" });
    render();
  }
}

function issuedTagsSection(booths) {
  const tags = serverAdmin.tags;
  const heading = `<div class="nfc-section-title"><h2>발급된 태그</h2><button type="button" class="icon-btn" data-server-tags-refresh aria-label="발급된 태그 새로고침" title="새로고침" ${serverAdmin.tagsLoading ? "disabled" : ""}>${icon("refresh")}</button></div>`;
  if (!tags) {
    return `<section class="nfc-issued" id="serverTagList" aria-busy="${serverAdmin.tagsLoading}">${heading}
      ${serverAdmin.tagsError ? `<p class="ops-alert" role="alert">${escapeHtml(serverAdmin.tagsError)}</p>` : '<p class="nfc-empty" role="status">발급된 태그를 불러오는 중이에요.</p>'}</section>`;
  }
  const count = status => tags.filter(tag => tag.status === status).length;
  const shown = tags.filter(tag => (serverAdmin.tagBooth === "all" || tag.boothKey === serverAdmin.tagBooth)
    && (serverAdmin.tagStatus === "all" || tag.status === serverAdmin.tagStatus));
  const boothOptions = [...new Map(booths.map(booth => [boothKeyFor(booth), catalogBooth(booth)?.name || booth.name])).entries()];
  return `<section class="nfc-issued" id="serverTagList" aria-busy="${serverAdmin.tagsLoading}">${heading}
    ${serverAdmin.tagsEnabled ? "" : '<p class="ops-alert" role="alert">NFC 방문 인증이 서버에서 중지돼 있어요. 주소 보기와 새 발급이 되지 않아요.</p>'}
    ${serverAdmin.tagsError ? `<p class="ops-alert" role="alert">${escapeHtml(serverAdmin.tagsError)}</p>` : ""}
    <dl class="nfc-summary">${[["전체", tags.length], ["사용 중", count("active")], ["사용 중지", count("revoked")], ["만료", count("expired")]].map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join("")}</dl>
    <div class="nfc-manager-filters">
      <label for="serverTagBooth">부스<select class="select" id="serverTagBooth"><option value="all">전체 부스</option>${boothOptions.map(([key, name]) => `<option value="${escapeHtml(key)}" ${serverAdmin.tagBooth === key ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}</select></label>
      <label for="serverTagStatus">상태<select class="select" id="serverTagStatus">${Object.entries({ all: "전체 상태", ...TAG_STATUS_LABELS }).map(([value, label]) => `<option value="${value}" ${serverAdmin.tagStatus === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
      <span role="status">${shown.length}개</span>
    </div>
    ${shown.length ? `<ul class="nfc-issued-list">${shown.map(issuedTagItem).join("")}</ul>` : `<p class="nfc-empty">${tags.length ? "조건에 맞는 태그가 없어요." : "아직 목록에 있는 태그가 없어요. 이전에 발급한 카드는 아래에서 등록해 주세요."}</p>`}
    <p class="nfc-field-note">사용 중지한 카드로는 스탬프가 적립되지 않아요. 이미 적립된 스탬프는 그대로예요.</p>
    ${tagRegisterSection()}
  </section>`;
}

function adminView() {
  if (isServerMode()) {
    if (!isAdminUser()) return `<main class="screen"><h1>운영자 전용</h1><p>이 계정에는 운영자 권한이 없어요. 담당 선생님이나 운영진에게 문의해 주세요.</p><button class="primary-btn" data-route="home">홈으로</button></main>`;
    return festivalOpsUI.admin();
  }
  if (!canUseMockNfcTools()) return `<main class="screen"><h1>관리자 접근 제한</h1><p>서버 관리자 기능은 아직 연결되지 않았어요.</p><button class="primary-btn" data-route="home">홈으로</button></main>`;
  const tabs = [
    ["dashboard", "현황"],
    ["booths", "NFC 관리"],
    ["stamp-simulator", "스탬프 모의 발급"],
    ["visits", "방문 기록"],
    ["users", "참여자"],
  ];
  const currentTab = tabs.find(([id]) => id === state.adminTab) || tabs[0];
  return `
    <main class="screen admin-screen">
      <header class="top-bar">
        <button class="icon-btn" data-route="map" aria-label="지도로 돌아가기">${icon("back")}</button>
        <div class="top-title"><strong>관리자 패널</strong><span>부스 운영, NFC, 방문 승인 관리</span></div>
        <button class="icon-btn" data-route="login" aria-label="로그아웃" title="로그아웃">${icon("logout")}</button>
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
  if (state.adminTab === "stamp-simulator") return typeof festivalStampSimulator === "undefined" ? "" : festivalStampSimulator.view();
  const regularUsers = state.db.users.filter((user) => user.role !== "admin");
  const totalVisits = state.db.stamps.length;
  const activeBooths = state.db.booths.filter((booth) => booth.status === "open").length;
  const attentionBooths = state.db.booths.filter((booth) => booth.status === "paused").length;

  if (state.adminTab === "dashboard") {
    const top = [...state.db.booths].sort((a, b) => repo.boothVisits(b.id) - repo.boothVisits(a.id)).slice(0, 5);
    return `
      <section class="admin-hero">
        <span class="admin-eyebrow">Festival Control</span>
        <h1>운영 현황</h1>
        <p>부스 운영 상태와 NFC 방문 인증 현황을 확인해요.</p>
      </section>
      <section class="stats-grid admin-stats">
        <div class="stat"><span>총 방문 인증</span><strong>${totalVisits}</strong><small>스탬프 발급 수</small></div>
        <div class="stat"><span>운영 중 부스</span><strong>${activeBooths}</strong><small>현재 운영 중</small></div>
        <div class="stat"><span>참여자</span><strong>${regularUsers.length}</strong><small>관리자 제외</small></div>
        <div class="stat ${attentionBooths ? "warn" : ""}"><span>확인 필요</span><strong>${attentionBooths}</strong><small>일시 중지</small></div>
      </section>
      <section class="panel section admin-panel-card">
        <div class="admin-section-head"><h2>인기 부스 TOP 5</h2><span>방문수 기준</span></div>
        ${top.map((booth, index) => `<div class="rank-row"><b>${index + 1}</b><span><strong>${escapeHtml(booth.name)}</strong><small>${escapeHtml(booth.location)}</small></span><em>방문 ${repo.boothVisits(booth.id)}</em></div>`).join("")}
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
      ${nfcManagement.view()}
      <details class="nfc-add-booth">
        <summary>새 부스 추가</summary>
        <div class="admin-section-head"><h2>부스 추가</h2><span>NFC ID는 중복 불가</span></div>
        ${state.adminMessage ? `<p class="success-text">${escapeHtml(state.adminMessage)}</p>` : ""}
        <div class="input-stack admin-form-grid">
          <input id="boothName" class="input" placeholder="부스명" />
          <input id="boothLocation" class="input" placeholder="위치" />
          <select id="boothFloor" class="select"><option>1</option><option>2</option><option>3</option><option>4</option></select>
          <input id="boothNfc" class="input" placeholder="NFC 태그 ID" />
          <textarea id="boothDesc" class="textarea" placeholder="부스 설명"></textarea>
          <button id="addBooth" type="button" class="primary-btn">부스 추가</button>
        </div>
      </details>
    `;
  }
  if (state.adminTab === "visits") {
    return `
      <section class="panel admin-panel-card">
        <div class="admin-section-head"><h2>수동 방문 승인</h2><span>테스트용 로컬 기록</span></div>
        ${state.adminMessage ? `<p class="success-text">${escapeHtml(state.adminMessage)}</p>` : ""}
        ${regularUsers.length ? `
          <div class="input-stack admin-form-grid">
            <select id="manualUser" class="select">${regularUsers.map((user) => `<option value="${user.id}">${user.name} · ${user.studentNumber}</option>`).join("")}</select>
            <select id="manualBooth" class="select">${state.db.booths.map((booth) => `<option value="${escapeHtml(booth.id)}">${escapeHtml(booth.name)} · ${escapeHtml(booth.location)}</option>`).join("")}</select>
            <button id="manualApproveStamp" type="button" class="primary-btn">수동 승인 기록</button>
          </div>
        ` : `<p class="notice">먼저 학생 계정으로 로그인한 기록이 필요해요.</p>`}
      </section>
      ${state.db.stamps.length ? `<section class="admin-table section">${[...state.db.stamps].reverse().map(visitRow).join("")}</section>` : adminEmpty("아직 방문 기록이 없어요.", "NFC 인식 또는 수동 승인 후 여기에 표시돼요.")}
    `;
  }
  if (!regularUsers.length) return adminEmpty("아직 참여자가 없어요.", "사용자가 로그인하고 학생 정보를 등록하면 여기에 표시돼요.");
  return `
    ${state.adminMessage ? `<p class="admin-inline-message" role="status">${escapeHtml(state.adminMessage)}</p>` : ""}
    <section class="admin-table">${regularUsers.map(userRow).join("")}</section>
  `;
}

function boothAdminRow(booth) {
  const visits = repo.boothVisits(booth.id);
  return `
    <div class="table-row admin-row">
      <div class="row-main">
        <strong>${escapeHtml(booth.name)}</strong>
        <p class="subtitle">${booth.floor}층 · ${escapeHtml(booth.location)}</p>
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
      <p class="admin-review-content">${escapeHtml(review.content)}</p>
      <div class="row-actions">
        <button type="button" class="danger-btn" data-delete-review="${review.id}">리뷰 삭제</button>
      </div>
    </div>
  `;
}

function userRow(user) {
  const stampCount = repo.stampsForUser(user.id).length;
  const completeCount = repo.stampsForUser(user.id).filter(s => repo.hasReview(user.id, s.boothId)).length;
  return `
    <div class="table-row admin-row">
      <div class="row-main">
        <strong>${user.name}</strong>
        <p class="subtitle">${user.studentNumber} · ${user.schoolId} · ${user.googleEmail || "Google 미연동"}</p>
      </div>
      <div class="row-metrics"><span>방문 인증 ${stampCount}개</span><span>별점 등록 ${completeCount}개</span></div>
      ${user.exchangedAt
        ? `<p class="exchange-complete">${formatReviewDate(user.exchangedAt)} 간식 교환 완료</p>`
        : `<p class="web-muted">바우처 교환은 아직 이용할 수 없어요.</p>`}
    </div>
  `;
}

function stampTrailView(stamps, total) {
  const limit = state.stampTrailExpanded ? total : Math.min(total, Math.max(8, Math.ceil(stamps.length / 4) * 4));
  return `<section class="stamp-journey" aria-label="스탬프 수집 여정"><ol class="stamp-trail">${Array.from({length: limit}, (_, index) => {
    const stamp = stamps[index];
    const booth = stamp ? state.db.booths.find(item => item.id === stamp.boothId) : null;
    const row = Math.floor(index / 4), col = row % 2 ? 4 - index % 4 : index % 4 + 1;
    return `<li class="trail-stop ${stamp ? "earned" : ""} ${index === stamps.length ? "next" : ""}" style="grid-row:${row + 1};grid-column:${col}">
      ${booth ? `<button type="button" data-list-select="${booth.id}" aria-label="${index + 1}번째 스탬프, ${escapeHtml(booth.name)}">${icon("check")}</button>` : `<span class="trail-number" ${index === stamps.length ? 'aria-current="step"' : ""}>${index + 1}</span>`}
      <small>${booth ? escapeHtml(booth.name) : index === stamps.length ? "다음 스탬프" : "방문 전"}</small>
    </li>`;
  }).join("")}</ol>${total > 8 ? `<button type="button" class="trail-toggle" id="toggleStampTrail" aria-expanded="${state.stampTrailExpanded}">${state.stampTrailExpanded ? "접기" : `전체 ${total}칸 보기`}</button>` : ""}</section>`;
}

function visitRow(stamp) {
  const booth = state.db.booths.find((item) => item.id === stamp.boothId);
  const user = state.db.users.find((item) => item.id === stamp.userId);
  return `
    <div class="table-row admin-row">
      <div class="row-main"><strong>${escapeHtml(booth?.name || "삭제된 부스")}</strong><p class="subtitle">${escapeHtml(user?.name || "알 수 없음")} · ${stamp.method === "manual" ? "수동 승인" : "NFC"}</p></div>
      <div class="row-metrics"><span>${formatTime(stamp.createdAt)}</span><span>${escapeHtml(booth?.location || "위치 없음")}</span></div>
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
  const current = active === "boothReviews" ? "map" : ['scan', 'vouchers'].includes(active) ? "stamps" : ["profile", "admin", "reviews", "identity", "manage"].includes(active) ? "profile" : ["notices", "notice"].includes(active) ? "home" : active;
  return `
    <nav class="bottom-nav" aria-label="주요 메뉴">
      ${[["home", "home", "홈"], ["map", "map", "부스 지도"], ["stamps", "stamp", "스탬프"], ["profile", "user", "MY"]].map(([route, symbol, label]) => `<button type="button" class="nav-btn ${current === route ? "active" : ""}" data-route="${route}" ${current === route ? 'aria-current="page"' : ""}><span>${icon(symbol)}</span><span>${label}</span></button>`).join("")}
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
  document.querySelectorAll('[data-locate-booth]').forEach(button => button.addEventListener('click', () => {
    const booth = state.db.booths.find(b => b.id === button.dataset.locateBooth);
    if (!booth) return;
    state.floor = booth.floor;
    state.search = '';
    state.selectedBoothId = booth.id;
    state.mapSelectionEntry = false;
    state.mapZoom = 1;
    state.mapOffsetX = state.mapOffsetY = 0;
    setSheetLevel('peek');
    navigateTo('map');
  }));
  document.querySelectorAll("[data-open-reviews]").forEach(button => button.addEventListener("click", () => {
    state.reviewPickerOpen = true;
    render();
    writeNavigationHistory("push");
    document.querySelector(".review-picker [data-close-reviews]")?.focus();
  }));
  document.querySelectorAll("[data-close-reviews]").forEach(button => button.addEventListener("click", event => {
    if (event.target !== button && button.classList.contains("review-picker-backdrop")) return;
    if (history.state?.reviewPickerOpen && navigationIndex > 0) { history.back(); return; }
    state.reviewPickerOpen = false;
    render();
    document.querySelector("[data-open-reviews]")?.focus();
  }));
  document.querySelectorAll("[data-review-booth]").forEach(button => button.addEventListener("click", () => openBoothReview(button.dataset.reviewBooth)));
  document.querySelector("#reviewContent")?.addEventListener("input", event => { state.reviewDraft = event.target.value; festivalWeb.saveDraft(); });
  document.querySelector("#toggleStampTrail")?.addEventListener("click", () => {
    state.stampTrailExpanded = !state.stampTrailExpanded;
    render();
    document.querySelector("#toggleStampTrail")?.focus({preventScroll: true});
  });
  document.querySelector("#switchMode")?.addEventListener("click", () => {
    writeStorage("festival-demo-mode", "0");
    const url = new URL(location.href);
    url.searchParams.delete("demo");
    history.replaceState(null, "", url.href);
    location.reload();
  });
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
    button.addEventListener("click", async () => {
      closeMenus();
      state.searchOpen = false;
      state.reviewPickerOpen = false;
      if (button.dataset.route === "admin" && state.user?.role !== "admin") {
        state.loginError = "관리자 계정으로 로그인해야 들어갈 수 있어요.";
        navigateTo("login", { replace: true });
        return;
      }
      if (button.dataset.route === "login") {
        if (!await resetLogin()) return;
        navigateTo("login", { replace: true });
        return;
      }
      navigateTo(button.dataset.route);
    });
  });
  document.querySelectorAll("[data-open-booth-reviews]").forEach(button => button.addEventListener("click", () => openBoothReviews(button.dataset.openBoothReviews)));
  document.querySelector("#boothReviewsBody")?.addEventListener("click", event => {
    if (event.target.closest("[data-booth-reviews-more]")) {
      state.boothReviewsExpanded = true;
      event.currentTarget.innerHTML = boothReviewsBody(state.selectedBoothId);
      return;
    }
    if (event.target.closest("[data-reload-booth-reviews]")) loadBoothReviews(state.selectedBoothId, { force: true });
  });
  document.querySelectorAll("[data-history-back]").forEach((button) => {
    button.addEventListener("click", () => {
      const fallback = button.dataset.historyBack || "home";
      if (navigationIndex > 0) history.back();
      else navigateTo(fallback, { replace: true });
    });
  });
  document.querySelector("#googleLogin")?.addEventListener("click", () => runActionOnce("google-login", () => startGoogleLogin("student")));
  document.querySelector("#profileSubmit")?.addEventListener("click", () => runActionOnce("profile-save", completeProfile));
  document.querySelector("#editProfileName")?.addEventListener("click", openNameEditor);
  document.querySelector("#cancelNameEdit")?.addEventListener("click", cancelNameEditor);
  document.querySelector("#profileName")?.addEventListener("input", event => {
    state.nameEdit.draft = event.target.value;
    state.nameEdit.error = "";
    event.target.setAttribute("aria-invalid", "false");
    const error = document.querySelector("#profileNameError");
    if (error) error.textContent = "";
  });
  document.querySelector("#profileName")?.addEventListener("keydown", event => {
    if (event.key === "Enter" && (event.isComposing || event.keyCode === 229)) event.preventDefault();
  });
  document.querySelector("#profileNameForm")?.addEventListener("submit", event => {
    event.preventDefault();
    runActionOnce("profile-name", saveDisplayName);
  });
  document.querySelector("#backToGoogle")?.addEventListener("click", async () => {
    await resetLogin();
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
    state.selectedBoothId = null;
    render();
    writeNavigationHistory("push");
  }));
  document.querySelector("#sheetToggle")?.addEventListener("click", () => {
    if (Date.now() < Number(document.querySelector("#sheet")?.dataset.suppressClickUntil || 0)) return;
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
    state.searchOpen = Boolean(searchInput?.closest('.search-screen'));
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
    commitSearch(event.target.value);
  });
  document.querySelector("#clearEmptySearch")?.addEventListener("click", () => {
    state.search = "";
    setSheetLevel("full");
    render();
  });
  document.querySelector("#clearSearchScreen")?.addEventListener("click", () => {
    state.search = "";
    state.searchOpen = Boolean(searchInput?.closest('.search-screen'));
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
    closeMapCard();
  });
  bindBoothListButtons();
  document.querySelectorAll("[data-clear-selection]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      closeMapCard();
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
  document.querySelector("#mapZoomIn")?.addEventListener("click", () => adjustMapZoom(MAP_ZOOM_STEP));
  document.querySelector("#mapZoomOut")?.addEventListener("click", () => adjustMapZoom(-MAP_ZOOM_STEP));
  document.querySelector("#resetNfcTestStamps")?.addEventListener("click", resetNfcTestStamps);
  document.querySelectorAll("[data-rating]").forEach((button) => button.addEventListener("click", () => {
    state.reviewRating = Number(button.dataset.rating);
    festivalWeb.saveDraft();
    document.querySelectorAll("[data-rating]").forEach((star) => {
      const rating = Number(star.dataset.rating);
      star.classList.toggle("on", rating <= state.reviewRating);
      star.setAttribute("aria-pressed", String(rating === state.reviewRating));
    });
  }));
  document.querySelector("#submitReview")?.addEventListener("click", () => runActionOnce("submit-review", submitReview));
  document.querySelector("#serverAdminForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    runActionOnce("server-admin-issue", issueServerTag);
  });
  document.querySelector("#serverAdminBooth")?.addEventListener("change", (event) => { serverAdmin.boothId = event.target.value; });
  document.querySelector('[data-server-admin="copy"]')?.addEventListener("click", copyServerTagUrl);
  document.querySelector("#serverAdminLabel")?.addEventListener("input", (event) => { serverAdmin.label = event.target.value; });
  document.querySelector("[data-server-tags-refresh]")?.addEventListener("click", () => runActionOnce("server-tags-refresh", loadServerTags));
  document.querySelector("#serverTagBooth")?.addEventListener("change", (event) => { serverAdmin.tagBooth = event.target.value; render(); });
  document.querySelector("#serverTagStatus")?.addEventListener("change", (event) => { serverAdmin.tagStatus = event.target.value; render(); });
  document.querySelectorAll("[data-server-tag]").forEach((button) => button.addEventListener("click", () => serverTagAction(button.dataset.serverTag, button.dataset.tag)));
  document.querySelectorAll("[data-tag-label-form]").forEach((form) => form.addEventListener("submit", (event) => {
    event.preventDefault();
    serverTagAction("label", form.dataset.tagLabelForm);
  }));
  if (document.querySelector("#serverTagList") && !serverAdmin.tags && !serverAdmin.tagsLoading && !serverAdmin.tagsError) loadServerTags();
  document.querySelector("[data-server-tag-read]")?.addEventListener("click", toggleServerTagReading);
  document.querySelector("[data-server-tag-register]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    runActionOnce("server-tag-register", async () => {
      if (await registerServerTag(form.elements.address.value, form.elements.label.value.trim())) form.reset();
    });
  });
  // Leaving the NFC screen stops reading so cards tapped elsewhere behave normally.
  if (serverTagReader && (!isAdminUser() || !document.querySelector("[data-server-tag-read]"))) stopServerTagReading();
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
  nfcManagement.bind();
  festivalWeb.bind();
  festivalOpsUI.bind();
  if (typeof festivalStampSimulator !== "undefined") festivalStampSimulator.bind();
  if (typeof festivalSunCards !== "undefined") festivalSunCards.bind();
  if (typeof festivalNotices !== "undefined") festivalNotices.bind();
  if (typeof festivalBoothManager !== "undefined") festivalBoothManager.bind();
  if (typeof festivalVoucherManager !== "undefined") festivalVoucherManager.bind();
}

function closeMenus() {
  state.openMenu = null;
}

function openSearchScreen() {
  if (state.route === 'map') { focusSearchInput(); return; }
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
    fullHeight = Math.max(midHeight, navTop - (document.querySelector(".map-stage")?.getBoundingClientRect().top || 122));
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
    sheet.dataset.suppressClickUntil = String(Date.now() + 400);
    const targets = [
      ["full", fullHeight],
      ["mid", midHeight],
      ["peek", peekHeight],
    ];
    const [level] = targets.reduce((best, item) => (
      Math.abs(item[1] - currentHeight) < Math.abs(best[1] - currentHeight) ? item : best
    ), targets[0]);
    setSheetLevel(level);
    // Keep the pointer target alive through the trailing click to avoid a second toggle.
    sheet.classList.toggle("open", level !== "peek");
    sheet.classList.toggle("full", level === "full");
    document.querySelector(".map-screen")?.classList.toggle("sheet-full", level === "full");
    handle.setAttribute("aria-label", level === "full" ? "부스 목록 접기" : level === "mid" ? "부스 목록 더 펼치기" : "부스 목록 펼치기");
    handle.setAttribute("aria-expanded", String(level !== "peek"));
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
  let suppressClickUntil = 0;
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
  const commitTransform = () => {
    const transform = `translate(${state.mapOffsetX}px, ${state.mapOffsetY}px) scale(${state.mapZoom})`;
    card.style.setProperty("--map-zoom", state.mapZoom);
    card.style.setProperty("--map-x", `${state.mapOffsetX}px`);
    card.style.setProperty("--map-y", `${state.mapOffsetY}px`);
    canvas.style.transform = transform;
    const zoomIn = card.querySelector("#mapZoomIn");
    const zoomOut = card.querySelector("#mapZoomOut");
    if (zoomIn) zoomIn.disabled = state.mapZoom >= MAP_ZOOM_MAX;
    if (zoomOut) zoomOut.disabled = state.mapZoom <= MAP_ZOOM_MIN;
  };
  const zoomAt = (clientX, clientY) => {
    const nextZoom = Number(Math.min(MAP_ZOOM_MAX, Math.max(1.1, state.mapZoom + 0.22)).toFixed(2));
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
      const nextZoom = Number(Math.min(MAP_ZOOM_MAX, Math.max(MAP_ZOOM_MIN, baseZoom * (distance([...pointers.values()].slice(0, 2)) / pinchStart))).toFixed(2));
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
    const trackedPointer = pointers.get(event.pointerId);
    const endX = event.type === "pointercancel" ? trackedPointer?.clientX ?? startX : event.clientX;
    const endY = event.type === "pointercancel" ? trackedPointer?.clientY ?? startY : event.clientY;
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
    state.mapOffsetX = clamp(baseX + endX - startX, maxX);
    state.mapOffsetY = clamp(baseY + endY - startY, maxY);
    commitTransform();
    const now = Date.now();
    const tapDistance = Math.hypot(endX - lastTap.x, endY - lastTap.y);
    dragging = false;
    pinchStart = 0;
    card.classList.remove("dragging");
    if (moved) {
      suppressClickUntil = now + 320;
      lastTap = { time: 0, x: 0, y: 0 };
      return;
    }
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
      zoomAt(endX, endY);
      return;
    }
    lastTap = { time: now, x: endX, y: endY };
  };

  card.addEventListener("click", (event) => {
    if (Date.now() > suppressClickUntil) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);
  card.addEventListener("pointerup", finish);
  card.addEventListener("pointercancel", finish);
  card.addEventListener("dblclick", (event) => {
    if (event.target.closest("button, input, select, textarea")) return;
    event.preventDefault();
    if (Date.now() - lastTouchZoomAt < 360) return;
    zoomAt(event.clientX, event.clientY);
  });
}

async function resetLogin() {
  if (nfcManagement.hasDrafts() && !window.confirm("저장하지 않은 NFC 설정이 있어요. 변경을 버리고 로그아웃할까요?")) return false;
  stopServerTagReading();
  if (isServerMode()) {
    if (state.loginBusy) return false;
    state.loginBusy = true;
    try {
      const response = await festivalAccount?.signOut();
      if (response?.error) throw response.error;
    } catch {
      state.loginBusy = false;
      state.loginError = "로그아웃을 확인하지 못했어요. 연결을 확인하고 다시 시도해 주세요.";
      render();
      return false;
    }
    festivalAccount?.savePending(null);
    serverCompletedBooths = [];
    serverMyReviews = null;
    serverReviews.clear();
    Object.assign(serverAdmin, { busy: false, boothId: null, result: null, label: "", tags: null, tagsEnabled: true, tagsLoading: false, tagsError: "", tagBooth: "all", tagStatus: "all", tagBusy: null, editingTag: null, registerNote: "", registerTone: "", tagReading: false });
    state.pendingNfcClaim = null;
  }
  state.user = null;
  if (window.FestivalRouter) pendingNavigation = null;
  state.nameEdit = { open: false, draft: "", busy: false, error: "", message: "" };
  nfcManagement.clear();
  state.reviewPickerOpen = false;
  state.reviewDraft = "";
  state.scanResult = null;
  dismissNfcFeedback();
  state.authStep = "google";
  state.pendingGoogle = null;
  state.authIntent = "student";
  state.loginBusy = false;
  state.loginError = "";
  state.openMenu = null;
  return true;
}

// Set when the sign-in tab is opened. If the app comes back to the front without a session, the
// login never returned here, which usually means this app's callback address is not registered
// and the provider sent the browser to the project's default site instead.
let signInStartedAt = 0;

function reportUnfinishedSignIn() {
  if (document.visibilityState !== "visible" || !signInStartedAt) return;
  signInStartedAt = 0;
  if (!isServerMode() || state.user) return;
  // The native callback arrives moments after the app returns to the front; wait for it first.
  setTimeout(() => {
    if (state.user || state.authStep === "profile" || state.loginBusy) return;
    state.loginError = "로그인 결과를 확인하지 못했어요. 다시 시도하거나 운영자에게 이 웹사이트의 로그인 복귀 주소 등록을 확인해 주세요.";
    state.route = "login";
    render();
  }, 2000);
}

document.addEventListener("visibilitychange", reportUnfinishedSignIn);

async function startGoogleLogin(intent = "student") {
  if (state.loginBusy) return;
  state.authIntent = intent;
  state.loginError = "";
  state.loginBusy = true;
  render();
  try {
    if (isServerMode()) {
      if (!festivalAccount) throw new Error("로그인 모듈을 불러오지 못했어요. 새로고침해 주세요.");
      try { window.FestivalRouter?.remember(sessionStorage, pendingNavigation || { route: "home" }); } catch { /* Login still works without storage. */ }
      await festivalAccount.signIn();
      signInStartedAt = Date.now();
      state.loginBusy = false;
      render();
      return;
    }
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
    if (window.FestivalRouter) resumeRequestedNavigation();
    navigateTo(window.FestivalRouter ? state.route : "home", { replace: true });
    consumePendingNfc();
  } catch (error) {
    state.loginBusy = false;
    state.loginError = error.message || "로그인 처리 중 문제가 생겼어요.";
    state.route = "login";
    render();
  }
}

function openNameEditor() {
  if (!state.user || state.nameEdit.busy) return;
  state.nameEdit = { open: true, draft: state.user.name || "", busy: false, error: "", message: "" };
  render();
  document.querySelector("#profileName")?.focus();
}

function cancelNameEditor() {
  if (state.nameEdit.busy) return;
  state.nameEdit = { open: false, draft: "", busy: false, error: "", message: "" };
  render();
  document.querySelector("#editProfileName")?.focus();
}

async function saveDisplayName() {
  const edit = state.nameEdit;
  if (!state.user || !edit.open || edit.busy) return;
  const name = edit.draft.trim();
  edit.error = "";
  edit.message = "";
  if (!name || name.length > 60) {
    edit.error = "이름을 1~60자로 입력해 주세요.";
    render();
    document.querySelector("#profileName")?.focus();
    return;
  }
  if (name === state.user.name) { cancelNameEditor(); return; }
  const actorId = state.user.id;
  edit.busy = true;
  render();
  try {
    if (isServerMode()) {
      const updated = await festivalAccount.updateName(name);
      if (state.nameEdit !== edit || state.user?.id !== actorId) return;
      if (updated.authUserId !== actorId) throw new Error("PROFILE_CONFLICT");
      state.user = { ...state.user, name: updated.name };
    } else {
      const users = state.db.users.map(user => user.id === actorId ? { ...user, name } : user);
      const nextDb = { ...state.db, users };
      const progress = Object.fromEntries(SESSION_FIELDS.map(field => [field, nextDb[field] || []]));
      if (!writeSessionStorage(SESSION_KEY, JSON.stringify(progress))) throw new Error("NAME_STORAGE_FAILED");
      state.db = nextDb;
      state.user = { ...state.user, name };
    }
    edit.open = false;
    edit.draft = "";
    edit.message = "이름을 변경했어요.";
  } catch (error) {
    if (state.nameEdit !== edit || state.user?.id !== actorId) return;
    edit.error = isServerMode()
      ? window.FestivalAccount.normalizeError(error).message
      : "이름을 저장하지 못했어요. 기기의 저장 공간을 확인해 주세요.";
  } finally {
    edit.busy = false;
    if (state.nameEdit === edit && state.user?.id === actorId && ["profile", "home"].includes(state.route)) {
      render();
      if (state.route === "profile") document.querySelector(edit.open ? "#profileName" : "#editProfileName")?.focus();
    }
  }
}

async function completeProfile() {
  const google = state.pendingGoogle;
  if (!google || state.loginBusy) return;
  const nameInput = document.querySelector("#name");
  const name = nameInput ? nameInput.value.trim() : google.displayName.trim();
  const studentNumber = document.querySelector("#studentNumber").value.trim();
  if (isServerMode()) {
    google.studentNumber = studentNumber;
    if (nameInput) google.nameDraft = name;
    state.loginBusy = true;
    state.loginError = "";
    render();
    try {
      const updated = await festivalAccount.updateProfile(name, studentNumber);
      if (state.pendingGoogle === google && updated.authUserId === google.uid) applyServerProfile(updated);
    }
    catch (error) {
      if (state.pendingGoogle === google) state.loginError = window.FestivalAccount.normalizeError(error).message;
    }
    finally { state.loginBusy = false; render(); }
    return;
  }
  const schoolId = document.querySelector("#schoolId").value.trim();
  if (!name || !studentNumber || !schoolId) {
    state.loginError = "이름, 학번, 아이디를 모두 입력해주세요.";
    render();
    return;
  }
  const sameStudent = state.db.users.find((user) => user.studentNumber === studentNumber && user.googleUid !== google.uid);
  const sameSchoolId = state.db.users.find((user) => user.schoolId === schoolId && user.googleUid !== google.uid);
  if (sameStudent || sameSchoolId) {
    state.loginError = "이미 다른 구글 계정에 등록된 학번 또는 아이디예요.";
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
  if (window.FestivalRouter) resumeRequestedNavigation();
  navigateTo(window.FestivalRouter ? state.route : "home", { replace: true });
  consumePendingNfc();
}

function adminLogin() {
  if (isServerMode()) return;
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
  state.reviewRating = festivalWeb.ownReview(id)?.rating || festivalWeb.draft(id).rating || 0;
  state.reviewDraft = festivalWeb.draft(id).content || "";
  state.reviewBusy = false;
  state.reviewPickerOpen = false;
  state.searchOpen = false;
  state.sheetOpen = false;
  state.sheetLevel = "peek";
  state.openMenu = null;
  navigateTo("detail");
  requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "auto" }));
  loadBoothReviews(id);
}

function openBoothReview(id) {
  state.reviewPickerOpen = false;
  goDetail(id);
  requestAnimationFrame(() => document.querySelector("#boothReviewSection")?.scrollIntoView({block: "start", behavior: "auto"}));
}

function adjustMapZoom(delta) {
  const nextZoom = Number(Math.min(MAP_ZOOM_MAX, Math.max(MAP_ZOOM_MIN, state.mapZoom + delta)).toFixed(2));
  if (nextZoom === state.mapZoom) return;
  state.mapZoom = nextZoom;
  if (nextZoom <= 1) {
    state.mapOffsetX = 0;
    state.mapOffsetY = 0;
  } else {
    const maxX = 72 * nextZoom;
    const maxY = 92 * nextZoom;
    state.mapOffsetX = Math.min(maxX, Math.max(-maxX, state.mapOffsetX));
    state.mapOffsetY = Math.min(maxY, Math.max(-maxY, state.mapOffsetY));
  }
  render();
}

function selectMapBooth(id) {
  if (state.selectedBoothId === id) return;
  // Opening a card adds one history entry; switching to another booth replaces it, so the back
  // button and the card's X both return to the map without a card.
  const opening = !state.selectedBoothId || !state.mapSelectionEntry;
  state.selectedBoothId = id;
  state.mapSelectionEntry = true;
  state.searchOpen = false;
  if (state.sheetLevel === "full") setSheetLevel("mid");
  state.openMenu = null;
  render();
  writeNavigationHistory(opening ? "push" : "replace");
}

// Closes the booth card and stays on the map. History steps back only over the entry the map
// itself added; a card opened from a booth's 지도에서 보기 is closed in place.
function closeMapCard() {
  const pushed = history.state?.key === HISTORY_KEY && history.state.mapSelection && navigationIndex > 0;
  state.selectedBoothId = null;
  state.mapSelectionEntry = false;
  state.mapZoom = 1;
  state.mapOffsetX = 0;
  state.mapOffsetY = 0;
  if (pushed) history.back();
  else {
    render();
    writeNavigationHistory("replace");
  }
}

function focusMapOnBooth(id, targetZoom = state.mapZoom) {
  const booth = state.db.booths.find((item) => item.id === id);
  if (!booth) return;
  // Center on the room the booth is drawn in, else on its marker.
  const plan = mapPlanForFloor(booth.floor);
  const room = plan.rooms[planAssignments(plan, state.db.booths.filter(item => item.floor === booth.floor)).findIndex(item => item?.id === booth.id)];
  const position = room ? { x: room.x + room.w / 2, y: room.y + room.h / 2 } : boothMapPosition(booth, plan) || { x: 50, y: 48 };
  state.mapZoom = Math.min(1.52, Math.max(state.mapZoom, targetZoom));
  const maxX = 72 * state.mapZoom;
  const maxY = 92 * state.mapZoom;
  const targetX = (50 - position.x) * 1.35;
  const targetY = (48 - position.y) * 1.15;
  state.mapOffsetX = Math.min(maxX, Math.max(-maxX, targetX));
  state.mapOffsetY = Math.min(maxY, Math.max(-maxY, targetY));
}

async function submitReview() {
  const input = document.querySelector("#reviewContent");
  const feedback = document.querySelector("#reviewFeedback");
  const content = input?.value.trim() || "";
  const boothId = state.selectedBoothId;
  const setFeedback = (message, tone = "error") => {
    if (!feedback) return;
    feedback.textContent = message;
    feedback.dataset.tone = tone;
  };
  if (state.reviewBusy) return;
  const policy = reviewEligibility(boothId);
  if (!policy.allowed) { setFeedback(reviewEligibilityMessage(policy)); return; }
  if (!Number.isInteger(state.reviewRating) || state.reviewRating < 1 || state.reviewRating > 5) {
    setFeedback("별점을 선택해 주세요. 글 후기는 쓰지 않아도 괜찮아요.");
    document.querySelector("[data-rating]")?.focus();
    return;
  }
  if (content.length > 500) {
    setFeedback("리뷰는 500자 이하로 작성해주세요.");
    input?.focus();
    return;
  }
  if (!repo.hasStamp(state.user.id, boothId)) {
    setFeedback("부스를 방문해야 리뷰를 쓸 수 있어요.");
    return;
  }
  const existing = festivalWeb.ownReview(boothId);
  if (existing?.content?.trim()) { setFeedback("이미 글 후기를 남긴 부스예요."); return; }
  if (existing && !content) { setFeedback("별점은 저장되어 있어요. 추가할 글 후기를 입력해 주세요."); return; }
  if (isServerMode()) {
    const booth = state.db.booths.find(item => item.id === boothId);
    const key = boothKeyFor(booth);
    if (!key) {
      setFeedback("이 부스는 아직 별점을 등록할 수 없어요.");
      return;
    }
    const actingUser = state.user.id;
    state.reviewBusy = true;
    setFeedback("등록하는 중이에요...", "info");
    document.querySelector("#submitReview")?.setAttribute("disabled", "true");
    const response = await festivalAccount.submitReview(key, state.reviewRating, content);
    state.reviewBusy = false;
    if (state.user?.id !== actingUser) return;
    if (!response.ok) {
      if (response.code === "ALREADY_REVIEWED") serverMyReviews?.add(key);
      if (["OWN_CLUB_REVIEW", "REVIEW_IDENTITY_REQUIRED", "REVIEW_POLICY_REQUIRED"].includes(response.code)) {
        serverReviews.set(key, { ...serverReviews.get(key), status: "ready", reviewPolicy: { version: 1, allowed: false, reason: response.code, authorName: null } });
        updateReviewSection(boothId);
      } else document.querySelector("#submitReview")?.removeAttribute("disabled");
      setFeedback(response.message);
      if (["AUTH_REQUIRED", "GOOGLE_AUTH_REQUIRED", "PROFILE_REQUIRED"].includes(response.code)) render();
      return;
    }
    serverReviews.set(key, { ...response, status: "ready" });
    serverMyReviews?.add(key);
    await festivalOpsUI.refresh(false);
    state.reviewRating = 0;
    state.reviewDraft = "";
    festivalWeb.clearDraft(boothId);
    render();
    return;
  }
  const next = cloneData(state.db);
  const current = next.reviews.find(r => r.userId === state.user.id && r.boothId === boothId);
  if (current) { current.content = content; current.authorName ||= policy.authorName; current.updatedAt = new Date().toISOString(); }
  else next.reviews.push({ id: makeId(), userId: state.user.id, boothId, rating: state.reviewRating, content, authorName: policy.authorName, createdAt: new Date().toISOString() });
  if (!writeSessionStorage(SESSION_KEY, JSON.stringify(Object.fromEntries(SESSION_FIELDS.map(field => [field, next[field] || []]))))) {
    setFeedback("저장 공간을 사용할 수 없어요. 글을 유지했으니 다시 시도해 주세요."); return;
  }
  state.db = next;
  festivalWeb.syncRewards();
  festivalWeb.clearDraft(boothId);
  state.reviewRating = 0;
  state.reviewDraft = "";
  render();
}

function addBooth() {
  if (!canUseMockNfcTools()) return;
  const name = document.querySelector("#boothName").value.trim();
  if (!name) return;
  const nfcTagId = document.querySelector("#boothNfc").value.trim() || `NFC-${Date.now()}`;
  if (state.db.booths.some((booth) => booth.nfcTagId === nfcTagId)) {
    state.adminMessage = "이미 등록된 NFC 태그 ID예요.";
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
  state.adminMessage = "부스가 추가됐어요.";
  render();
}

function deleteBooth(id) {
  if (!canUseMockNfcTools()) return;
  state.db.booths = state.db.booths.filter((booth) => booth.id !== id);
  state.db.stamps = state.db.stamps.filter((stamp) => stamp.boothId !== id);
  state.db.idempotencyRecords = state.db.idempotencyRecords.filter((record) => record.boothId !== id);
  state.db.reviews = state.db.reviews.filter((review) => review.boothId !== id);
  saveDb();
  render();
}

function saveNfcTag(id) {
  if (!canUseMockNfcTools()) return;
  const booth = state.db.booths.find((item) => item.id === id);
  const next = document.getElementById(`nfc-${id}`).value.trim();
  if (!next) return;
  if (state.db.booths.some((item) => item.id !== id && item.nfcTagId === next)) {
    state.adminMessage = "이미 다른 부스에 등록된 NFC 태그 ID예요.";
    render();
    return;
  }
  booth.nfcTagId = next;
  saveDb();
  state.adminMessage = `${booth.name} NFC 태그가 저장됐어요.`;
  render();
}

function saveBoothStatus(id) {
  if (!canUseMockNfcTools()) return;
  const booth = state.db.booths.find((item) => item.id === id);
  const select = document.getElementById(`status-${id}`);
  if (!booth || !select || !BOOTH_STATUS[select.value]) return;
  booth.status = select.value;
  saveDb();
  state.adminMessage = `${booth.name} 상태를 ${statusInfo(booth.status).label}(으)로 바꿨어요.`;
  render();
}

function manualApproveStamp() {
  if (!isAdminUser()) return;
  const userId = document.getElementById("manualUser")?.value;
  const boothId = document.getElementById("manualBooth")?.value;
  const user = state.db.users.find((item) => item.id === userId && item.role !== "admin");
  const booth = state.db.booths.find((item) => item.id === boothId);
  if (!user || !booth) return;
  if (repo.hasStamp(user.id, booth.id)) {
    state.adminMessage = `${user.name} 학생은 이미 ${booth.name} 방문 인증을 완료했어요.`;
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
  state.adminMessage = `${user.name} 학생의 ${booth.name} 방문을 수동 승인했어요.`;
  render();
}

function resetNfcTestStamps() {
  if (!isAdminUser()) return;
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
  return nfcManagement.simulate(id);
}

async function loadServerTags() {
  if (!isServerMode() || !isAdminUser() || !festivalAccount?.nfcTags || serverAdmin.tagsLoading) return;
  const actingUser = state.user.id;
  serverAdmin.tagsLoading = true;
  const response = await festivalAccount.nfcTags("list");
  serverAdmin.tagsLoading = false;
  if (state.user?.id !== actingUser || !isAdminUser()) return;
  if (response.ok) Object.assign(serverAdmin, { tags: response.items, tagsEnabled: response.enabled, tagsError: "" });
  else serverAdmin.tagsError = response.code === "SERVER_NOT_READY"
    ? "발급된 태그 관리를 위한 서버 업데이트가 아직 적용되지 않았어요." : response.message;
  if (state.route === "admin") render();
}

async function serverTagAction(action, id) {
  const tag = serverAdmin.tags?.find(item => item.id === id);
  if (!tag || serverAdmin.tagBusy) return;
  if (action === "edit" || action === "cancel") { serverAdmin.editingTag = action === "edit" ? id : null; render(); return; }
  const name = `${tagBoothName(tag.boothKey)}${tag.label ? ` (${tag.label})` : ""}`;
  if (action === "revoke" && !confirm(`${name} 태그를 사용 중지할까요?\n이 카드로는 더 이상 스탬프를 적립할 수 없어요. 이미 적립된 스탬프는 유지돼요.`)) return;
  if (action === "restore" && !confirm(`${name} 태그를 다시 사용할까요?\n이 카드로 다시 스탬프를 적립할 수 있어요.`)) return;
  const payload = { id };
  if (action === "label") payload.label = String(document.querySelector(`[data-tag-label-form="${id}"] [name="label"]`)?.value || "").trim();
  const actingUser = state.user.id;
  serverAdmin.tagBusy = id;
  serverAdmin.tagNote = null;
  render();
  const response = await festivalAccount.nfcTags(action, payload);
  serverAdmin.tagBusy = null;
  if (state.user?.id !== actingUser || !isAdminUser()) return;
  if (!response.ok) {
    serverAdmin.tagNote = { id, at: `tag:${id}`, text: response.message, tone: "error", label: action === "label" ? payload.label : undefined };
    render();
    showSpot(`tag:${id}`, response.message);
    return;
  }
  serverAdmin.tagNote = null;
  if (action === "url") {
    serverAdmin.result = { tone: "success", title: `${name} 태그 주소`,
      body: "이미 발급한 태그와 같은 주소예요. 카드를 다시 기록할 때 사용하세요.",
      // Kept in memory only, like a newly issued address.
      url: festivalWeb.webTagUrl(response.token) };
    render();
    document.querySelector("#serverAdminResult")?.scrollIntoView({ block: "start", behavior: "auto" });
    return;
  }
  if (action === "label") serverAdmin.editingTag = null;
  await loadServerTags();
}

async function issueServerTag() {
  if (!isServerMode() || !isAdminUser() || serverAdmin.busy || !festivalAccount) return;
  if (!festivalWeb.webTagUrl("check")) {
    serverAdmin.result = { tone: "error", title: "HTTPS 웹 주소가 필요해요", body: "공개된 HTTPS 축제 웹사이트에서 태그를 발급하세요. 로컬 미리보기나 APK 주소로는 발급하지 않아요." };
    render(); return;
  }
  const boothId = document.querySelector("#serverAdminBooth")?.value || serverAdmin.boothId;
  const booth = state.db.booths.find(item => item.id === boothId);
  const key = boothKeyFor(booth);
  serverAdmin.boothId = boothId;
  if (!key) {
    serverAdmin.result = { tone: "error", title: "발급할 수 없어요", body: "서버 카탈로그에 연결된 부스가 아닙니다." };
    render();
    return;
  }
  const actingUser = state.user.id;
  serverAdmin.busy = true;
  serverAdmin.result = null;
  render();
  const label = String(document.querySelector("#serverAdminLabel")?.value ?? serverAdmin.label).trim();
  // The management endpoint records the memo; before its migration the plain issue call still works.
  let response = festivalAccount.nfcTags ? await festivalAccount.nfcTags("issue", { booth: key, label }) : null;
  if (!response || response.code === "SERVER_NOT_READY") response = await festivalAccount.issueTag(key);
  serverAdmin.busy = false;
  if (state.user?.id !== actingUser || !isAdminUser()) return;
  serverAdmin.result = response.ok
    ? {
      tone: "success",
      title: `${catalogBooth(booth)?.name || booth.name}${label ? ` (${label})` : ""} 태그를 발급했어요`,
      body: "유효기한 없이 발급했어요. 카드에 기록한 뒤 다시 읽어 주소가 온전한지 확인하세요.",
      // Kept in memory only: the signed token is never written to storage or logs.
      url: festivalWeb.webTagUrl(response.token),
    }
    : { tone: "error", title: "발급하지 못했어요", body: response.message };
  if (response.ok) serverAdmin.label = "";
  render();
  if (response.ok) loadServerTags();
}

async function copyServerTagUrl() {
  const url = serverAdmin.result?.url;
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    serverAdmin.result = { ...serverAdmin.result, body: "발급 주소를 복사했어요. NFC 쓰기 앱에 URL 레코드로 붙여 넣으세요." };
    render();
  } catch {
    const input = document.querySelector("#serverAdminUrl");
    input?.focus();
    input?.select();
    let copied = false;
    try { copied = document.execCommand("copy"); } catch { copied = false; }
    serverAdmin.result = { ...serverAdmin.result, body: copied
      ? "발급 주소를 복사했어요. NFC 쓰기 앱에 URL 레코드로 붙여 넣으세요."
      : "자동 복사를 사용할 수 없어요. 선택된 주소를 길게 눌러 복사해 주세요." };
    render();
    if (!copied) document.querySelector("#serverAdminUrl")?.select();
  }
}

function deleteReview(id) {
  state.db.reviews = state.db.reviews.filter((review) => review.id !== id);
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

// An action's result goes in the slot next to the control that started it ([data-spot]), never at
// the top of a long screen where it goes unnoticed. note: { at, text, tone } or null.
function spotMarkup(note, at) {
  const mine = note?.at === at && note.text;
  return `<p class="ops-form-status" role="status" data-spot="${escapeHtml(at)}"${mine ? ` data-tone="${escapeHtml(note.tone || "error")}"` : ""}>${mine ? escapeHtml(note.text) : ""}</p>`;
}
function showSpot(at, text, tone = "error") {
  const node = [...document.querySelectorAll("[data-spot]")].find(item => item.dataset.spot === at);
  if (!node) return false;
  node.textContent = text;
  node.dataset.tone = tone;
  node.closest("details")?.setAttribute("open", "");
  if (text) node.scrollIntoView({ block: "nearest" });
  return true;
}
// Status lines written in place (forms of the operator tools, card registration, reviews) are
// scrolled into view when they get text, so a result below the fold is still seen.
function watchStatusLines() {
  if (typeof MutationObserver !== "function" || !document.body) return;
  const LINES = ".ops-form-status, .nfc-register-status, .review-feedback";
  new MutationObserver(records => {
    for (const record of records) {
      const element = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      const line = element?.closest?.(LINES);
      if (line?.textContent.trim() && line.getClientRects().length) { line.scrollIntoView({ block: "nearest" }); return; }
    }
  }).observe(document.body, { childList: true, characterData: true, subtree: true });
}

function applyServerProfile(profile) {
  if (!profile || profile.needsProfile || !profile.isAdmin || state.user?.id !== profile.authUserId) stopServerTagReading();
  if (!profile || state.user?.id !== profile.authUserId) {
    state.nameEdit = { open: false, draft: "", busy: false, error: "", message: "" };
  }
  if (profile) signInStartedAt = 0; // the login came back; no need to warn about a lost callback
  serverCompletedBooths = profile?.completedBooths || [];
  if (!profile) {
    state.user = null;
    state.authStep = "google";
    state.pendingGoogle = null;
    state.route = "login";
    serverMyReviews = null;
    serverReviews.clear();
  } else if (profile.needsProfile) {
    state.user = null;
    state.pendingGoogle = { uid: profile.authUserId, email: profile.email, displayName: profile.name, studentNumber: profile.studentNumber };
    state.authStep = "profile";
    state.route = "login";
  } else {
    // The operator flag comes from the caller's own users row. Every privileged call is
    // re-checked on the server, so this only decides which screens are offered.
    state.user = { id: profile.authUserId, name: profile.name, studentNumber: profile.studentNumber,
      googleEmail: profile.email, role: profile.isAdmin ? "admin" : "user", source: "server" };
    state.authStep = "google";
    state.loginError = "";
    if (state.route === "login") {
      state.route = "home";
      if (window.FestivalRouter) resumeRequestedNavigation();
    }
  }
  render();
  if (state.user) {
    consumePendingNfc();
    loadMyReviews();
    if (window.FestivalRouter) loadNavigationContent();
  }
}

async function initializeAccount() {
  if (!isServerMode()) {
    if (state.pendingNfcClaim) await nfcAdapter.scan(state.pendingNfcClaim);
    return;
  }
  state.loginBusy = true;
  render();
  try {
    festivalAccount = window.FestivalAccount.createAccount({ sdk: window.supabase,
      config: window.FestivalCatalog, storage: publicCatalogStorage || undefined, location,
      onChange: event => { if (event === "SIGNED_OUT") applyServerProfile(null); },
    });
    const initialized = festivalAccount.initialize();
    window.FestivalNativeAuth = {
      async receiveCallback(url) {
        try { await initialized.catch(() => {}); applyServerProfile(await festivalAccount.receiveCallback(url)); }
        catch { state.loginError = "로그인을 완료하지 못했어요. Google 계정으로 다시 시도해 주세요."; render(); }
      },
    };
    if (state.pendingNfcClaim) festivalAccount.savePending(state.pendingNfcClaim);
    else state.pendingNfcClaim = festivalAccount.pending();
    applyServerProfile(await initialized);
  } catch (error) {
    state.loginError = window.FestivalAccount?.normalizeError(error).message || "로그인 연결을 확인하지 못했어요.";
  } finally { state.loginBusy = false; render(); }
}

initializeNavigation();
window.addEventListener("beforeunload", event => {
  if (nfcManagement.hasDrafts()) { event.preventDefault(); event.returnValue = ""; }
});
document.addEventListener("keydown", event => {
  if (document.querySelector("#nfcFeedback")) {
    if (event.key === "Escape") { event.preventDefault(); dismissNfcFeedback(); }
    return;
  }
  const dialog = document.querySelector(".review-picker");
  if (event.key === "Escape") {
    if (dialog) dialog.querySelector("[data-close-reviews]")?.click();
    else if (state.searchOpen) document.querySelector("#closeSearchScreen")?.click();
  }
  if (!dialog || event.key !== "Tab") return;
  const focusable = [...dialog.querySelectorAll('button:not([disabled]), a[href], input:not([disabled])')];
  const first = focusable[0], last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
});
// A page left open keeps running the scripts it loaded. When another release is deployed, offer a
// reload so nobody keeps working on a replaced screen. Must match the version in tools/build-web.cjs.
const APP_RELEASE = "1.33";
function watchDeployment() {
  if (!["http:", "https:"].includes(location.protocol) || location.origin === "https://appassets.androidplatform.net"
    || typeof fetch !== "function" || typeof setInterval !== "function") return;
  let notified = false;
  const check = async () => {
    if (notified || document.visibilityState === "hidden") return;
    try {
      const response = await fetch("/deployment-info.json", { cache: "no-store" });
      if (!response.ok) return;
      const { version } = await response.json();
      if (typeof version !== "string" || version === APP_RELEASE || notified) return;
      notified = true;
      const banner = document.createElement("div");
      banner.className = "app-update-banner";
      banner.setAttribute("role", "status");
      banner.innerHTML = `<span>새 버전(${escapeHtml(version)})이 배포됐어요. 새로고침하면 바로 적용돼요.</span><button type="button" class="primary-btn">새로고침</button>`;
      banner.querySelector("button").onclick = () => location.reload();
      document.body.append(banner);
    } catch { /* Offline or blocked: the next check retries. */ }
  };
  check();
  document.addEventListener("visibilitychange", check);
  window.addEventListener("focus", check);
  setInterval(check, 5 * 60 * 1000);
}

render();
watchDeployment();
watchStatusLines();
initializeAccount();
publicCatalog.subscribe(updateCatalogDom);
publicCatalog.refresh();
