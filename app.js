const DB_KEY = "pangyo-festival-db-v3";
const GOAL_COUNT = 5;

const FLOORS = [
  { floor: 1, label: "1층", caption: "시설" },
  { floor: 2, label: "2층", caption: "1학년" },
  { floor: 3, label: "3층", caption: "2학년" },
  { floor: 4, label: "4층", caption: "3학년" },
];

const classPositions = [
  [16, 28],
  [35, 22],
  [56, 25],
  [76, 31],
  [19, 68],
  [39, 74],
  [61, 70],
  [80, 62],
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
  routeGuideId: null,
  sheetOpen: false,
  sheetLevel: "peek",
  search: "",
  sort: "name",
  boothFilter: "all",
  adminTab: "dashboard",
  reviewRating: 5,
  authStep: "google",
  pendingGoogle: null,
  authIntent: "student",
  loginBusy: false,
  loginError: "",
  adminMessage: "",
  pendingNfcTag: new URLSearchParams(window.location.search).get("nfc") || "",
};

const authProvider = {
  async signInWithGoogle() {
    return this.demoProfile();
  },
  signInAdmin() {
    return { uid: "google-admin", email: "admin@pangyo.hs.kr", displayName: "축제 관리자", provider: "google" };
  },
  demoProfile() {
    const savedUid = localStorage.getItem("pangyo-demo-google-uid-v2") || "google-local-student";
    localStorage.setItem("pangyo-demo-google-uid-v2", savedUid);
    return { uid: savedUid, email: "student@pangyo.hs.kr", displayName: "판교고 학생", provider: "google" };
  },
};

function makeId() {
  return crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
    { id: "b2", name: "학생회 안내소", floor: 1, location: "1층 중앙 현관", description: "축제 안내, 분실물 문의, 음료 교환 문의를 도와주는 운영 부스입니다.", nfcTagId: "NFC-INFO-102", x: 50, y: 43, favorite: true, category: "facility" },
    { id: "b3", name: "교무실", floor: 1, location: "1층 교무실", description: "운영 문의와 긴급 연락을 처리하는 관리 공간입니다.", nfcTagId: "NFC-OFFICE-103", x: 78, y: 32, favorite: false, category: "facility" },
    { id: "b4", name: "방송실", floor: 1, location: "1층 방송실", description: "축제 방송과 안내 멘트를 운영하는 공간입니다.", nfcTagId: "NFC-STUDIO-104", x: 26, y: 72, favorite: false, category: "facility" },
    { id: "b5", name: "매점", floor: 1, location: "1층 매점", description: "간단한 간식과 음료를 구매할 수 있는 편의 공간입니다.", nfcTagId: "NFC-STORE-105", x: 69, y: 70, favorite: false, category: "facility" },
    ...makeClassBooths(1, 2),
    ...makeClassBooths(2, 3),
    ...makeClassBooths(3, 4),
  ],
  stamps: [],
  reviews: [],
};

state.db = loadDb();

function loadDb() {
  const saved = localStorage.getItem(DB_KEY);
  if (!saved) {
    localStorage.setItem(DB_KEY, JSON.stringify(seed));
    return structuredClone(seed);
  }
  const db = JSON.parse(saved);
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
  localStorage.setItem(DB_KEY, JSON.stringify(state.db));
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
    return state.db.stamps.filter((stamp) => stamp.boothId === boothId).length;
  },
  stampsForUser(userId) {
    return state.db.stamps.filter((stamp) => stamp.userId === userId);
  },
};

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
    if (!repo.hasStamp(state.user.id, booth.id)) {
      state.db.stamps.push({ id: makeId(), userId: state.user.id, boothId: booth.id, createdAt: new Date().toISOString() });
      saveDb();
      showStampPop();
    }
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

function render() {
  const app = document.querySelector("#app");
  if (state.route === "login") app.innerHTML = loginView();
  if (state.route === "map") app.innerHTML = mapView();
  if (state.route === "detail") app.innerHTML = detailView();
  if (state.route === "stamps") app.innerHTML = stampView();
  if (state.route === "admin") app.innerHTML = adminView();
  app.dataset.route = state.route;
  bindEvents();
}

