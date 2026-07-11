const DB_KEY = "pangyo-festival-db-v3";
const ADMIN_TEST_USER_UID = "admin-stamp-test-user";
const DEFAULT_MARKET_SETTINGS = {
  stampGoal: 3,
  grantAmount: 100000,
  prizeTarget: 120000,
  currencyName: "판교머니",
};
const MARKET_TICK_MS = 15000;
const MARKET_STOCKS = [
  { id: "happy-tech", name: "해피전자", symbol: "해피", description: "생활 전자제품을 만드는 회사", basePrice: 12500, amplitude: 0.075, phase: 0.6, color: "#5b67d8" },
  { id: "cloud-food", name: "구름식품", symbol: "구름", description: "간식과 식품을 만드는 회사", basePrice: 8400, amplitude: 0.065, phase: 1.8, color: "#e6952e" },
  { id: "momo-games", name: "모모게임즈", symbol: "모모", description: "즐거운 게임을 만드는 회사", basePrice: 18800, amplitude: 0.18, phase: 3.1, color: "#df5269" },
  { id: "green-energy", name: "초록에너지", symbol: "초록", description: "친환경 에너지를 만드는 회사", basePrice: 10700, amplitude: 0.08, phase: 4.4, color: "#269b69" },
  { id: "moon-travel", name: "달빛여행", symbol: "달빛", description: "여행 상품을 만드는 회사", basePrice: 15200, amplitude: 0.09, phase: 5.7, color: "#2f86c9" },
];
const moneyFormatter = new Intl.NumberFormat("ko-KR");

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
  adminTestMessage: "",
  adminPreviewAdminId: null,
  marketStockId: "happy-tech",
  marketQuantity: 1,
  marketMessage: "",
  pendingNfcTag: new URLSearchParams(window.location.search).get("nfc") || "",
};

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

function makeClassBooths(grade, floor) {
  return classPositions.map(([x, y], index) => {
    const klass = index + 1;
    return {
      id: `g${grade}-${klass}`,
      name: `${grade}학년 ${klass}반 부스`,
      floor,
      location: `${floor}층 ${grade}-${klass} 교실`,
      description: "동아리/학급 부스 종류는 추후 확정되는 대로 업데이트할 예정입니다.",
      nfcTagId: `NFC-G${grade}-${String(klass).padStart(2, "0")}`,
      x,
      y,
      favorite: index === 0,
      category: "class",
    };
  });
}

const seed = {
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
    { id: "b1", name: "보건실", floor: 1, location: "1층 보건실", description: "축제 중 몸이 불편할 때 방문할 수 있는 응급 지원 공간입니다.", nfcTagId: "NFC-HEALTH-101", x: 17, y: 32, favorite: false, category: "facility" },
    { id: "b2", name: "학생회 안내소", floor: 1, location: "1층 중앙 현관", description: "축제 안내, 분실물 문의, 상품 교환 문의를 도와주는 운영 부스입니다.", nfcTagId: "NFC-INFO-102", x: 50, y: 43, favorite: true, category: "facility" },
    { id: "b3", name: "행정실", floor: 1, location: "1층 행정실", description: "축제 운영 문의와 긴급 연락을 처리하는 관리 공간입니다.", nfcTagId: "NFC-OFFICE-103", x: 46, y: 40, favorite: false, category: "facility" },
    { id: "b4", name: "시청각실", floor: 1, location: "1층 시청각실", description: "축제 영상과 안내 프로그램을 운영할 수 있는 공간입니다.", nfcTagId: "NFC-STUDIO-104", x: 84, y: 50, favorite: false, category: "facility" },
    { id: "b5", name: "상담실", floor: 1, location: "1층 상담실", description: "조용한 안내와 상담이 필요한 경우 이용하는 공간입니다.", nfcTagId: "NFC-STORE-105", x: 31, y: 31, favorite: false, category: "facility" },
    ...makeClassBooths(1, 2),
    ...makeClassBooths(2, 3),
    ...makeClassBooths(3, 4),
  ],
  stamps: [],
  reviews: [],
  marketSettings: { ...DEFAULT_MARKET_SETTINGS },
  portfolios: [],
  marketTransactions: [],
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
  db.booths = db.booths.map((booth) => {
    const update = legacyFacilityUpdates[booth.id];
    if (!update || booth.name !== update.legacyName) return booth;
    return { ...booth, name: update.name, location: update.location, description: update.description };
  });
  db.marketSettings = { ...DEFAULT_MARKET_SETTINGS, ...(db.marketSettings || {}) };
  db.portfolios = Array.isArray(db.portfolios) ? db.portfolios : [];
  db.marketTransactions = Array.isArray(db.marketTransactions) ? db.marketTransactions : [];
  db.users = db.users.map((user) => ({
    googleUid: user.googleUid || user.id,
    googleEmail: user.googleEmail || "",
    schoolId: user.schoolId || user.studentNumber,
    role: "user",
    exchangedAt: null,
    ...user,
  }));
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
    return state.db.stamps.some((stamp) => stamp.userId === userId && stamp.boothId === boothId);
  },
  hasReview(userId, boothId) {
    return state.db.reviews.some((review) => review.userId === userId && review.boothId === boothId);
  },
  boothVisits(boothId) {
    return state.db.stamps.filter((stamp) => stamp.boothId === boothId && stamp.source !== "admin-test").length;
  },
  stampsForUser(userId) {
    return state.db.stamps.filter((stamp) => stamp.userId === userId);
  },
  portfolioForUser(userId) {
    return state.db.portfolios.find((portfolio) => portfolio.userId === userId) || null;
  },
  marketTransactionsForUser(userId) {
    return state.db.marketTransactions.filter((transaction) => transaction.userId === userId);
  },
};

function formatMoney(value) {
  return moneyFormatter.format(Math.round(value));
}

function emptyHoldings() {
  return Object.fromEntries(MARKET_STOCKS.map((stock) => [stock.id, 0]));
}

function ensurePortfolio(userId) {
  let portfolio = repo.portfolioForUser(userId);
  if (!portfolio) {
    portfolio = {
      id: makeId(),
      userId,
      cash: 0,
      holdings: emptyHoldings(),
      grantedAt: null,
      qualifiedAt: null,
      createdAt: new Date().toISOString(),
    };
    state.db.portfolios.push(portfolio);
  }
  portfolio.holdings = { ...emptyHoldings(), ...(portfolio.holdings || {}) };
  return portfolio;
}

function marketTick(at = Date.now()) {
  return Math.floor(at / MARKET_TICK_MS);
}

function stockPriceAt(stock, tick) {
  const primaryWave = Math.sin(tick * 0.63 + stock.phase) * stock.amplitude;
  const secondaryWave = Math.sin(tick * 0.21 + stock.phase * 2.4) * stock.amplitude * 0.38;
  const drift = Math.sin(tick * 0.071 + stock.phase * 0.8) * 0.018;
  return Math.max(500, Math.round((stock.basePrice * (1 + primaryWave + secondaryWave + drift)) / 100) * 100);
}

function marketSnapshot(at = Date.now()) {
  const tick = marketTick(at);
  return MARKET_STOCKS.map((stock) => {
    const price = stockPriceAt(stock, tick);
    const previousPrice = stockPriceAt(stock, tick - 1);
    const history = Array.from({ length: 10 }, (_, index) => stockPriceAt(stock, tick - 9 + index));
    return { ...stock, price, previousPrice, history };
  });
}

function portfolioValues(portfolio, snapshot = marketSnapshot()) {
  const invested = snapshot.reduce((sum, stock) => sum + (portfolio.holdings?.[stock.id] || 0) * stock.price, 0);
  return { cash: portfolio.cash, invested, total: portfolio.cash + invested };
}

function addMarketTransaction(userId, type, details = {}) {
  state.db.marketTransactions.unshift({
    id: makeId(),
    userId,
    type,
    createdAt: new Date().toISOString(),
    ...details,
  });
  state.db.marketTransactions = state.db.marketTransactions.slice(0, 500);
}

