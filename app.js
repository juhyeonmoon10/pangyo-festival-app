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
  const previousRoute = app.dataset.route || state.route;
  const nextRoute = state.route;
  const swap = () => {
    if (state.route === "login") app.innerHTML = loginView();
    if (state.route === "map") app.innerHTML = mapView();
    if (state.route === "detail") app.innerHTML = detailView();
    if (state.route === "stamps") app.innerHTML = stampView();
    if (state.route === "admin") app.innerHTML = adminView();
    app.dataset.previousRoute = previousRoute;
    app.dataset.route = nextRoute;
    bindEvents();
  };
  swap();
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
      <nav class="floor-tabs selector-bar">
        ${choiceSelect({
          id: "floor",
          label: floorInfo.label,
          caption: floorInfo.caption,
          options: FLOORS.map(({ floor, label, caption }) => ({
            label,
            caption,
            count: state.db.booths.filter((booth) => booth.floor === floor).length,
            active: state.floor === floor,
            attr: `data-floor="${floor}"`,
          })),
        })}
      </nav>
      <section class="map-stage">
        <div class="map-card ${selectedBooth ? "has-preview" : ""}" id="mapCard" style="--map-zoom:${state.mapZoom};--map-x:${state.mapOffsetX}px;--map-y:${state.mapOffsetY}px">
          <div class="map-canvas">
            <div class="map-grid"></div>
            <div class="map-entry-label">입구</div>
            <div class="map-compass" aria-hidden="true"><b>N</b><span></span></div>
            <div class="school-label">PANGYO HIGH</div>
            <div class="map-river"></div>
            <div class="map-path main"></div>
            <div class="map-path sub"></div>
            <div class="map-plaza"></div>
            <div class="corridor"></div>
            <div class="current-position-dot" aria-hidden="true"></div>
            ${rooms.map(([label, x, y, w, h], index) => `<div class="room" style="left:${x}%;top:${y}%;width:${w}%;height:${h}%;--stagger:${index * 24}ms">${label}</div>`).join("")}
            ${booths.map((booth, index) => `<button class="${markerClass(booth)} ${state.selectedBoothId === booth.id ? "selected" : ""}" style="left:${booth.x}%;top:${booth.y}%;--stagger:${index * 18}ms" data-map-select="${booth.id}" aria-label="${booth.name}" title="${booth.name}"><span aria-hidden="true">${icon("map")}</span></button>`).join("")}
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
        <div class="top-title"><strong>관리자 패널</strong><span>부스, NFC, 리뷰, 교환 현황 관리</span></div>
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
  const achievedUsers = regularUsers.filter((user) => repo.stampsForUser(user.id).length >= GOAL_COUNT);
  const pendingExchange = achievedUsers.filter((user) => !user.exchangedAt);
  const totalVisits = state.db.stamps.length;
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
        <p>방문 인증, 리뷰, 음료 교환 대상을 한 화면에서 확인합니다.</p>
      </section>
      <section class="stats-grid admin-stats">
        <div class="stat"><span>총 방문 인증</span><strong>${totalVisits}</strong><small>스탬프 발급 수</small></div>
        <div class="stat"><span>총 리뷰</span><strong>${totalReviews}</strong><small>평균 ${reviewAverage.toFixed(1)}점</small></div>
        <div class="stat"><span>참여자</span><strong>${regularUsers.length}</strong><small>관리자 제외</small></div>
        <div class="stat ${pendingExchange.length ? "warn" : ""}"><span>교환 대기</span><strong>${pendingExchange.length}</strong><small>목표 ${GOAL_COUNT}개 달성</small></div>
      </section>
      <section class="panel section admin-panel-card">
        <div class="admin-section-head"><h2>인기 부스 TOP 5</h2><span>방문수 기준</span></div>
        ${top.map((booth, index) => `<div class="rank-row"><b>${index + 1}</b><span><strong>${booth.name}</strong><small>${booth.location}</small></span><em>방문 ${repo.boothVisits(booth.id)} · ${repo.avgRating(booth.id).toFixed(1)}점</em></div>`).join("")}
      </section>
      <section class="panel section admin-panel-card">
        <div class="admin-section-head"><h2>운영 체크</h2><span>빠른 점검</span></div>
        <div class="check-row ${state.db.booths.every((booth) => booth.nfcTagId) ? "ok" : "warn"}"><strong>NFC 태그</strong><span>${state.db.booths.filter((booth) => booth.nfcTagId).length}/${state.db.booths.length}개 등록</span></div>
        <div class="check-row ${pendingExchange.length ? "warn" : "ok"}"><strong>음료 교환</strong><span>${pendingExchange.length ? `${pendingExchange.length}명 처리 필요` : "대기자 없음"}</span></div>
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
  const stampCount = repo.stampsForUser(user.id).length;
  const progress = Math.min(100, Math.round((stampCount / GOAL_COUNT) * 100));
  return `
    <div class="table-row admin-row">
      <div class="row-main">
        <strong>${user.name}</strong>
        <p class="subtitle">${user.studentNumber} · ${user.schoolId} · ${user.googleEmail || "Google 미연동"}</p>
      </div>
      <div class="mini-progress"><span style="width:${progress}%"></span></div>
      <div class="row-metrics"><span>스탬프 ${stampCount}/${GOAL_COUNT}</span><span>${user.exchangedAt ? "교환 완료" : stampCount >= GOAL_COUNT ? "교환 가능" : "진행 중"}</span></div>
      <button type="button" class="ghost-btn exchange-btn" data-exchange="${user.id}" ${stampCount < GOAL_COUNT || user.exchangedAt ? "disabled" : ""}>${user.exchangedAt ? "교환 완료" : "음료 교환 완료 처리"}</button>
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
    <nav class="bottom-nav">
      <button class="nav-btn ${active === "map" ? "active" : ""}" data-route="map"><span>${icon("map")}</span><span>지도</span></button>
      <button class="nav-btn ${active === "stamps" ? "active" : ""}" data-route="stamps"><span>${icon("stamp")}</span><span>스탬프</span></button>
      <button class="nav-btn ${active === "admin" ? "active" : ""}" data-route="admin"><span>${icon("admin")}</span><span>관리</span></button>
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
  document.querySelectorAll("[data-route]").forEach((button) => {
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
    render();
  });
  document.querySelectorAll("[data-list-select]").forEach((button) => button.addEventListener("click", () => {
    goDetail(button.dataset.listSelect);
  }));
  document.querySelectorAll("[data-clear-selection]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      state.selectedBoothId = null;
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

  const peekTranslate = () => Math.max(0, sheet.getBoundingClientRect().height - 132);
  const midTranslate = () => Math.round(window.innerHeight * 0.34);
  const translateForLevel = (level) => {
    if (level === "full") return 0;
    if (level === "mid") return midTranslate();
    return peekTranslate();
  };
  const clampTranslate = (value) => Math.min(peekTranslate(), Math.max(0, value));

  const finish = () => {
    if (!dragging) return;
    const targets = [
      ["full", 0],
      ["mid", midTranslate()],
      ["peek", peekTranslate()],
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
    sheet.style.transform = `translateY(${currentTranslate}px)`;
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

  const clamp = (value, max) => Math.min(max, Math.max(-max, value));
  const distance = ([first, second]) => Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
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
      canvas.style.transform = `translate(${nextX}px, ${nextY}px) scale(${nextZoom})`;
      return;
    }
    const maxX = 72 * state.mapZoom;
    const maxY = 92 * state.mapZoom;
    const nextX = clamp(baseX + event.clientX - startX, maxX);
    const nextY = clamp(baseY + event.clientY - startY, maxY);
    canvas.style.transform = `translate(${nextX}px, ${nextY}px) scale(${state.mapZoom})`;
  });

  const finish = (event) => {
    if (!dragging) return;
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

function startGoogleLogin(intent = "student") {
  state.authIntent = intent;
  state.loginError = "";
  state.loginBusy = false;
  try {
    state.pendingGoogle = authProvider.signInWithGoogle();
  } catch (error) {
    state.loginBusy = false;
    state.loginError = error.message || "로그인 처리 중 문제가 생겼습니다.";
    render();
    return;
  }
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
  focusMapOnBooth(id, 1.18);
  if (state.sheetLevel === "full") setSheetLevel("mid");
  state.openMenu = null;
  render();
}

function focusMapOnBooth(id, targetZoom = state.mapZoom) {
  const booth = state.db.booths.find((item) => item.id === id);
  if (!booth) return;
  state.mapZoom = Math.min(1.52, Math.max(state.mapZoom, targetZoom));
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