function loginView() {
  const profileStep = state.authStep === "profile" && state.pendingGoogle;
  return `
    <main class="screen login-screen">
      <div>
        <div class="brand-mark">P</div>
        <h1 class="title">판교고 축제<br />스탬프 맵</h1>
        <p class="subtitle">먼저 구글 계정으로 본인 인증을 하고, 그 다음 학번과 아이디를 등록합니다. 참여 기록은 구글 계정 기준으로 중복 방지됩니다.</p>
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
      <p class="subtitle">현재는 구글 계정 인증 UI 틀만 적용되어 있습니다. 버튼을 누르면 인증 완료로 처리되고 학생 정보 등록으로 넘어갑니다.</p>
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
  if (state.boothFilter === "visited") booths = booths.filter((booth) => repo.hasStamp(state.user.id, booth.id));
  if (state.boothFilter === "favorite") booths = booths.filter((booth) => booth.favorite);
  if (state.boothFilter === "class") booths = booths.filter((booth) => booth.category === "class");
  if (state.boothFilter === "facility") booths = booths.filter((booth) => booth.category === "facility");
  return booths.sort((a, b) => {
    if (state.sort === "rating") return repo.avgRating(b.id) - repo.avgRating(a.id);
    return a.name.localeCompare(b.name, "ko");
  });
}

function mapRoomsForFloor(floor) {
  if (floor === 1) {
    return [
      ["보건실", 8, 15, 26, 20],
      ["중앙 현관", 38, 27, 24, 24],
      ["교무실", 66, 15, 26, 20],
      ["방송실", 13, 63, 26, 20],
      ["매점", 59, 61, 28, 22],
    ];
  }
  const grade = floor - 1;
  return classPositions.map(([x, y], index) => [`${grade}-${index + 1}`, Math.max(x - 9, 5), Math.max(y - 12, 8), 18, 16]);
}

function mapView() {
  const booths = visibleBooths();
  const floorInfo = FLOORS.find((item) => item.floor === state.floor);
  const rooms = mapRoomsForFloor(state.floor);
  const stampedCount = booths.filter((booth) => repo.hasStamp(state.user.id, booth.id)).length;
  const selectedBooth = booths.find((booth) => booth.id === state.selectedBoothId);
  return `
    <main class="map-screen">
      <header class="top-bar">
        <button class="icon-btn" data-route="stamps" title="스탬프">${icon("stamp")}</button>
        <div class="top-title"><strong>판교고 축제 맵</strong><span>${floorInfo.label} · ${floorInfo.caption} · ${state.user?.name || ""}님</span></div>
        <button class="icon-btn" data-route="${state.user?.role === "admin" ? "admin" : "login"}" title="계정">${state.user?.role === "admin" ? icon("admin") : "G"}</button>
      </header>
      <nav class="floor-tabs">
        ${FLOORS.map(({ floor, label, caption }) => `<button class="pill-btn ${state.floor === floor ? "active" : ""}" data-floor="${floor}">${label}<small>${caption}</small></button>`).join("")}
      </nav>
      <section class="map-stage">
        <div class="map-status-card">
          <span class="status-dot"></span>
          <strong>${floorInfo.label} 탐색 중</strong>
          <small>스탬프 ${stampedCount}/${booths.length}</small>
        </div>
        <div class="map-toolbar">
          <button class="map-chip ${state.boothFilter === "all" ? "active" : ""}" type="button" data-map-filter="all">전체</button>
          <button class="map-chip ${state.boothFilter === "class" ? "active" : ""}" type="button" data-map-filter="class">부스</button>
          <button class="map-chip ${state.boothFilter === "facility" ? "active" : ""}" type="button" data-map-filter="facility">시설</button>
          <button class="map-chip" id="sheetOpenBtn">목록</button>
        </div>
        <button class="map-search-pill" id="mapSearchBtn" type="button">
          <span>⌕</span>
          <strong>부스 검색</strong>
          <small>${state.search || "이름, 위치로 찾기"}</small>
        </button>
        <div class="map-card" id="mapCard" style="--map-zoom:${state.mapZoom};--map-x:${state.mapOffsetX}px;--map-y:${state.mapOffsetY}px">
          <div class="map-canvas">
            <div class="map-grid"></div>
            <div class="school-label">PANGYO HIGH</div>
            <div class="map-river"></div>
            <div class="map-path main"></div>
            <div class="map-path sub"></div>
            <div class="map-plaza"></div>
            <div class="corridor"></div>
            <div class="current-position-dot" aria-hidden="true"></div>
            ${selectedBooth && state.routeGuideId === selectedBooth.id ? mapRouteGuide(selectedBooth) : ""}
            ${rooms.map(([label, x, y, w, h]) => `<div class="room" style="left:${x}%;top:${y}%;width:${w}%;height:${h}%">${label}</div>`).join("")}
            ${booths.map((booth) => `<button class="${markerClass(booth)} ${state.selectedBoothId === booth.id ? "selected" : ""}" style="left:${booth.x}%;top:${booth.y}%" data-map-select="${booth.id}" title="${booth.name}"><span>${markerLabel(booth)}</span><em>${markerName(booth)}</em></button>`).join("")}
          </div>
          <button class="locate-btn" id="locateBtn" title="현재 위치">⌾</button>
          <div class="map-legend">
            <span><i class="legend-pin class"></i>부스</span>
            <span><i class="legend-pin facility"></i>시설</span>
            <span><i class="legend-pin visited"></i>방문</span>
          </div>
          <div class="zoom-control"><button type="button" data-zoom="in" aria-label="지도 확대">+</button><button type="button" data-zoom="out" aria-label="지도 축소">-</button></div>
          ${selectedBooth ? mapPreviewCard(selectedBooth) : ""}
        </div>
      </section>
      <section class="sheet ${sheetClass()}" id="sheet">
        <button class="sheet-handle" id="sheetToggle" aria-label="부스 목록 열기"></button>
        <div class="sheet-head">
          <span><strong>${floorInfo.label} ${floorInfo.caption}</strong><small>${stampedCount}개 방문 · ${booths.length}개 부스</small></span>
          <button class="sheet-open-link" id="sheetOpenBtn2">전체보기</button>
        </div>
        <div class="search-row">
          <input id="search" class="input" placeholder="부스 검색" value="${state.search}" />
          <select id="sort" class="select">
            <option value="name" ${state.sort === "name" ? "selected" : ""}>이름순</option>
            <option value="rating" ${state.sort === "rating" ? "selected" : ""}>별점순</option>
          </select>
        </div>
        <div class="sheet-filter-row">
          ${[
            ["all", "전체"],
            ["class", "부스"],
            ["facility", "시설"],
            ["visited", "방문완료"],
            ["favorite", "즐겨찾기"],
          ].map(([filter, label]) => `<button type="button" class="sheet-filter ${state.boothFilter === filter ? "active" : ""}" data-booth-filter="${filter}">${label}</button>`).join("")}
        </div>
        <div class="booth-list">${booths.length ? booths.map(boothItem).join("") : `<div class="empty-list">조건에 맞는 부스가 없습니다.</div>`}</div>
      </section>
      ${bottomNav("map")}
    </main>
  `;
}

function markerLabel(booth) {
  if (booth.category !== "class") return booth.name.slice(0, 1);
  const match = booth.name.match(/\d반/);
  return match ? match[0].replace("반", "") : "반";
}

function markerClass(booth) {
  const classes = ["marker", booth.category || "class"];
  if (booth.favorite) classes.push("favorite");
  if (repo.hasStamp(state.user.id, booth.id)) classes.push("visited");
  return classes.join(" ");
}

function markerName(booth) {
  return booth.name.length > 6 ? `${booth.name.slice(0, 6)}…` : booth.name;
}

function sheetClass() {
  if (state.sheetLevel === "full") return "full";
  if (state.sheetLevel === "mid" || state.sheetOpen) return "open";
  return "";
}

function boothItem(booth) {
  const stamped = repo.hasStamp(state.user.id, booth.id);
  return `
    <button class="booth-item" data-detail="${booth.id}">
      <span>
        <strong>${booth.favorite ? icon("heart") + " " : ""}${booth.name}</strong>
        <span class="meta">${booth.location} · ${icon("star")} ${repo.avgRating(booth.id).toFixed(1)} · 방문 ${repo.boothVisits(booth.id)}</span>
      </span>
      <span class="stamp ${stamped ? "on" : ""}">${icon("stamp")}</span>
    </button>
  `;
}

function mapPreviewCard(booth) {
  const stamped = repo.hasStamp(state.user.id, booth.id);
  const guiding = state.routeGuideId === booth.id;
  return `
    <article class="map-preview-card">
      <div>
        <strong>${booth.name}</strong>
        <span>${booth.location} · ${icon("star")} ${repo.avgRating(booth.id).toFixed(1)} · 방문 ${repo.boothVisits(booth.id)}</span>
      </div>
      <button type="button" class="preview-route-btn ${guiding ? "active" : ""}" data-guide="${booth.id}">${guiding ? "안내중" : "길안내"}</button>
      <button type="button" class="preview-detail-btn" data-detail="${booth.id}">${stamped ? "다시보기" : "상세"}</button>
    </article>
  `;
}

function mapRouteGuide(booth) {
  return `
    <svg class="map-route-guide" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <polyline points="50,52 ${Math.max(8, booth.x - 8)},58 ${booth.x},${booth.y}" />
      <circle cx="50" cy="52" r="1.7" />
      <circle class="route-end" cx="${booth.x}" cy="${booth.y}" r="2.2" />
    </svg>
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
  const count = repo.stampsForUser(state.user.id).length;
  const total = state.db.booths.length;
  const remain = Math.max(GOAL_COUNT - count, 0);
  const percent = Math.min((count / GOAL_COUNT) * 100, 100);
  const user = state.db.users.find((item) => item.id === state.user.id);
  return `
    <main class="screen stamp-screen">
      <header class="top-bar">
        <button class="icon-btn" data-route="map">${icon("back")}</button>
        <div class="top-title"><strong>스탬프 현황</strong><span>목표 ${GOAL_COUNT}개 달성 시 음료 교환</span></div>
        <button class="icon-btn" data-route="admin">${icon("admin")}</button>
      </header>
      <section class="panel">
        <h1 class="title">현재 ${count}개 획득</h1>
        <p class="subtitle">전체 ${total}개 중 ${count}개를 모았습니다.</p>
        <div class="progress-wrap"><div class="progress" style="width:${percent}%"></div></div>
        <p class="notice">${remain ? `목표까지 ${remain}개 남았습니다.` : user?.exchangedAt ? "음료 교환 완료" : "음료수 교환 가능"}</p>
      </section>
      <section class="section stats-grid">
        ${state.db.booths.map((booth) => `<div class="stat"><strong class="stamp ${repo.hasStamp(state.user.id, booth.id) ? "on" : ""}">${icon("stamp")}</strong><span>${booth.name}</span></div>`).join("")}
      </section>
      ${bottomNav("stamps")}
    </main>
  `;
}