function syncMarketReward(userId) {
  const user = state.db.users.find((item) => item.id === userId);
  if (!user || user.role === "admin") return false;
  const settings = state.db.marketSettings;
  const stampCount = repo.stampsForUser(userId).length;
  if (stampCount < settings.stampGoal) return false;
  const portfolio = ensurePortfolio(userId);
  if (portfolio.grantedAt) return false;
  portfolio.cash += settings.grantAmount;
  portfolio.grantedAt = new Date().toISOString();
  addMarketTransaction(userId, "grant", { amount: settings.grantAmount, stampCount });
  saveDb();
  return true;
}

function syncMarketQualification(userId) {
  const portfolio = repo.portfolioForUser(userId);
  if (!portfolio?.grantedAt || portfolio.qualifiedAt) return false;
  const stampCount = repo.stampsForUser(userId).length;
  const values = portfolioValues(portfolio);
  if (stampCount < state.db.marketSettings.stampGoal || values.total < state.db.marketSettings.prizeTarget) return false;
  portfolio.qualifiedAt = new Date().toISOString();
  addMarketTransaction(userId, "qualification", { amount: values.total });
  saveDb();
  return true;
}

function awardStamp(userId, boothId, source = "nfc") {
  if (repo.hasStamp(userId, boothId)) return { awarded: false, rewardGranted: false };
  state.db.stamps.push({
    id: makeId(),
    userId,
    boothId,
    source,
    createdAt: new Date().toISOString(),
  });
  saveDb();
  return { awarded: true, rewardGranted: syncMarketReward(userId) };
}

const nfcAdapter = {
  async scan(tagId) {
    const booth = state.db.booths.find((item) => item.nfcTagId === tagId);
    if (!booth) {
      state.loginError = `등록되지 않은 NFC 태그입니다: ${tagId}`;
      render();
      return;
    }
    if (!state.user) {
      state.pendingNfcTag = tagId;
      state.loginError = "NFC 태그가 인식되었습니다. 먼저 로그인하면 스탬프가 자동으로 찍힙니다.";
      render();
      return;
    }
    const result = awardStamp(state.user.id, booth.id);
    if (result.awarded) showStampPop(result.rewardGranted ? `${formatMoney(state.db.marketSettings.grantAmount)} ${state.db.marketSettings.currencyName} 지급` : "스탬프 획득");
    goDetail(booth.id);
  },
};

function icon(name) {
  const icons = {
    map: "⌖",
    stamp: "印",
    star: "★",
    back: "‹",
    admin: "⚙",
    heart: "♥",
  };
  return icons[name] || "";
}

let renderInProgress = false;
let marketRefreshTimer = null;
let lastMarketRefreshTick = null;

function render(options = {}) {
  if (renderInProgress) return;
  renderInProgress = true;
  const app = document.querySelector("#app");
  const preserveScroll = Boolean(options.preserveScroll);
  const previousScroll = preserveScroll ? { x: window.scrollX, y: window.scrollY } : null;
  try {
    if (state.user && state.user.role !== "admin") {
      syncMarketReward(state.user.id);
      syncMarketQualification(state.user.id);
    }
    const hasRenderedRoute = Boolean(app.dataset.route);
    const previousRoute = app.dataset.route || state.route;
    const nextRoute = state.route;
    const routeChanged = !hasRenderedRoute || previousRoute !== nextRoute;
    app.classList.toggle("route-change", routeChanged);
    app.classList.toggle("state-update", !routeChanged);
    if (state.route === "login") app.innerHTML = loginView();
    if (state.route === "map") app.innerHTML = mapView();
    if (state.route === "market") app.innerHTML = marketView();
    if (state.route === "wallet") app.innerHTML = walletView();
    if (state.route === "detail") app.innerHTML = detailView();
    if (state.route === "stamps") app.innerHTML = stampView();
    if (state.route === "admin") app.innerHTML = adminView();
    app.dataset.previousRoute = previousRoute;
    app.dataset.route = nextRoute;
    bindEvents();
    if (["market", "wallet"].includes(state.route)) lastMarketRefreshTick = marketTick();
    scheduleMarketRefresh();
    if (previousScroll) {
      requestAnimationFrame(() => window.scrollTo(previousScroll.x, previousScroll.y));
    }
  } finally {
    renderInProgress = false;
  }
}

function scheduleMarketRefresh() {
  if (marketRefreshTimer) clearTimeout(marketRefreshTimer);
  marketRefreshTimer = null;
  if (document.hidden || !state.user || !["market", "wallet"].includes(state.route)) return;
  const delay = MARKET_TICK_MS - (Date.now() % MARKET_TICK_MS) + 40;
  marketRefreshTimer = setTimeout(() => {
    marketRefreshTimer = null;
    if (document.hidden || !["market", "wallet"].includes(state.route)) return;
    if (document.activeElement?.matches("input, textarea, select")) {
      marketRefreshTimer = setTimeout(scheduleMarketRefresh, 600);
      return;
    }
    const nextTick = marketTick();
    if (nextTick !== lastMarketRefreshTick) render({ preserveScroll: true, reason: "market-tick" });
    else scheduleMarketRefresh();
  }, delay);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (marketRefreshTimer) clearTimeout(marketRefreshTimer);
    marketRefreshTimer = null;
    return;
  }
  if (!["market", "wallet"].includes(state.route)) return;
  if (marketTick() !== lastMarketRefreshTick) render({ preserveScroll: true, reason: "visibility" });
  else scheduleMarketRefresh();
});

