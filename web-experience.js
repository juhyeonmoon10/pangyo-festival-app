/* Mobile-web experience. Shared DB contracts are never changed by this module. */
const festivalWeb = (() => {
  const REVIEW_POINTS = 10; // Preview policy only; not a production reward amount.
  const progressKey = () => `festival-web-demo:${state.user?.id || "guest"}`;
  const draftKey = id => `festival-review-draft:${isServerMode() ? "server" : "demo"}:${state.user?.id}:${id}`;
  let voucherFilter = "available";
  let qrTimer = null;
  let qrDeadline = 0;
  let scanController = null;
  let scanBusy = false;

  function progress() {
    try {
      const value = JSON.parse(readSessionStorage(progressKey()) || "null");
      return value && value.points && !Array.isArray(value.points) && typeof value.points === "object" && Array.isArray(value.coupons)
        ? value : { points: {}, coupons: [] };
    }
    catch { return { points: {}, coupons: [] }; }
  }

  function saveProgress(value) {
    return writeSessionStorage(progressKey(), JSON.stringify(value));
  }

  function ownReview(id) {
    if (!state.user) return null;
    if (!isServerMode()) return state.db.reviews.find(r => r.userId === state.user.id && r.boothId === id) || null;
    const remote = serverReviewState(id);
    return remote?.reviews?.find(r => r.mine) || (remote?.myRating ? { rating: remote.myRating, unknownContent: true } : null);
  }

  function completed() {
    return state.user ? repo.stampsForUser(state.user.id).filter(s => repo.hasReview(state.user.id, s.boothId)) : [];
  }

  function waiting() {
    return state.user ? repo.stampsForUser(state.user.id).filter(s => !repo.hasReview(state.user.id, s.boothId)) : [];
  }

  function reviewPending(booth) {
    if (!repo.hasStamp(state.user.id, booth.id)) return false;
    const own = ownReview(booth.id);
    return !own || own.unknownContent || !own.content?.trim();
  }

  function draft(id) {
    try { return JSON.parse(readSessionStorage(draftKey(id)) || "null") || { rating: 0, content: "" }; }
    catch { return { rating: 0, content: "" }; }
  }

  function saveDraft() {
    if (!state.user || !state.selectedBoothId) return false;
    return writeSessionStorage(draftKey(state.selectedBoothId), JSON.stringify({ rating: state.reviewRating, content: state.reviewDraft }));
  }

  function clearDraft(id) {
    try { sessionStorage.removeItem(draftKey(id)); } catch { /* Storage is optional. */ }
  }

  function syncRewards() {
    if (isServerMode() || !state.user) return;
    const value = progress();
    for (const review of state.db.reviews.filter(r => r.userId === state.user.id && r.content?.trim())) {
      value.points[review.boothId] ??= REVIEW_POINTS;
    }
    const count = completed().length;
    for (const target of [5, 10]) {
      if (count >= target && !value.coupons.some(c => c.target === target)) {
        value.coupons.push({ id: makeId(), target, title: target === 5 ? "축제 간식 교환권" : "축제 음료 교환권",
          createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), redeemedAt: null });
      }
    }
    saveProgress(value);
  }

  function points() { return isServerMode() ? null : Object.values(progress().points).reduce((a, b) => a + Number(b), 0); }
  function coupons() { return isServerMode() ? [] : progress().coupons; }
  function couponState(c) { return c.redeemedAt ? "used" : new Date(c.expiresAt) <= new Date() ? "expired" : "available"; }
  function boothName(booth) { return escapeHtml(catalogBooth(booth)?.name || booth.name); }

  function header(title, subtitle = "") {
    return `<header class="web-header"><button type="button" class="icon-btn" data-history-back="home" aria-label="뒤로 가기">${icon("back")}</button><div><h1>${title}</h1>${subtitle ? `<p>${subtitle}</p>` : ""}</div><button type="button" class="icon-btn" data-route="home" aria-label="홈">${icon("home")}</button></header>`;
  }

  function home() {
    syncRewards();
    const visits = repo.stampsForUser(state.user.id);
    const count = completed().length;
    const pending = waiting().length;
    const notice = isServerMode() ? null : state.db.announcements[0];
    return `<main class="web-home">
      <header class="web-brand"><span class="brand-symbol">P.</span><strong>판교고 축제</strong><span class="web-mode">MY FESTIVAL</span><button type="button" class="icon-btn" data-route="profile" aria-label="내 정보">${icon("user")}</button></header>
      <section class="web-welcome"><p>${/^\d{5}$/.test(state.user.studentNumber) ? escapeHtml(state.user.studentNumber) : "나의 축제 기록"}</p><h1>${escapeHtml(state.user.name)}님,<br>오늘의 축제를 채워보세요.</h1>
        <div class="web-my-stats"><button data-route="stamps"><span>스탬프</span><strong data-complete-count>${count}<small>개</small></strong></button><button data-route="vouchers"><span>바우처</span><strong>${coupons().filter(c => couponState(c) === "available").length}<small>장</small></strong></button><button data-route="reviews"><span>${isServerMode() ? "리뷰 포인트" : "체험 포인트"}</span><strong>${points() ?? "—"}<small>P</small></strong></button></div>
      </section>
      ${state.db.event.emergencyMode ? emergencyBanner() : ""}
      <nav class="web-shortcuts" aria-label="축제 바로가기">
        ${[["map", "map", "부스 지도", "층별 부스 찾기"], ["stamps", "stamp", "스탬프", "나의 방문 기록"], ["vouchers", "ticket", "바우처", "쿠폰과 QR"], ["reviews", "message", "나의 리뷰", "못 쓴 후기 이어쓰기"]].map(([route, symbol, title, text]) => `<button type="button" data-route="${route}"><span class="shortcut-symbol ${route}">${icon(symbol)}</span><strong>${title}</strong><small>${text}</small>${icon("arrow")}</button>`).join("")}
      </nav>
      ${pending ? `<button class="web-pending" data-route="stamps">${icon("star")}<span><strong>별점을 기다리는 방문 ${pending}개</strong><small>별점을 남기면 스탬프가 완성돼요.</small></span>${icon("arrow")}</button>` : ""}
      <section class="web-section"><div class="section-heading"><h2>최근 내 기록</h2><button class="text-link" data-route="stamps">전체 보기 ${icon("arrow")}</button></div>
        ${visits.length ? `<div class="web-records">${visits.slice(-3).reverse().map(visitRow).join("")}</div>` : `<div class="web-empty-inline">${icon("stamp")}<p>아직 방문한 부스가 없어요.<br><span>첫 번째 축제 기록을 남겨보세요.</span></p></div>`}
      </section>
      <section class="web-section web-announcement">${icon("notice")}<div><h2>축제 소식</h2><strong>${notice ? escapeHtml(notice.title) : "등록된 공지가 없어요"}</strong>${notice ? `<p>${escapeHtml(notice.body)}</p>` : ""}</div></section>
      <footer class="web-footer">PANGYO HIGH SCHOOL <span>${isServerMode() ? "포인트 · 쿠폰 발급 준비 중" : "체험 기록 · 실제 포인트 및 상품 교환 불가"}</span></footer>
    </main>`;
  }

  function visitRow(visit) {
    const booth = state.db.booths.find(b => b.id === visit.boothId);
    if (!booth) return "";
    const rated = repo.hasReview(state.user.id, booth.id);
    return `<button type="button" class="web-visit" data-review-booth="${booth.id}">${clubVisual(booth)}<span><strong>${boothName(booth)}</strong><small>${escapeHtml(booth.location)}${visit.createdAt ? ` · ${formatTime(visit.createdAt)}` : ""}</small></span><em class="${rated ? "done" : "pending"}">${rated ? "날인 완료" : "별점 필요"}</em>${icon("arrow")}</button>`;
  }

  function stamps() {
    syncRewards();
    const earned = completed();
    const pending = waiting();
    const goal = earned.length >= 5 ? 10 : 5;
    return `<main class="screen web-page web-stamps">${header("나의 스탬프", "방문하고, 평가하고, 차곡차곡")}
      <section class="web-stamp-summary"><span class="web-kicker">PANGYO STAMP</span><h2>오늘 모은 스탬프 <b>${earned.length}</b></h2><p>${isServerMode() ? "별점까지 등록한 방문 기록이에요." : goal > earned.length ? `다음 체험 바우처까지 ${goal - earned.length}개 남았어요.` : "모든 체험 바우처를 받았어요."}</p>
        <div class="web-stamp-grid">${Array.from({length: Math.max(10, earned.length)}, (_, i) => {
          const visit = earned[i];
          const booth = visit && state.db.booths.find(b => b.id === visit.boothId);
          return booth ? `<button class="web-stamp-cell earned" data-list-select="${booth.id}" aria-label="${boothName(booth)} 날인 완료"><span>${icon("stamp")}</span><small>${boothName(booth)}</small></button>` : `<div class="web-stamp-cell ${i === earned.length ? "next" : ""}"><span>${i === 4 || i === 9 ? icon("ticket") : i + 1}</span><small>${i === 4 || i === 9 ? "바우처" : i === earned.length ? "다음 스탬프" : ""}</small></div>`;
        }).join("")}</div>
      </section>
      ${pending.length ? `<section class="web-section"><div class="section-heading"><h2>날인 대기 <span>${pending.length}</span></h2></div><p class="web-muted">방문 인증은 보관됐어요. 별점을 남기면 날인이 완료돼요.</p>${pending.map(visitRow).join("")}</section>` : ""}
      <button type="button" class="web-pending voucher-link" data-route="vouchers">${icon("ticket")}<span><strong>내 바우처 확인</strong><small>${isServerMode() ? "쿠폰 서비스 준비 중" : "쿠폰마다 별도의 QR로 확인"}</small></span>${icon("arrow")}</button>
      <section class="web-section"><div class="section-heading"><h2>완료한 방문</h2><button class="text-link" data-route="reviews">후기 쓰기 ${icon("arrow")}</button></div>${earned.length ? earned.slice().reverse().map(visitRow).join("") : `<p class="web-muted">아직 완성된 스탬프가 없어요.</p>`}</section>
      ${bottomNav("stamps")}</main>`;
  }

  function reviews() {
    const booths = state.db.booths.filter(b => repo.hasStamp(state.user.id, b.id));
    const pending = booths.filter(reviewPending);
    return `<main class="screen web-page">${header("나의 리뷰", "별점은 필수, 글 후기는 선택")}
      <section class="web-review-benefit">${icon("message")}<div><h2>못 남긴 이야기, 이어서</h2><p>${isServerMode() ? "별점만 남겼어도 글 후기를 나중에 작성할 수 있어요. 후기 추가·포인트 서버 연결 전에는 임시저장됩니다." : `글 후기를 처음 등록하면 체험 포인트 ${REVIEW_POINTS}P를 받아요. 부스당 한 번만 지급돼요.`}</p></div></section>
      <section class="web-section"><div class="section-heading"><h2>작성할 후기 <span>${pending.length}</span></h2></div>${pending.length ? pending.map(b => visitRow({boothId: b.id})).join("") : `<div class="web-empty-inline">${icon("check")}<p>${booths.length ? "모든 후기를 남겼어요." : "부스 방문 후 후기를 남길 수 있어요."}</p></div>`}</section>
      <section class="web-section"><div class="section-heading"><h2>남긴 후기</h2></div>${booths.filter(b => !reviewPending(b)).map(b => `<article class="web-written"><header><strong>${boothName(b)}</strong><span>${icon("star")} ${ownReview(b.id).rating}</span></header><p>${escapeHtml(ownReview(b.id).content)}</p></article>`).join("") || `<p class="web-muted">아직 글 후기가 없어요.</p>`}</section>
      ${bottomNav("reviews")}</main>`;
  }

  function vouchers() {
    syncRewards();
    const all = coupons();
    const list = all.filter(c => voucherFilter === "available" ? couponState(c) === "available" : couponState(c) !== "available");
    return `<main class="screen web-page">${header("나의 바우처", "축제에서 모은 작은 혜택")}
      <div class="web-segments" role="group" aria-label="바우처 상태"><button data-voucher-filter="available" aria-pressed="${voucherFilter === "available"}">사용 가능 ${all.filter(c => couponState(c) === "available").length}</button><button data-voucher-filter="history" aria-pressed="${voucherFilter === "history"}">사용 완료 · 만료</button></div>
      ${isServerMode() ? `<div class="web-empty"><span>${icon("ticket")}</span><h2>바우처를 준비하고 있어요</h2><p>실제 쿠폰 발급과 교환은 운영 서버 연결 후 열립니다.<br>현재 방문 기록은 그대로 유지돼요.</p></div>` : `<p class="web-demo-note">시연용 바우처 · 실제 상품으로 교환할 수 없어요.</p>${list.length ? `<div class="web-coupons">${list.map(c => `<article class="web-coupon"><span class="coupon-symbol">${icon("ticket")}</span><div><small>DEMO · 스탬프 ${c.target}개 달성</small><h2>${c.title}</h2><p>${new Date(c.expiresAt).toLocaleDateString("ko-KR")}까지</p></div><button class="${couponState(c) === "available" ? "primary-btn" : "ghost-btn"}" data-voucher="${c.id}" ${couponState(c) === "available" ? "" : "disabled"}>${couponState(c) === "available" ? "QR 보기" : couponState(c) === "used" ? "사용 완료" : "만료"}</button></article>`).join("")}</div>` : `<div class="web-empty"><span>${icon("ticket")}</span><h2>${voucherFilter === "available" ? "사용 가능한 바우처가 없어요" : "아직 사용 내역이 없어요"}</h2><p>별점까지 등록한 스탬프 5개, 10개를 모으면<br>체험용 바우처가 한 장씩 발급돼요.</p><button class="ghost-btn" data-route="stamps">스탬프 보기</button></div>`}`}
      ${bottomNav("vouchers")}</main>`;
  }

  function showVoucher(id, opener) {
    if (isServerMode()) return;
    const c = coupons().find(c => c.id === id);
    if (!c || couponState(c) !== "available") return;
    closeVoucher();
    const dialog = document.createElement("dialog");
    dialog.className = "web-qr-dialog";
    dialog.innerHTML = `<header><div><small>DEMO VOUCHER</small><h2>${c.title}</h2></div><button class="icon-btn" data-qr-close aria-label="닫기">${icon("close")}</button></header><p class="web-demo-note">실제 교환 불가 · 시연용 QR</p><div class="web-qr-code" role="img" aria-label="${c.title} 시연용 QR"></div><p class="web-qr-time" role="status"></p><button class="ghost-btn full-action" data-qr-refresh>QR 새로고침 ${icon("refresh")}</button>${isAdminUser() ? `<button class="primary-btn full-action" data-demo-redeem>관리자 모의 사용 처리</button>` : ""}<p class="web-muted">${escapeHtml(c.id.slice(0, 8).toUpperCase())} · 쿠폰별 고유 번호</p>`;
    document.body.append(dialog);
    dialog.querySelector("[data-qr-close]").onclick = () => closeVoucher(opener);
    dialog.addEventListener("cancel", event => { event.preventDefault(); closeVoucher(opener); });
    dialog.addEventListener("click", event => { if (event.target === dialog) closeVoucher(opener); });
    dialog.querySelector("[data-qr-refresh]").onclick = () => refreshQr(c);
    dialog.querySelector("[data-demo-redeem]")?.addEventListener("click", () => {
      if (!canUseMockNfcTools() || Date.now() >= qrDeadline) return;
      const p = progress();
      const item = p.coupons.find(v => v.id === id);
      if (!item || couponState(item) !== "available") return;
      item.redeemedAt = new Date().toISOString();
      if (!saveProgress(p)) { dialog.querySelector(".web-qr-time").textContent = "저장하지 못했어요. 다시 시도해 주세요."; return; }
      closeVoucher(); render();
    });
    dialog.showModal(); refreshQr(c);
  }

  function refreshQr(c) {
    clearInterval(qrTimer);
    const dialog = document.querySelector(".web-qr-dialog");
    if (!dialog || couponState(c) !== "available") return;
    qrDeadline = Math.min(Date.now() + 60000, new Date(c.expiresAt).getTime());
    const payload = `PANGYO-DEMO-ONLY:${c.id}:${qrDeadline}:${makeId()}`;
    const qr = qrcode(0, "M");
    qr.addData(payload); qr.make();
    dialog.querySelector(".web-qr-code").innerHTML = qr.createSvgTag({ cellSize: 5, margin: 20, scalable: true });
    const update = () => {
      const seconds = Math.max(0, Math.ceil((qrDeadline - Date.now()) / 1000));
      dialog.querySelector(".web-qr-time").textContent = seconds ? `QR 유효 시간 ${seconds}초` : "QR이 만료됐어요. 새로고침해 주세요.";
      if (!seconds) {
        dialog.querySelector(".web-qr-code").innerHTML = `<span>${icon("lock")}</span>`;
        dialog.querySelector("[data-demo-redeem]")?.setAttribute("disabled", "true");
        clearInterval(qrTimer);
      }
    };
    dialog.querySelector("[data-demo-redeem]")?.removeAttribute("disabled");
    update(); qrTimer = setInterval(update, 1000);
  }

  function closeVoucher(opener) {
    clearInterval(qrTimer); qrTimer = null;
    document.querySelector(".web-qr-dialog")?.remove();
    opener?.focus({preventScroll: true});
  }

  function program(booth) {
    const p = (!isServerMode() && booth.program) || window.FestivalPrograms?.[booth.officialClubId || booth.id];
    return `<section class="web-program section"><div class="section-heading"><h2>프로그램 안내</h2><span>${p ? "행사 프로그램" : "안내 준비 중"}</span></div>${p ? `<h3>${escapeHtml(p.title)}</h3><p>${escapeHtml(p.description)}</p><dl>${[["운영 시간", p.hours], ["소요 시간", p.duration], ["참여 방법", p.participation], ["준비물", p.materials]].map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value || "추후 안내")}</dd></div>`).join("")}</dl>` : `<p>이 동아리의 행사 프로그램은 아직 등록되지 않았어요. 확정된 활동과 참여 방법이 이곳에 표시됩니다.</p><dl><div><dt>운영 시간</dt><dd>추후 안내</dd></div><div><dt>참여 방법</dt><dd>현장 운영자에게 문의</dd></div></dl>`}${canUseMockNfcTools() ? programEditor(booth, p) : ""}</section>`;
  }

  function programEditor(booth, p = {}) {
    return `<details class="web-program-editor"><summary>프로그램 안내 편집</summary><p class="web-muted">이 브라우저에만 저장됩니다. 공용 DB에는 반영되지 않아요.</p><form id="programEditor" data-booth-id="${booth.id}">
      ${[["title", "프로그램 이름", 80], ["description", "활동 소개", 1000], ["hours", "운영 시간", 100], ["duration", "소요 시간", 100], ["participation", "참여 방법", 300], ["materials", "준비물", 200]].map(([key, label, limit]) => `<label for="program-${key}">${label}${key === "title" || key === "description" ? " (필수)" : ""}</label>${key === "description" ? `<textarea class="textarea" id="program-${key}" name="${key}" maxlength="${limit}" required>${escapeHtml(p[key] || "")}</textarea>` : `<input class="input" id="program-${key}" name="${key}" maxlength="${limit}" value="${escapeHtml(p[key] || "")}" ${key === "title" ? "required" : ""}>`}`).join("")}
      <p id="programFeedback" role="status"></p><button class="primary-btn full-action" type="submit">${icon("save")} 안내 저장</button></form></details>`;
  }

  function saveProgram(event) {
    event.preventDefault();
    if (!canUseMockNfcTools()) return;
    const form = event.currentTarget;
    const data = Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, String(v).trim()]));
    const feedback = form.querySelector("#programFeedback");
    if (!data.title || !data.description) { feedback.textContent = "프로그램 이름과 활동 소개를 입력해 주세요."; return; }
    const next = cloneData(state.db);
    const booth = next.booths.find(b => b.id === form.dataset.boothId);
    if (!booth) return;
    booth.program = data;
    if (!persistDb(next)) { feedback.textContent = "저장하지 못했어요. 입력 내용은 그대로 두었어요."; return; }
    state.db = next;
    render();
    document.querySelector(".web-program-editor summary")?.focus({preventScroll: true});
  }

  function afterRender() {
    if (state.route !== "scan") stopScan();
    if (state.route !== "vouchers") closeVoucher();
    if (!document.querySelector("#reviewContent")) return;
    const own = ownReview(state.selectedBoothId);
    if (own) state.reviewRating = own.rating;
  }

  function refreshIndicators() {
    document.querySelectorAll("[data-complete-count]").forEach(node => { node.textContent = completed().length; });
  }

  async function loadReviewContents() {
    if (!isServerMode() || !state.user) return;
    const user = state.user.id;
    const queue = repo.stampsForUser(user).map(s => s.boothId);
    for (let i = 0; i < queue.length; i += 3) {
      await Promise.all(queue.slice(i, i + 3).map(id => loadBoothReviews(id)));
      if (state.user?.id !== user) return;
    }
    if (state.route === "reviews") render();
  }

  function scanControls() {
    const supported = window.isSecureContext && "NDEFReader" in window;
    return `<section class="web-scan-controls"><button class="primary-btn full-action" id="webNfcScan" ${supported ? "" : "disabled"}>${icon("scan")} ${scanBusy ? "스캔 중지" : "NFC 읽기 시작"}</button><p id="webNfcStatus" role="status">${supported ? "NFC 카드의 링크를 열어도 방문 인증을 이어갈 수 있어요." : "카드에 휴대전화를 대고 표시되는 웹 링크를 열어 주세요. 읽지 못하면 운영자에게 문의해 주세요."}</p></section>`;
  }

  function stopScan() { scanController?.abort(); scanController = null; scanBusy = false; }

  async function startScan() {
    const button = document.querySelector("#webNfcScan");
    const status = document.querySelector("#webNfcStatus");
    if (scanBusy) { stopScan(); button.textContent = "NFC 읽기 시작"; return; }
    if (!window.isSecureContext || !("NDEFReader" in window)) return;
    scanBusy = true;
    const controller = new AbortController();
    scanController = controller;
    button.textContent = "스캔 중지";
    try {
      const reader = new NDEFReader();
      reader.onreading = event => {
        if (controller.signal.aborted || state.route !== "scan") return;
        for (const record of event.message.records) {
          if (record.recordType !== "url") continue;
          try {
            const url = new URL(new TextDecoder().decode(record.data));
            if (url.protocol !== "https:" || url.origin !== location.origin) continue;
            const token = new URLSearchParams(url.hash.slice(1)).get("t");
            if (window.FestivalAccount.TOKEN_PATTERN.test(token || "")) {
              stopScan(); button.textContent = "NFC 읽기 시작";
              nfcAdapter.scan(createNfcClaim(token, "web-nfc")); return;
            }
          } catch { /* Ignore unsupported records. */ }
        }
        if (status?.isConnected) status.textContent = "이 웹사이트에서 발급한 태그가 아니에요.";
      };
      reader.onreadingerror = () => { if (status?.isConnected) status.textContent = "태그를 읽지 못했어요. 다시 가까이 대세요."; };
      await reader.scan({ signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) return;
      stopScan(); if (button?.isConnected) button.textContent = "NFC 읽기 시작";
      if (status?.isConnected) status.textContent = error.name === "NotAllowedError" ? "NFC 권한을 허용하거나 카드의 웹 링크를 열어 주세요." : "스캔을 시작하지 못했어요. NFC 설정을 확인해 주세요.";
    }
  }

  function webTagUrl(token) {
    const url = new URL(location.href);
    if (url.protocol !== "https:" || url.hostname === "appassets.androidplatform.net") return null;
    url.search = ""; url.hash = new URLSearchParams({ t: token }).toString();
    return url.href;
  }

  function bind() {
    document.querySelectorAll("[data-voucher-filter]").forEach(b => b.onclick = () => { voucherFilter = b.dataset.voucherFilter; render(); });
    document.querySelectorAll("[data-voucher]").forEach(b => b.onclick = () => showVoucher(b.dataset.voucher, b));
    document.querySelector("#webNfcScan")?.addEventListener("click", startScan);
    document.querySelector("#programEditor")?.addEventListener("submit", saveProgram);
    document.querySelector("#saveReviewDraft")?.addEventListener("click", () => {
      document.querySelector("#reviewFeedback").textContent = saveDraft()
        ? "이 탭에 임시저장했어요. 탭을 닫기 전 나의 리뷰에서 이어 쓸 수 있어요."
        : "저장 공간을 사용할 수 없어요. 입력한 글은 그대로 두었어요.";
    });
  }

  return { home, stamps, reviews, vouchers, program, ownReview, completed, waiting, reviewPending,
    draft, saveDraft, clearDraft, syncRewards, points, coupons, header, afterRender, refreshIndicators,
    loadReviewContents, scanControls, webTagUrl, bind, REVIEW_POINTS };
})();