function adminView() {
  const tabs = [
    ["dashboard", "대시보드"],
    ["booths", "부스"],
    ["reviews", "리뷰"],
    ["users", "사용자"],
  ];
  return `
    <main class="screen admin-screen">
      <header class="top-bar">
        <button class="icon-btn" data-route="map">${icon("back")}</button>
        <div class="top-title"><strong>관리자 패널</strong><span>운영 데이터와 NFC 태그 관리</span></div>
        <button class="icon-btn" data-route="login">G</button>
      </header>
      <nav class="admin-tabs">${tabs.map(([id, label]) => `<button class="pill-btn ${state.adminTab === id ? "active" : ""}" data-admin-tab="${id}">${label}</button>`).join("")}</nav>
      ${adminPanel()}
      ${bottomNav("admin")}
    </main>
  `;
}

function adminPanel() {
  if (state.adminTab === "dashboard") {
    const top = [...state.db.booths].sort((a, b) => repo.boothVisits(b.id) - repo.boothVisits(a.id)).slice(0, 5);
    return `
      <section class="stats-grid">
        <div class="stat"><strong>${state.db.stamps.length}</strong><span>총 방문 인증</span></div>
        <div class="stat"><strong>${state.db.reviews.length}</strong><span>총 리뷰</span></div>
        <div class="stat"><strong>${state.db.users.length}</strong><span>사용자</span></div>
        <div class="stat"><strong>${state.db.users.filter((u) => u.exchangedAt).length}</strong><span>교환 완료</span></div>
      </section>
      <section class="panel section"><h2>인기 부스 TOP 5</h2>${top.map((booth) => `<div class="review"><strong>${booth.name}</strong><p>방문 ${repo.boothVisits(booth.id)} · 평균 ${repo.avgRating(booth.id).toFixed(1)}</p></div>`).join("")}</section>
    `;
  }
  if (state.adminTab === "booths") {
    return `
      <section class="panel">
        <h2>부스 추가 / 수정</h2>
        ${state.adminMessage ? `<p class="success-text">${state.adminMessage}</p>` : ""}
        <div class="input-stack">
          <input id="boothName" class="input" placeholder="부스명" />
          <input id="boothLocation" class="input" placeholder="위치" />
          <select id="boothFloor" class="select"><option>1</option><option>2</option><option>3</option><option>4</option></select>
          <input id="boothNfc" class="input" placeholder="NFC 태그 ID" />
          <textarea id="boothDesc" class="textarea" placeholder="부스 설명"></textarea>
          <button id="addBooth" class="primary-btn">부스 추가</button>
        </div>
      </section>
      <section class="admin-table section">${state.db.booths.map(boothAdminRow).join("")}</section>
    `;
  }
  if (state.adminTab === "reviews") {
    return `<section class="admin-table">${state.db.reviews.map((review) => `<div class="table-row"><strong>${state.db.booths.find((b) => b.id === review.boothId)?.name}</strong><p class="subtitle">${review.content}</p><button class="danger-btn" data-delete-review="${review.id}">리뷰 삭제</button></div>`).join("")}</section>`;
  }
  return `<section class="admin-table">${state.db.users.map(userRow).join("")}</section>`;
}