function loginView() {
  const profileStep = state.authStep === "profile" && state.pendingGoogle;
  return `
    <main class="screen login-screen">
      <div>
        <div class="brand-mark">P</div>
        <h1 class="title">판교고 축제<br />스탬프 & 마켓</h1>
        <p class="subtitle">부스를 방문해 스탬프를 모으고, 받은 판교머니로 가상 투자에 도전하세요.</p>
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
      ${state.pendingNfcTag ? `<p class="success-text">NFC 태그 인식됨: ${state.pendingNfcTag}</p>` : ""}
      ${state.loginError ? `<p class="error-text">${state.loginError}</p>` : ""}
      <button id="googleLogin" type="button" class="primary-btn google-btn">G 구글 계정으로 계속</button>
      <button id="adminLogin" type="button" class="ghost-btn">관리자 모드로 계속</button>
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

function visibleBooths() {
  let booths = state.db.booths.filter((booth) => booth.floor === state.floor);
  if (state.search.trim()) {
    const term = state.search.trim().toLowerCase();
    booths = booths.filter((booth) => `${booth.name} ${booth.location}`.toLowerCase().includes(term));
  }
  return booths.sort((a, b) => {
    if (state.sort === "rating") return repo.avgRating(b.id) - repo.avgRating(a.id);
    return a.name.localeCompare(b.name, "ko");
  });
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
        <button type="button" class="plan-room ${item.type} booth-room ${visited ? "visited" : ""} ${selected ? "selected" : ""}" style="left:${item.x}%;top:${item.y}%;width:${item.w}%;height:${item.h}%;--stagger:${index * 12}ms" data-map-select="${booth.id}" aria-label="${booth.name}" title="${booth.name}">
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
  const floorInfo = FLOORS.find((item) => item.floor === state.floor);
  const plan = mapPlanForFloor(state.floor);
  const placedBoothIds = new Set(plan.rooms.map((item) => boothForPlanRoom(item, booths)?.id).filter(Boolean));
  const floatingBooths = booths.filter((booth) => !placedBoothIds.has(booth.id));
  const stampedCount = booths.filter((booth) => repo.hasStamp(state.user.id, booth.id)).length;
  const selectedBooth = booths.find((booth) => booth.id === state.selectedBoothId);
  return `
    <main class="map-screen ${state.sheetLevel === "full" ? "sheet-full" : ""}">
      <header class="top-bar">
        <button class="icon-btn" data-route="stamps" title="스탬프">${icon("stamp")}</button>
        <div class="top-title"><strong>판교고 축제 맵</strong><span>${floorInfo.label} · ${floorInfo.caption} · ${state.user?.name || ""}님</span></div>
        <button class="icon-btn map-search-action ${state.search ? "has-query" : ""}" id="mapSearchBtn" type="button" aria-label="부스 검색">
          <span>⌕</span>
          ${state.search ? `<b>${booths.length}</b>` : ""}
        </button>
        <button class="icon-btn" data-route="${state.user?.role === "admin" ? "admin" : "login"}" title="계정">${state.user?.role === "admin" ? icon("admin") : "G"}</button>
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
        <button class="sheet-handle" id="sheetToggle" aria-label="부스 목록 열기">
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
          <small class="sheet-hint">탭해서 목록 펼치기</small>
        </div>
        <div class="booth-list">${booths.length ? booths.map(boothItem).join("") : `<div class="empty-list">조건에 맞는 부스가 없습니다.</div>`}</div>
      </section>
      ${state.searchOpen ? searchOverlay(booths) : ""}
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
          <input id="searchScreenInput" class="input" placeholder="부스 이름이나 위치 검색" value="${state.search}" />
          ${state.search ? `<button id="clearSearchScreen" type="button" class="clear-search-btn" aria-label="검색어 지우기">×</button>` : ""}
        </div>
      </header>
      <div class="search-screen-controls">
        ${choiceSelect({
          id: "search-sort",
          label: state.sort === "rating" ? "별점순" : "이름순",
          caption: "정렬",
          options: [
            { label: "이름순", active: state.sort === "name", attr: `data-sort-option="name"` },
            { label: "별점순", active: state.sort === "rating", attr: `data-sort-option="rating"` },
          ],
        })}
      </div>
      <div class="search-result-meta">
        <strong>${booths.length}개 결과</strong>
        <span>${state.search ? `"${state.search}"` : "전체 부스"}</span>
      </div>
      <div class="search-result-list">
        ${booths.length ? booths.map(boothItem).join("") : `<div class="empty-list">조건에 맞는 부스가 없습니다.</div>`}
      </div>
    </section>
  `;
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
  const classes = ["marker", booth.category || "class"];
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
  const avg = repo.avgRating(booth.id).toFixed(1);
  const visits = repo.boothVisits(booth.id);
  return `
    <button class="booth-item ${booth.category || "class"} ${stamped ? "visited" : ""} ${selected ? "selected" : ""}" data-list-select="${booth.id}">
      <span class="booth-main">
        <strong>${booth.favorite ? icon("heart") + " " : ""}${booth.name}</strong>
        <span class="meta">${booth.location}</span>
        <span class="booth-stats"><i>${icon("star")} ${avg}</i><i>방문 ${visits}</i><i>${stamped ? "스탬프 완료" : "방문 전"}</i></span>
      </span>
      <span class="booth-state ${stamped ? "on" : ""}">${stamped ? "완료" : "대기"}</span>
      <span class="stamp ${stamped ? "on" : ""}">${icon("stamp")}</span>
    </button>
  `;
}

function mapPreviewCard(booth) {
  const stamped = repo.hasStamp(state.user.id, booth.id);
  const reviewed = repo.hasReview(state.user.id, booth.id);
  const reviewState = !stamped ? "방문 후 리뷰 가능" : reviewed ? "리뷰 완료" : "리뷰 가능";
  return `
    <article class="map-preview-card">
      <div>
        <strong>${booth.name}</strong>
        <span>${booth.location} · ${icon("star")} ${repo.avgRating(booth.id).toFixed(1)} · 방문 ${repo.boothVisits(booth.id)}</span>
        <span class="preview-status"><i class="${stamped ? "on" : ""}">${stamped ? "스탬프 획득" : "스탬프 미획득"}</i><i class="${stamped && !reviewed ? "on" : ""}">${reviewState}</i></span>
      </div>
      <button type="button" class="preview-detail-btn" data-detail="${booth.id}">${stamped ? "다시보기" : "상세"}</button>
      <button type="button" class="preview-close-btn" data-clear-selection aria-label="선택 해제">×</button>
    </article>
  `;
}

function detailView() {
  const booth = state.db.booths.find((item) => item.id === state.selectedBoothId) || state.db.booths[0];
  const stamped = repo.hasStamp(state.user.id, booth.id);
  const reviewed = repo.hasReview(state.user.id, booth.id);
  const reviews = state.db.reviews.filter((review) => review.boothId === booth.id);
  return `
    <main class="screen detail-screen">
      <header class="top-bar">
        <button class="icon-btn" data-route="map">${icon("back")}</button>
        <div class="top-title"><strong>부스 상세</strong><span>${booth.location}</span></div>
        <button class="icon-btn" data-nfc="${booth.nfcTagId}" title="NFC 테스트">NFC</button>
      </header>
      <section class="detail-hero">
        <div class="meta">${booth.floor}층 · ${booth.location}</div>
        <h1 class="title">${booth.name}</h1>
        <div class="meta">${icon("star")} ${repo.avgRating(booth.id).toFixed(1)} · 리뷰 ${reviews.length}개 · <span class="stamp ${stamped ? "on" : ""}">${icon("stamp")}</span></div>
      </section>
      <section class="panel section">
        <h2>부스 소개</h2>
        <p class="subtitle">${booth.description}</p>
      </section>
      <section class="panel section">
        <h2>리뷰 작성</h2>
        ${!stamped ? `<p class="notice">부스를 방문해야 리뷰를 작성할 수 있습니다.</p>` : ""}
        ${reviewed ? `<p class="notice">이미 이 부스에 리뷰를 작성했습니다.</p>` : reviewForm(stamped)}
      </section>
      <section class="panel section">
        <h2>리뷰 목록</h2>
        ${reviews.length ? reviews.map(reviewView).join("") : `<p class="subtitle">아직 리뷰가 없습니다.</p>`}
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
  const adminPreview = Boolean(state.adminPreviewAdminId);
  const count = repo.stampsForUser(state.user.id).length;
  const total = state.db.booths.length;
  const settings = state.db.marketSettings;
  const portfolio = repo.portfolioForUser(state.user.id);
  const remain = Math.max(settings.stampGoal - count, 0);
  const percent = Math.min((count / settings.stampGoal) * 100, 100);
  return `
    <main class="screen stamp-screen">
      <header class="top-bar">
        ${adminPreview ? `<button class="icon-btn" data-admin-preview-exit title="관리자로 돌아가기">${icon("back")}</button>` : `<button class="icon-btn" data-route="map">${icon("back")}</button>`}
        <div class="top-title"><strong>${adminPreview ? "테스트 스탬프" : "스탬프 현황"}</strong><span>목표 ${settings.stampGoal}개 달성 시 투자금 지급</span></div>
        <button class="icon-btn top-money-btn" data-route="market" title="투자">원</button>
      </header>
      <section class="panel stamp-reward-panel">
        <span class="section-kicker">STAMP REWARD</span>
        <h1 class="title">현재 ${count}개 획득</h1>
        <p class="subtitle">전체 ${total}개 중 ${count}개를 모았습니다.</p>
        <div class="progress-wrap"><div class="progress" style="width:${percent}%"></div></div>
        <p class="notice">${remain ? `투자금 지급까지 ${remain}개 남았습니다.` : `${formatMoney(settings.grantAmount)} ${settings.currencyName} 지급 완료`}</p>
        ${portfolio?.grantedAt ? `<button type="button" class="primary-btn stamp-market-cta" data-route="market">판교마켓 시작</button>` : ""}
      </section>
      <section class="section stats-grid">
        ${state.db.booths.map((booth) => `<div class="stat"><strong class="stamp ${repo.hasStamp(state.user.id, booth.id) ? "on" : ""}">${icon("stamp")}</strong><span>${booth.name}</span></div>`).join("")}
      </section>
      ${bottomNav("stamps")}
    </main>
  `;
}

function marketTrend(stock) {
  const change = stock.price - stock.previousPrice;
  const rate = stock.previousPrice ? (change / stock.previousPrice) * 100 : 0;
  return {
    change,
    rate,
    className: change > 0 ? "up" : change < 0 ? "down" : "flat",
    label: `${change > 0 ? "+" : ""}${formatMoney(change)} (${change > 0 ? "+" : ""}${rate.toFixed(1)}%)`,
  };
}

function marketChart(stock, large = false) {
  const min = Math.min(...stock.history);
  const max = Math.max(...stock.history);
  const range = Math.max(max - min, 1);
  return `
    <div class="market-chart ${large ? "large" : ""}" aria-label="${stock.name} 최근 시세">
      ${stock.history.map((price, index) => {
        const height = 24 + ((price - min) / range) * (large ? 48 : 24);
        const previous = index ? stock.history[index - 1] : price;
        return `<i class="${price >= previous ? "up" : "down"}" style="height:${height}px"></i>`;
      }).join("")}
    </div>
  `;
}

function marketGoalStrip(values, portfolio) {
  const settings = state.db.marketSettings;
  const percent = Math.min(100, Math.round((values.total / settings.prizeTarget) * 100));
  return `
    <section class="market-goal-strip ${portfolio.qualifiedAt ? "complete" : ""}">
      <div><span>${portfolio.qualifiedAt ? "상품 교환 자격 달성" : "상품 목표"}</span><strong>${formatMoney(values.total)} / ${formatMoney(settings.prizeTarget)}원</strong></div>
      <div class="mini-progress"><span style="width:${percent}%"></span></div>
    </section>
  `;
}

function marketView() {
  const adminPreview = Boolean(state.adminPreviewAdminId);
  const settings = state.db.marketSettings;
  const stampCount = repo.stampsForUser(state.user.id).length;
  const portfolio = repo.portfolioForUser(state.user.id) || ensurePortfolio(state.user.id);
  const snapshot = marketSnapshot();
  const selected = snapshot.find((stock) => stock.id === state.marketStockId) || snapshot[0];
  const values = portfolioValues(portfolio, snapshot);
  const selectedTrend = marketTrend(selected);
  const quantity = Math.max(1, Math.floor(Number(state.marketQuantity) || 1));
  const tradeAmount = selected.price * quantity;
  const owned = portfolio.holdings?.[selected.id] || 0;
  const tradingLocked = !portfolio.grantedAt || Boolean(portfolio.qualifiedAt);

  return `
    <main class="screen market-screen">
      <header class="top-bar">
        ${adminPreview ? `<button class="icon-btn" data-admin-preview-exit title="관리자로 돌아가기">${icon("back")}</button>` : `<button class="icon-btn" data-route="map">${icon("back")}</button>`}
        <div class="top-title"><strong>${adminPreview ? "관리자 투자 테스트" : "판교마켓"}</strong><span>${adminPreview ? "테스트 학생 포트폴리오" : "축제 가상 주식 투자"}</span></div>
        <button class="icon-btn top-money-btn" data-route="wallet" title="내 자산">원</button>
      </header>
      ${!portfolio.grantedAt ? `
        <section class="market-gate market-gate-compact">
          <span class="section-kicker">MARKET PASS</span>
          <h1>스탬프 ${settings.stampGoal}개로<br />투자를 시작하세요</h1>
          <p>현재 ${stampCount}개를 모았습니다.</p>
          <div class="progress-wrap"><div class="progress" style="width:${Math.min(100, (stampCount / settings.stampGoal) * 100)}%"></div></div>
          <strong>${formatMoney(settings.grantAmount)} ${settings.currencyName}</strong>
          <button type="button" class="primary-btn" data-route="stamps">스탬프 확인</button>
        </section>
        <section class="market-section locked-market-preview">
          <div class="market-section-head"><div><span class="section-kicker">MARKET PREVIEW</span><h2>투자 종목 미리보기</h2></div><span>거래 전 조회 가능</span></div>
          <div class="market-stock-list">
            ${snapshot.map((stock) => {
              const trend = marketTrend(stock);
              return `
                <article class="market-stock-row market-stock-readonly" style="--stock-color:${stock.color}">
                  <span class="stock-symbol">${stock.symbol.slice(0, 1)}</span>
                  <span class="stock-copy"><strong>${stock.name}</strong><small>${stock.description}</small></span>
                  ${marketChart(stock)}
                  <span class="stock-price"><strong>${formatMoney(stock.price)}원</strong><small class="${trend.className}">${trend.label}</small></span>
                </article>
              `;
            }).join("")}
          </div>
          <p class="locked-market-note">스탬프 ${settings.stampGoal}개를 모으면 ${formatMoney(settings.grantAmount)} ${settings.currencyName}로 거래할 수 있습니다.</p>
        </section>
      ` : `
        <section class="market-balance">
          <div><span>총 자산</span><strong>${formatMoney(values.total)}원</strong></div>
          <dl><div><dt>보유 현금</dt><dd>${formatMoney(values.cash)}원</dd></div><div><dt>주식 평가액</dt><dd>${formatMoney(values.invested)}원</dd></div></dl>
        </section>
        ${marketGoalStrip(values, portfolio)}
        ${portfolio.qualifiedAt ? `<section class="qualification-banner"><strong>상품 교환 자격을 달성했습니다</strong><span>투자가 종료되어 자산이 고정되었습니다.</span><button type="button" class="ghost-btn" data-route="wallet">교환 상태 보기</button></section>` : ""}
        <section class="market-section">
          <div class="market-section-head"><div><span class="section-kicker">LIVE MARKET</span><h2>종목</h2></div><span>실시간 시세</span></div>
          <div class="market-stock-list">
            ${snapshot.map((stock) => {
              const trend = marketTrend(stock);
              return `
                <button type="button" class="market-stock-row ${selected.id === stock.id ? "active" : ""}" data-market-stock="${stock.id}" style="--stock-color:${stock.color}">
                  <span class="stock-symbol">${stock.symbol.slice(0, 1)}</span>
                  <span class="stock-copy"><strong>${stock.name}</strong><small>${stock.description}</small></span>
                  ${marketChart(stock)}
                  <span class="stock-price"><strong>${formatMoney(stock.price)}원</strong><small class="${trend.className}">${trend.label}</small></span>
                </button>
              `;
            }).join("")}
          </div>
        </section>
        <section class="trade-panel" style="--stock-color:${selected.color}">
          <div class="trade-heading">
            <div><span class="stock-symbol">${selected.symbol.slice(0, 1)}</span><span><strong>${selected.name}</strong><small>보유 ${owned}주</small></span></div>
            <div><strong>${formatMoney(selected.price)}원</strong><small class="${selectedTrend.className}">${selectedTrend.label}</small></div>
          </div>
          ${marketChart(selected, true)}
          <div class="trade-controls">
            <span>수량</span>
            <div class="quantity-control">
              <button type="button" data-market-quantity="-1" aria-label="수량 줄이기">−</button>
              <input id="marketQuantity" type="number" min="1" max="99" inputmode="numeric" value="${quantity}" />
              <button type="button" data-market-quantity="1" aria-label="수량 늘리기">+</button>
            </div>
          </div>
          <div class="trade-total"><span>주문 금액</span><strong>${formatMoney(tradeAmount)}원</strong></div>
          ${state.marketMessage ? `<p class="market-message">${state.marketMessage}</p>` : ""}
          <div class="trade-actions">
            <button id="marketSell" type="button" class="sell-btn" ${tradingLocked || owned < quantity ? "disabled" : ""}>매도</button>
            <button id="marketBuy" type="button" class="buy-btn" ${tradingLocked || values.cash < tradeAmount ? "disabled" : ""}>매수</button>
          </div>
        </section>
      `}
      ${bottomNav("market")}
    </main>
  `;
}