function boothAdminRow(booth) {
  return `
    <div class="table-row">
      <strong>${booth.name}</strong>
      <p class="subtitle">${booth.location} · 방문 ${repo.boothVisits(booth.id)} · 평균 ${repo.avgRating(booth.id).toFixed(1)}</p>
      <label class="field compact-field">NFC 태그 ID
        <input class="input" id="nfc-${booth.id}" value="${booth.nfcTagId}" />
      </label>
      <div class="row-actions">
        <button class="ghost-btn" data-save-nfc="${booth.id}">태그 저장</button>
        <button class="ghost-btn" data-test-nfc="${booth.id}">인식 테스트</button>
        <button class="danger-btn" data-delete-booth="${booth.id}">삭제</button>
      </div>
    </div>
  `;
}

function userRow(user) {
  const stampCount = repo.stampsForUser(user.id).length;
  return `
    <div class="table-row">
      <strong>${user.name}</strong>
      <p class="subtitle">${user.studentNumber} · ${user.schoolId} · ${user.googleEmail || "Google 미연동"} · 스탬프 ${stampCount}</p>
      <button class="ghost-btn" data-exchange="${user.id}" ${stampCount < GOAL_COUNT || user.exchangedAt ? "disabled" : ""}>${user.exchangedAt ? "교환 완료" : "음료 교환 완료 처리"}</button>
    </div>
  `;
}