function transactionCopy(transaction) {
  const stock = MARKET_STOCKS.find((item) => item.id === transaction.stockId);
  if (transaction.type === "grant") return { title: "스탬프 투자금 지급", detail: `+${formatMoney(transaction.amount)} ${state.db.marketSettings.currencyName}` };
  if (transaction.type === "qualification") return { title: "상품 교환 자격 달성", detail: `${formatMoney(transaction.amount)}원` };
  if (transaction.type === "buy") return { title: `${stock?.name || "주식"} 매수`, detail: `${transaction.quantity}주 · -${formatMoney(transaction.amount)}원` };
  if (transaction.type === "sell") return { title: `${stock?.name || "주식"} 매도`, detail: `${transaction.quantity}주 · +${formatMoney(transaction.amount)}원` };
  if (transaction.type === "exchange") return { title: "상품 교환 완료", detail: "재사용 불가" };
  return { title: "거래", detail: `${formatMoney(transaction.amount || 0)}원` };
}

function transactionRows(transactions, emptyText = "아직 거래 내역이 없습니다.") {
  if (!transactions.length) return `<p class="empty-copy">${emptyText}</p>`;
  return transactions.map((transaction) => {
    const copy = transactionCopy(transaction);
    return `<div class="transaction-row"><span><strong>${copy.title}</strong><small>${new Date(transaction.createdAt).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</small></span><em>${copy.detail}</em></div>`;
  }).join("");
}

function walletView() {
  const adminPreview = Boolean(state.adminPreviewAdminId);
  const settings = state.db.marketSettings;
  const user = state.db.users.find((item) => item.id === state.user.id);
  const portfolio = repo.portfolioForUser(state.user.id) || ensurePortfolio(state.user.id);
  const snapshot = marketSnapshot();
  const values = portfolioValues(portfolio, snapshot);
  const holdings = snapshot.filter((stock) => (portfolio.holdings?.[stock.id] || 0) > 0);
  const transactions = repo.marketTransactionsForUser(state.user.id).slice(0, 8);

  return `
    <main class="screen wallet-screen">
      <header class="top-bar">
        <button class="icon-btn" data-route="market">${icon("back")}</button>
        <div class="top-title"><strong>${adminPreview ? "테스트 자산" : "내 자산"}</strong><span>${settings.currencyName} 포트폴리오</span></div>
        <button class="icon-btn" data-route="stamps" title="스탬프">${icon("stamp")}</button>
      </header>
      <section class="wallet-hero ${portfolio.qualifiedAt ? "complete" : ""}">
        <span>${portfolio.grantedAt ? "총 자산" : "투자 준비 중"}</span>
        <h1>${portfolio.grantedAt ? `${formatMoney(values.total)}원` : "스탬프를 모아주세요"}</h1>
        <div class="wallet-asset-grid"><div><span>현금</span><strong>${formatMoney(values.cash)}원</strong></div><div><span>주식</span><strong>${formatMoney(values.invested)}원</strong></div></div>
      </section>
      ${portfolio.grantedAt ? marketGoalStrip(values, portfolio) : ""}
      <section class="prize-status ${user?.exchangedAt ? "exchanged" : portfolio.qualifiedAt ? "ready" : "waiting"}">
        <span class="prize-status-mark">${user?.exchangedAt ? "완" : portfolio.qualifiedAt ? "성" : "목"}</span>
        <div><strong>${user?.exchangedAt ? "상품 교환 완료" : portfolio.qualifiedAt ? "상품 교환 가능" : `목표 자산 ${formatMoney(settings.prizeTarget)}원`}</strong><p>${user?.exchangedAt ? "이미 교환 처리되어 다시 사용할 수 없습니다." : portfolio.qualifiedAt ? "운영 부스에서 관리자에게 이 화면을 보여주세요." : `목표까지 ${formatMoney(Math.max(settings.prizeTarget - values.total, 0))}원 남았습니다.`}</p></div>
      </section>
      <section class="wallet-section">
        <div class="market-section-head"><div><span class="section-kicker">PORTFOLIO</span><h2>보유 종목</h2></div><span>${holdings.length}종목</span></div>
        <div class="holding-list">
          ${holdings.length ? holdings.map((stock) => {
            const quantity = portfolio.holdings[stock.id];
            return `<div class="holding-row" style="--stock-color:${stock.color}"><span class="stock-symbol">${stock.symbol.slice(0, 1)}</span><span><strong>${stock.name}</strong><small>${quantity}주 · 현재 ${formatMoney(stock.price)}원</small></span><em>${formatMoney(quantity * stock.price)}원</em></div>`;
          }).join("") : `<p class="empty-copy">보유한 주식이 없습니다.</p>`}
        </div>
      </section>
      <section class="wallet-section">
        <div class="market-section-head"><div><span class="section-kicker">HISTORY</span><h2>거래 내역</h2></div></div>
        <div class="transaction-list">${transactionRows(transactions)}</div>
      </section>
      ${bottomNav("wallet")}
    </main>
  `;
}

function adminView() {
  const tabs = [
    ["dashboard", "현황"],
    ["booths", "부스/NFC"],
    ["reviews", "리뷰"],
    ["users", "참여자"],
  ];
  const currentTab = tabs.find(([id]) => id === state.adminTab) || tabs[0];
  return `
    <main class="screen admin-screen">
      <header class="top-bar">
        <button class="icon-btn" data-route="map">${icon("back")}</button>
        <div class="top-title"><strong>관리자 패널</strong><span>부스, 투자 보상, 상품 교환 관리</span></div>
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
  const settings = state.db.marketSettings;
  const testUser = state.db.users.find((user) => user.googleUid === ADMIN_TEST_USER_UID) || null;
  const testStampCount = testUser ? repo.stampsForUser(testUser.id).length : 0;
  const testPortfolio = testUser ? repo.portfolioForUser(testUser.id) : null;
  const nextTestBooth = state.db.booths.find((booth) => !testUser || !repo.hasStamp(testUser.id, booth.id)) || state.db.booths[0];
  const regularUsers = state.db.users.filter((user) => user.role !== "admin" && user.googleUid !== ADMIN_TEST_USER_UID);
  const investingUsers = regularUsers.filter((user) => repo.portfolioForUser(user.id)?.grantedAt);
  const achievedUsers = regularUsers.filter((user) => repo.portfolioForUser(user.id)?.qualifiedAt);
  const pendingExchange = achievedUsers.filter((user) => !user.exchangedAt);
  const totalVisits = state.db.stamps.filter((stamp) => stamp.source !== "admin-test").length;
  const totalReviews = state.db.reviews.length;
  const reviewAverage = totalReviews
    ? state.db.reviews.reduce((sum, review) => sum + Number(review.rating), 0) / totalReviews
    : 0;

  if (state.adminTab === "dashboard") {
    const top = [...state.db.booths].sort((a, b) => repo.boothVisits(b.id) - repo.boothVisits(a.id)).slice(0, 5);
    return `
      <section class="admin-hero">
        <span class="admin-eyebrow">Festival Control</span>
        <h1>운영 현황</h1>
        <p>방문 인증부터 투자금 지급, 상품 교환 대상까지 한 화면에서 확인합니다.</p>
      </section>
      <section class="stats-grid admin-stats">
        <div class="stat"><span>총 방문 인증</span><strong>${totalVisits}</strong><small>스탬프 발급 수</small></div>
        <div class="stat"><span>총 리뷰</span><strong>${totalReviews}</strong><small>평균 ${reviewAverage.toFixed(1)}점</small></div>
        <div class="stat"><span>투자 시작</span><strong>${investingUsers.length}</strong><small>전체 참여자 ${regularUsers.length}명</small></div>
        <div class="stat ${pendingExchange.length ? "warn" : ""}"><span>상품 교환 대기</span><strong>${pendingExchange.length}</strong><small>목표 자산 달성</small></div>
      </section>
      <section class="panel section admin-panel-card market-settings-panel">
        <div class="admin-section-head"><h2>투자 보상 기준</h2><span>축제 운영 설정</span></div>
        ${state.adminMessage ? `<p class="success-text">${state.adminMessage}</p>` : ""}
        <div class="market-settings-grid">
          <label class="field">필요 스탬프 수<input id="marketStampGoal" class="input" type="number" min="1" max="${state.db.booths.length}" inputmode="numeric" value="${settings.stampGoal}" /></label>
          <label class="field">지급 투자금<input id="marketGrantAmount" class="input" type="number" min="1000" step="1000" inputmode="numeric" value="${settings.grantAmount}" /></label>
          <label class="field">상품 목표 자산<input id="marketPrizeTarget" class="input" type="number" min="1000" step="1000" inputmode="numeric" value="${settings.prizeTarget}" /></label>
        </div>
        <button id="saveMarketSettings" type="button" class="primary-btn">보상 기준 저장</button>
      </section>
      <section class="panel section admin-panel-card admin-test-panel">
        <div class="admin-section-head"><h2>테스트 스탬프</h2><span>운영 통계 제외</span></div>
        ${state.adminTestMessage ? `<p class="success-text">${state.adminTestMessage}</p>` : ""}
        <div class="test-tool-status">
          <strong class="stamp ${testStampCount ? "on" : ""}">${icon("stamp")}</strong>
          <span><b>테스트 학생 · ${testStampCount}/${settings.stampGoal}개</b><small>${testPortfolio?.grantedAt ? `${formatMoney(testPortfolio.cash)} ${settings.currencyName} 보유` : `투자금 지급까지 ${Math.max(settings.stampGoal - testStampCount, 0)}개`}</small></span>
        </div>
        <label class="field">스탬프를 찍을 부스
          <select id="adminTestBooth" class="select">
            ${state.db.booths.map((booth) => `<option value="${booth.id}" ${booth.id === nextTestBooth?.id ? "selected" : ""}>${booth.name} · ${booth.location}</option>`).join("")}
          </select>
        </label>
        <div class="admin-test-actions">
          <button id="adminTestStamp" type="button" class="primary-btn">테스트 스탬프 찍기</button>
          <button id="adminOpenTestMarket" type="button" class="ghost-btn market-test-open">테스트 투자 화면 열기</button>
          <button id="resetAdminTestStamps" type="button" class="ghost-btn" ${testUser ? "" : "disabled"}>테스트 기록 초기화</button>
        </div>
      </section>
      <section class="panel section admin-panel-card">
        <div class="admin-section-head"><h2>인기 부스 TOP 5</h2><span>방문수 기준</span></div>
        ${top.map((booth, index) => `<div class="rank-row"><b>${index + 1}</b><span><strong>${booth.name}</strong><small>${booth.location}</small></span><em>방문 ${repo.boothVisits(booth.id)} · ${repo.avgRating(booth.id).toFixed(1)}점</em></div>`).join("")}
      </section>
      <section class="panel section admin-panel-card">
        <div class="admin-section-head"><h2>운영 체크</h2><span>빠른 점검</span></div>
        <div class="check-row ${state.db.booths.every((booth) => booth.nfcTagId) ? "ok" : "warn"}"><strong>NFC 태그</strong><span>${state.db.booths.filter((booth) => booth.nfcTagId).length}/${state.db.booths.length}개 등록</span></div>
        <div class="check-row ${pendingExchange.length ? "warn" : "ok"}"><strong>상품 교환</strong><span>${pendingExchange.length ? `${pendingExchange.length}명 처리 필요` : "대기자 없음"}</span></div>
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
  if (state.adminTab === "reviews") {
    if (!state.db.reviews.length) return adminEmpty("아직 리뷰가 없습니다.", "스탬프를 받은 사용자가 리뷰를 작성하면 여기에 표시됩니다.");
    return `<section class="admin-table">${state.db.reviews.map(reviewRow).join("")}</section>`;
  }
  if (!regularUsers.length) return adminEmpty("아직 참여자가 없습니다.", "사용자가 로그인하고 학생 정보를 등록하면 여기에 표시됩니다.");
  return `<section class="admin-table">${regularUsers.map(userRow).join("")}</section>`;
}