function bottomNav(active) {
  return `
    <nav class="bottom-nav">
      <button class="nav-btn ${active === "map" ? "active" : ""}" data-route="map"><span>${icon("map")}</span><span>지도</span></button>
      <button class="nav-btn ${active === "stamps" ? "active" : ""}" data-route="stamps"><span>${icon("stamp")}</span><span>스탬프</span></button>
      <button class="nav-btn ${active === "admin" ? "active" : ""}" data-route="admin"><span>${icon("admin")}</span><span>관리</span></button>
    </nav>
  `;
}

function bindEvents() {
  document.querySelectorAll("[data-route]").forEach((button) => {
    button.addEventListener("click", () => {
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
    state.floor = Number(button.dataset.floor);
    state.sheetOpen = false;
    state.sheetLevel = "peek";
    state.mapZoom = 1;
    state.mapOffsetX = 0;
    state.mapOffsetY = 0;
    state.boothFilter = "all";
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
  document.querySelector("#sheetOpenBtn")?.addEventListener("click", () => {
    setSheetLevel("mid");
    render();
  });
  document.querySelector("#sheetOpenBtn2")?.addEventListener("click", () => {
    setSheetLevel("full");
    render();
  });
  document.querySelector("#mapSearchBtn")?.addEventListener("click", openSearchSheet);
  document.querySelectorAll("[data-map-filter]").forEach((button) => button.addEventListener("click", () => {
    state.boothFilter = button.dataset.mapFilter;
    setSheetLevel("mid");
    render();
  }));
  document.querySelectorAll("[data-zoom]").forEach((button) => button.addEventListener("click", () => {
    const delta = button.dataset.zoom === "in" ? 0.16 : -0.16;
    state.mapZoom = Math.min(1.48, Math.max(0.92, Number((state.mapZoom + delta).toFixed(2))));
    render();
  }));
  document.querySelector("#locateBtn")?.addEventListener("click", () => {
    state.mapZoom = 1;
    state.mapOffsetX = 0;
    state.mapOffsetY = 0;
    state.sheetOpen = false;
    state.sheetLevel = "peek";
    render();
  });
  bindMapDrag();
  bindSheetDrag();
  document.querySelector("#search")?.addEventListener("input", (event) => {
    state.search = event.target.value;
    render();
  });
  document.querySelector("#sort")?.addEventListener("change", (event) => {
    state.sort = event.target.value;
    render();
  });
  document.querySelectorAll("[data-booth-filter]").forEach((button) => button.addEventListener("click", () => {
    state.boothFilter = button.dataset.boothFilter;
    setSheetLevel("mid");
    render();
  }));
  document.querySelectorAll("[data-map-select]").forEach((button) => button.addEventListener("click", () => {
    selectMapBooth(button.dataset.mapSelect);
  }));
  document.querySelectorAll("[data-guide]").forEach((button) => button.addEventListener("click", () => {
    toggleRouteGuide(button.dataset.guide);
  }));
  document.querySelectorAll("[data-detail]").forEach((button) => button.addEventListener("click", () => goDetail(button.dataset.detail)));
  document.querySelectorAll("[data-nfc]").forEach((button) => button.addEventListener("click", () => nfcAdapter.scan(button.dataset.nfc)));
  document.querySelectorAll("[data-rating]").forEach((button) => button.addEventListener("click", () => {
    state.reviewRating = Number(button.dataset.rating);
    render();
  }));
  document.querySelector("#submitReview")?.addEventListener("click", submitReview);
  document.querySelectorAll("[data-admin-tab]").forEach((button) => button.addEventListener("click", () => {
    state.adminTab = button.dataset.adminTab;
    render();
  }));
  document.querySelector("#addBooth")?.addEventListener("click", addBooth);
  document.querySelectorAll("[data-delete-booth]").forEach((button) => button.addEventListener("click", () => deleteBooth(button.dataset.deleteBooth)));
  document.querySelectorAll("[data-save-nfc]").forEach((button) => button.addEventListener("click", () => saveNfcTag(button.dataset.saveNfc)));
  document.querySelectorAll("[data-test-nfc]").forEach((button) => button.addEventListener("click", () => testNfcTag(button.dataset.testNfc)));
  document.querySelectorAll("[data-delete-review]").forEach((button) => button.addEventListener("click", () => deleteReview(button.dataset.deleteReview)));
  document.querySelectorAll("[data-exchange]").forEach((button) => button.addEventListener("click", () => completeExchange(button.dataset.exchange)));
}

function openSearchSheet() {
  setSheetLevel("full");
  render();
  requestAnimationFrame(() => document.querySelector("#search")?.focus());
}

function setSheetLevel(level) {
  state.sheetLevel = level;
  state.sheetOpen = level !== "peek";
}

function bindSheetDrag() {
  const handle = document.querySelector("#sheetToggle");
  if (!handle) return;
  let startY = 0;
  let dragging = false;

  const finish = (clientY) => {
    if (!dragging) return;
    const delta = clientY - startY;
    if (delta < -22) {
      if (state.sheetLevel === "peek") setSheetLevel("mid");
      else setSheetLevel("full");
    }
    if (delta > 22) {
      if (state.sheetLevel === "full") setSheetLevel("mid");
      else setSheetLevel("peek");
    }
    dragging = false;
    render();
  };

  handle.addEventListener("pointerdown", (event) => {
    dragging = true;
    startY = event.clientY;
    handle.setPointerCapture?.(event.pointerId);
  });
  handle.addEventListener("pointerup", (event) => finish(event.clientY));
  handle.addEventListener("pointercancel", (event) => finish(event.clientY || startY));
}

function bindMapDrag() {
  const card = document.querySelector("#mapCard");
  const canvas = card?.querySelector(".map-canvas");
  if (!card || !canvas) return;

  let startX = 0;
  let startY = 0;
  let baseX = state.mapOffsetX;
  let baseY = state.mapOffsetY;
  let dragging = false;

  const clamp = (value, max) => Math.min(max, Math.max(-max, value));

  card.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button, input, select, textarea")) return;
    dragging = true;
    startX = event.clientX;
    startY = event.clientY;
    baseX = state.mapOffsetX;
    baseY = state.mapOffsetY;
    card.classList.add("dragging");
    card.setPointerCapture?.(event.pointerId);
  });

  card.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const maxX = 72 * state.mapZoom;
    const maxY = 92 * state.mapZoom;
    const nextX = clamp(baseX + event.clientX - startX, maxX);
    const nextY = clamp(baseY + event.clientY - startY, maxY);
    canvas.style.transform = `translate(${nextX}px, ${nextY}px) scale(${state.mapZoom})`;
  });

  const finish = (event) => {
    if (!dragging) return;
    const maxX = 72 * state.mapZoom;
    const maxY = 92 * state.mapZoom;
    state.mapOffsetX = clamp(baseX + event.clientX - startX, maxX);
    state.mapOffsetY = clamp(baseY + event.clientY - startY, maxY);
    dragging = false;
    card.classList.remove("dragging");
    render();
  };

  card.addEventListener("pointerup", finish);
  card.addEventListener("pointercancel", finish);
}

function resetLogin() {
  state.user = null;
  state.authStep = "google";
  state.pendingGoogle = null;
  state.authIntent = "student";
  state.loginError = "";
}

async function startGoogleLogin(intent = "student") {
  if (state.loginBusy) return;
  state.loginBusy = true;
  state.authIntent = intent;
  state.loginError = "";
  try {
    state.pendingGoogle = await authProvider.signInWithGoogle();
  } catch (error) {
    state.loginError = error.message;
    state.loginBusy = false;
    render();
    return;
  }
  state.loginBusy = false;
  if (intent === "admin") {
    finishAdminGoogleLogin(state.pendingGoogle);
    return;
  }
  const existing = state.db.users.find((user) => user.googleUid === state.pendingGoogle.uid);
  if (existing && existing.studentNumber && existing.schoolId) {
    state.user = existing;
    state.route = "map";
    state.loginError = "";
    consumePendingNfc();
    return;
  } else {
    state.authStep = "profile";
    state.loginError = "";
  }
  render();
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
  state.user = admin;
  state.route = "admin";
  state.loginError = "";
  render();
}

function consumePendingNfc() {
  if (!state.pendingNfcTag || !state.user) {
    render();
    return;
  }
  const tagId = state.pendingNfcTag;
  state.pendingNfcTag = "";
  nfcAdapter.scan(tagId);
}