function boothAdminRow(booth) {
  const visits = repo.boothVisits(booth.id);
  const rating = repo.avgRating(booth.id).toFixed(1);
  return `
    <div class="table-row admin-row">
      <div class="row-main">
        <strong>${booth.name}</strong>
        <p class="subtitle">${booth.floor}층 · ${booth.location}</p>
      </div>
      <div class="row-metrics"><span>방문 ${visits}</span><span>평점 ${rating}</span></div>
      <label class="field compact-field">NFC 태그 ID
        <input class="input" id="nfc-${booth.id}" value="${booth.nfcTagId}" />
      </label>
      <div class="row-actions">
        <button type="button" class="ghost-btn" data-save-nfc="${booth.id}">태그 저장</button>
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
  const settings = state.db.marketSettings;
  const stampCount = repo.stampsForUser(user.id).length;
  const progress = Math.min(100, Math.round((stampCount / settings.stampGoal) * 100));
  const portfolio = repo.portfolioForUser(user.id);
  const values = portfolio?.grantedAt ? portfolioValues(portfolio) : null;
  const qualified = Boolean(portfolio?.qualifiedAt);
  const status = user.exchangedAt ? "교환 완료" : qualified ? "교환 가능" : portfolio?.grantedAt ? "투자 중" : "스탬프 수집 중";
  return `
    <div class="table-row admin-row">
      <div class="row-main">
        <strong>${user.name}</strong>
        <p class="subtitle">${user.studentNumber} · ${user.schoolId} · ${user.googleEmail || "Google 미연동"}</p>
      </div>
      <div class="mini-progress"><span style="width:${progress}%"></span></div>
      <div class="row-metrics"><span>스탬프 ${stampCount}/${settings.stampGoal}</span><span>${values ? `자산 ${formatMoney(values.total)}원` : status}</span><span>${status}</span></div>
      <button type="button" class="ghost-btn exchange-btn" data-exchange="${user.id}" ${!qualified || user.exchangedAt ? "disabled" : ""}>${user.exchangedAt ? "상품 교환 완료" : "상품 교환 완료 처리"}</button>
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
  if (state.adminPreviewAdminId) {
    return `
      <nav class="bottom-nav admin-preview-nav">
        <button class="nav-btn ${active === "market" ? "active" : ""}" data-route="market"><span class="nav-letter">투</span><span>투자</span></button>
        <button class="nav-btn ${active === "wallet" ? "active" : ""}" data-route="wallet"><span class="nav-letter">원</span><span>자산</span></button>
        <button class="nav-btn ${active === "stamps" ? "active" : ""}" data-route="stamps"><span>${icon("stamp")}</span><span>스탬프</span></button>
        <button class="nav-btn admin-return-nav" data-admin-preview-exit><span>${icon("admin")}</span><span>관리</span></button>
      </nav>
    `;
  }
  if (state.user?.role === "admin") {
    return `
      <nav class="bottom-nav admin-bottom-nav">
        <button class="nav-btn ${active === "map" ? "active" : ""}" data-route="map"><span>${icon("map")}</span><span>지도</span></button>
        <button class="nav-btn ${active === "admin" ? "active" : ""}" data-route="admin"><span>${icon("admin")}</span><span>관리</span></button>
      </nav>
    `;
  }
  return `
    <nav class="bottom-nav">
      <button class="nav-btn ${active === "map" ? "active" : ""}" data-route="map"><span>${icon("map")}</span><span>지도</span></button>
      <button class="nav-btn ${active === "market" ? "active" : ""}" data-route="market"><span class="nav-letter">투</span><span>투자</span></button>
      <button class="nav-btn ${active === "wallet" ? "active" : ""}" data-route="wallet"><span class="nav-letter">원</span><span>자산</span></button>
      <button class="nav-btn ${active === "stamps" ? "active" : ""}" data-route="stamps"><span>${icon("stamp")}</span><span>스탬프</span></button>
    </nav>
  `;
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
        state.route = "login";
        state.loginError = "관리자 계정으로 로그인해야 접근할 수 있습니다.";
        render();
        return;
      }
      state.route = button.dataset.route;
      if (state.route === "login") resetLogin();
      render();
    });
  });
  document.querySelector("#googleLogin")?.addEventListener("click", () => startGoogleLogin("student"));
  document.querySelector("#profileSubmit")?.addEventListener("click", completeProfile);
  document.querySelector("#backToGoogle")?.addEventListener("click", () => {
    resetLogin();
    render();
  });
  document.querySelector("#adminLogin")?.addEventListener("click", adminLogin);
  document.querySelectorAll("[data-floor]").forEach((button) => button.addEventListener("click", () => {
    closeMenus();
    state.floor = Number(button.dataset.floor);
    state.sheetOpen = false;
    state.sheetLevel = "peek";
    state.mapZoom = 1;
    state.mapOffsetX = 0;
    state.mapOffsetY = 0;
    state.searchOpen = false;
    render();
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
    state.searchOpen = false;
    closeMenus();
    render();
  });
  bindMapDrag();
  bindSheetDrag();
  document.querySelector("#searchScreenInput")?.addEventListener("input", (event) => {
    state.search = event.target.value;
    state.searchOpen = true;
    render();
    focusSearchInput();
  });
  document.querySelector("#clearEmptySearch")?.addEventListener("click", () => {
    state.search = "";
    setSheetLevel("full");
    render();
  });
  document.querySelector("#clearSearchScreen")?.addEventListener("click", () => {
    state.search = "";
    state.searchOpen = true;
    render();
    focusSearchInput();
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
    render();
  });
  document.querySelectorAll("[data-list-select]").forEach((button) => button.addEventListener("click", () => {
    goDetail(button.dataset.listSelect);
  }));
  document.querySelectorAll("[data-clear-selection]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      state.selectedBoothId = null;
      state.mapZoom = 1;
      state.mapOffsetX = 0;
      state.mapOffsetY = 0;
      render();
    });
  });
  document.querySelectorAll("[data-detail]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    goDetail(button.dataset.detail);
  }));
  document.querySelectorAll("[data-nfc]").forEach((button) => button.addEventListener("click", () => nfcAdapter.scan(button.dataset.nfc)));
  document.querySelectorAll("[data-rating]").forEach((button) => button.addEventListener("click", () => {
    state.reviewRating = Number(button.dataset.rating);
    render();
  }));
  document.querySelector("#submitReview")?.addEventListener("click", submitReview);
  document.querySelectorAll("[data-market-stock]").forEach((button) => button.addEventListener("click", () => {
    state.marketStockId = button.dataset.marketStock;
    state.marketQuantity = 1;
    state.marketMessage = "";
    render();
  }));
  document.querySelectorAll("[data-market-quantity]").forEach((button) => button.addEventListener("click", () => {
    const next = Number(state.marketQuantity) + Number(button.dataset.marketQuantity);
    state.marketQuantity = Math.min(99, Math.max(1, Math.floor(next || 1)));
    state.marketMessage = "";
    render();
  }));
  document.querySelector("#marketQuantity")?.addEventListener("change", (event) => {
    state.marketQuantity = Math.min(99, Math.max(1, Math.floor(Number(event.target.value) || 1)));
    state.marketMessage = "";
    render();
  });
  document.querySelector("#marketBuy")?.addEventListener("click", () => marketTrade("buy"));
  document.querySelector("#marketSell")?.addEventListener("click", () => marketTrade("sell"));
  document.querySelectorAll("[data-admin-tab]").forEach((button) => button.addEventListener("click", () => {
    closeMenus();
    state.adminTab = button.dataset.adminTab;
    render();
  }));
  document.querySelector("#addBooth")?.addEventListener("click", addBooth);
  document.querySelectorAll("[data-delete-booth]").forEach((button) => button.addEventListener("click", () => deleteBooth(button.dataset.deleteBooth)));
  document.querySelectorAll("[data-save-nfc]").forEach((button) => button.addEventListener("click", () => saveNfcTag(button.dataset.saveNfc)));
  document.querySelectorAll("[data-test-nfc]").forEach((button) => button.addEventListener("click", () => testNfcTag(button.dataset.testNfc)));
  document.querySelectorAll("[data-delete-review]").forEach((button) => button.addEventListener("click", () => deleteReview(button.dataset.deleteReview)));
  document.querySelectorAll("[data-exchange]").forEach((button) => button.addEventListener("click", () => completeExchange(button.dataset.exchange)));
  document.querySelector("#saveMarketSettings")?.addEventListener("click", saveMarketSettings);
  document.querySelector("#adminTestStamp")?.addEventListener("click", issueAdminTestStamp);
  document.querySelector("#adminOpenTestMarket")?.addEventListener("click", enterAdminTestMarket);
  document.querySelector("#resetAdminTestStamps")?.addEventListener("click", resetAdminTestStamps);
  document.querySelectorAll("[data-admin-preview-exit]").forEach((button) => button.addEventListener("click", exitAdminTestMarket));
}

function closeMenus() {
  state.openMenu = null;
}

function openSearchScreen() {
  state.searchOpen = true;
  closeMenus();
  render();
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
  let startTranslate = 0;
  let currentTranslate = 0;
  let dragging = false;
  let peekTarget = 0;
  let midTarget = 0;
  let paintFrame = 0;
  let pendingTranslate = 0;

  const measureTargets = () => {
    peekTarget = Math.max(0, sheet.getBoundingClientRect().height - 132);
    midTarget = Math.round(window.innerHeight * 0.34);
  };
  const translateForLevel = (level) => {
    if (level === "full") return 0;
    if (level === "mid") return midTarget;
    return peekTarget;
  };
  const clampTranslate = (value) => Math.min(peekTarget, Math.max(0, value));
  const queuePaint = (translate) => {
    pendingTranslate = translate;
    if (paintFrame) return;
    paintFrame = requestAnimationFrame(() => {
      paintFrame = 0;
      sheet.style.transform = `translateY(${pendingTranslate}px)`;
    });
  };

  const finish = () => {
    if (!dragging) return;
    if (paintFrame) cancelAnimationFrame(paintFrame);
    paintFrame = 0;
    const targets = [
      ["full", 0],
      ["mid", midTarget],
      ["peek", peekTarget],
    ];
    const [level] = targets.reduce((best, item) => (
      Math.abs(item[1] - currentTranslate) < Math.abs(best[1] - currentTranslate) ? item : best
    ), targets[0]);
    setSheetLevel(level);
    dragging = false;
    sheet.classList.remove("dragging");
    sheet.style.transform = "";
    render();
  };

  handle.addEventListener("pointerdown", (event) => {
    measureTargets();
    dragging = true;
    startY = event.clientY;
    startTranslate = translateForLevel(state.sheetLevel);
    currentTranslate = startTranslate;
    sheet.classList.add("dragging");
    handle.setPointerCapture?.(event.pointerId);
  });
  handle.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    currentTranslate = clampTranslate(startTranslate + event.clientY - startY);
    queuePaint(currentTranslate);
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
  state.adminPreviewAdminId = null;
  state.authStep = "google";
  state.pendingGoogle = null;
  state.authIntent = "student";
  state.loginBusy = false;
  state.loginError = "";
  state.openMenu = null;
}