function goDetail(id) {
  state.selectedBoothId = id;
  state.route = "detail";
  state.sheetOpen = false;
  state.sheetLevel = "peek";
  render();
}

function selectMapBooth(id) {
  state.selectedBoothId = id;
  if (state.routeGuideId && state.routeGuideId !== id) state.routeGuideId = null;
  focusMapOnBooth(id);
  if (state.sheetLevel === "full") setSheetLevel("mid");
  render();
}

function toggleRouteGuide(id) {
  state.selectedBoothId = id;
  state.routeGuideId = state.routeGuideId === id ? null : id;
  focusMapOnBooth(id);
  if (state.sheetLevel === "full") setSheetLevel("mid");
  render();
}

function focusMapOnBooth(id) {
  const booth = state.db.booths.find((item) => item.id === id);
  if (!booth) return;
  const maxX = 72 * state.mapZoom;
  const maxY = 92 * state.mapZoom;
  const targetX = (50 - booth.x) * 1.35;
  const targetY = (48 - booth.y) * 1.15;
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
  user.exchangedAt = new Date().toISOString();
  saveDb();
  render();
}

function showStampPop() {
  const pop = document.createElement("div");
  pop.className = "stamp-pop";
  pop.textContent = "스탬프 획득";
  document.body.appendChild(pop);
  setTimeout(() => pop.remove(), 1200);
}

if (state.pendingNfcTag) nfcAdapter.scan(state.pendingNfcTag);
else render();