function startGoogleLogin(intent = "student") {
  state.authIntent = intent;
  state.loginError = "";
  state.loginBusy = false;
  try {
    state.pendingGoogle = authProvider.signInWithGoogle();
    if (intent === "admin") {
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
    state.route = "map";
    state.loginError = "";
    state.openMenu = null;
    render();
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
  state.route = "map";
  state.loginError = "";
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
  state.adminPreviewAdminId = null;
  state.user = admin;
  state.route = "admin";
  state.loginError = "";
  state.openMenu = null;
  render();
}

function consumePendingNfc() {
  if (!state.pendingNfcTag || !state.user) return;
  const tagId = state.pendingNfcTag;
  state.pendingNfcTag = "";
  nfcAdapter.scan(tagId);
}

function goDetail(id) {
  state.selectedBoothId = id;
  state.route = "detail";
  state.searchOpen = false;
  state.sheetOpen = false;
  state.sheetLevel = "peek";
  state.openMenu = null;
  render();
}

function selectMapBooth(id) {
  state.selectedBoothId = id;
  state.searchOpen = false;
  if (state.sheetLevel === "full") setSheetLevel("mid");
  state.openMenu = null;
  render();
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

function marketTrade(type) {
  const portfolio = ensurePortfolio(state.user.id);
  if (!portfolio.grantedAt) {
    state.marketMessage = "스탬프 목표를 달성하면 거래할 수 있습니다.";
    render();
    return;
  }
  if (portfolio.qualifiedAt) {
    state.marketMessage = "상품 교환 자격을 달성해 자산이 고정되었습니다.";
    render();
    return;
  }

  const snapshot = marketSnapshot();
  const stock = snapshot.find((item) => item.id === state.marketStockId) || snapshot[0];
  const quantity = Math.min(99, Math.max(1, Math.floor(Number(state.marketQuantity) || 1)));
  const amount = stock.price * quantity;
  const owned = portfolio.holdings[stock.id] || 0;

  if (type === "buy" && portfolio.cash < amount) {
    state.marketMessage = "보유 현금이 부족합니다.";
    render();
    return;
  }
  if (type === "sell" && owned < quantity) {
    state.marketMessage = "보유 수량이 부족합니다.";
    render();
    return;
  }

  if (type === "buy") {
    portfolio.cash -= amount;
    portfolio.holdings[stock.id] = owned + quantity;
  } else {
    portfolio.cash += amount;
    portfolio.holdings[stock.id] = owned - quantity;
  }
  addMarketTransaction(state.user.id, type, {
    stockId: stock.id,
    quantity,
    price: stock.price,
    amount,
  });
  saveDb();
  const qualified = syncMarketQualification(state.user.id);
  state.marketMessage = qualified
    ? "목표 자산을 달성했습니다. 상품 교환 자격이 확정되었습니다."
    : `${stock.name} ${quantity}주를 ${type === "buy" ? "매수" : "매도"}했습니다.`;
  render();
}

function saveMarketSettings() {
  const stampGoal = Math.floor(Number(document.querySelector("#marketStampGoal")?.value));
  const grantAmount = Math.floor(Number(document.querySelector("#marketGrantAmount")?.value));
  const prizeTarget = Math.floor(Number(document.querySelector("#marketPrizeTarget")?.value));
  if (!stampGoal || stampGoal < 1 || stampGoal > state.db.booths.length) {
    state.adminMessage = `필요 스탬프 수는 1~${state.db.booths.length} 사이로 입력해주세요.`;
    render();
    return;
  }
  if (!grantAmount || grantAmount < 1000) {
    state.adminMessage = "지급 투자금은 1,000원 이상으로 입력해주세요.";
    render();
    return;
  }
  if (!prizeTarget || prizeTarget <= grantAmount) {
    state.adminMessage = "상품 목표 자산은 지급 투자금보다 크게 입력해주세요.";
    render();
    return;
  }
  state.db.marketSettings = {
    ...state.db.marketSettings,
    stampGoal,
    grantAmount,
    prizeTarget,
  };
  saveDb();
  state.db.users.filter((user) => user.role !== "admin").forEach((user) => {
    syncMarketReward(user.id);
    syncMarketQualification(user.id);
  });
  state.adminMessage = "투자 보상 기준을 저장했습니다.";
  saveDb();
  render();
}

function ensureAdminTestUser() {
  let user = state.db.users.find((item) => item.googleUid === ADMIN_TEST_USER_UID);
  if (user) return user;
  user = {
    id: makeId(),
    googleUid: ADMIN_TEST_USER_UID,
    googleEmail: "test-student@pangyo.local",
    studentNumber: "TEST-001",
    schoolId: "admin-stamp-test",
    name: "테스트 학생",
    role: "user",
    testOnly: true,
    exchangedAt: null,
  };
  state.db.users.push(user);
  return user;
}

function issueAdminTestStamp() {
  if (state.user?.role !== "admin") return;
  const boothId = document.querySelector("#adminTestBooth")?.value;
  const booth = state.db.booths.find((item) => item.id === boothId);
  if (!booth) return;
  const testUser = ensureAdminTestUser();
  const result = awardStamp(testUser.id, booth.id, "admin-test");
  if (!result.awarded) {
    state.adminTestMessage = `${booth.name} 스탬프는 이미 테스트했습니다.`;
  } else if (result.rewardGranted) {
    state.adminTestMessage = `${booth.name} 스탬프 획득 · ${formatMoney(state.db.marketSettings.grantAmount)} ${state.db.marketSettings.currencyName} 지급 완료`;
  } else {
    state.adminTestMessage = `${booth.name} 테스트 스탬프를 찍었습니다.`;
  }
  saveDb();
  render();
}

function enterAdminTestMarket() {
  if (state.user?.role !== "admin") return;
  const adminId = state.user.id;
  const testUser = ensureAdminTestUser();
  saveDb();
  state.adminPreviewAdminId = adminId;
  state.user = testUser;
  state.route = "market";
  state.marketMessage = "";
  render();
}

function exitAdminTestMarket() {
  const admin = state.db.users.find((user) => user.id === state.adminPreviewAdminId && user.role === "admin");
  state.adminPreviewAdminId = null;
  if (!admin) {
    resetLogin();
    state.route = "login";
    render();
    return;
  }
  state.user = admin;
  state.route = "admin";
  state.adminTab = "dashboard";
  state.marketMessage = "";
  render();
}

function resetAdminTestStamps() {
  if (state.user?.role !== "admin") return;
  const testUser = state.db.users.find((item) => item.googleUid === ADMIN_TEST_USER_UID);
  if (!testUser) return;
  state.db.stamps = state.db.stamps.filter((stamp) => stamp.userId !== testUser.id);
  state.db.reviews = state.db.reviews.filter((review) => review.userId !== testUser.id);
  state.db.portfolios = state.db.portfolios.filter((portfolio) => portfolio.userId !== testUser.id);
  state.db.marketTransactions = state.db.marketTransactions.filter((transaction) => transaction.userId !== testUser.id);
  state.db.users = state.db.users.filter((user) => user.id !== testUser.id);
  state.adminTestMessage = "테스트 학생의 스탬프와 투자 기록을 초기화했습니다.";
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
    name,
    floor: Number(document.querySelector("#boothFloor").value),
    location: document.querySelector("#boothLocation").value.trim(),
    description: document.querySelector("#boothDesc").value.trim(),
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

function testNfcTag(id) {
  const booth = state.db.booths.find((item) => item.id === id);
  if (!booth) return;
  state.adminMessage = `${booth.name} 태그 인식 테스트 완료`;
  state.selectedBoothId = id;
  state.route = "detail";
  render();
}

function deleteReview(id) {
  state.db.reviews = state.db.reviews.filter((review) => review.id !== id);
  saveDb();
  render();
}

function completeExchange(id) {
  const user = state.db.users.find((item) => item.id === id);
  const portfolio = repo.portfolioForUser(id);
  if (!user || !portfolio?.qualifiedAt || user.exchangedAt) return;
  user.exchangedAt = new Date().toISOString();
  addMarketTransaction(id, "exchange", { amount: portfolioValues(portfolio).total });
  saveDb();
  render();
}

function showStampPop(message = "스탬프 획득") {
  const pop = document.createElement("div");
  pop.className = "stamp-pop";
  pop.textContent = message;
  document.body.appendChild(pop);
  setTimeout(() => pop.remove(), 1200);
}

if (state.pendingNfcTag) nfcAdapter.scan(state.pendingNfcTag);
else render();
