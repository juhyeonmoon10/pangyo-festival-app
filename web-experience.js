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
    const saved = festivalOpsUI.snapshot()?.reviews?.find(r => r.booth_key === boothKeyFor(state.db.booths.find(b => b.id === id)));
    if (saved) return saved;
    const remote = serverReviewState(id);
    return remote?.reviews?.find(r => r.mine) || (remote?.myRating ? { rating: remote.myRating, unknownContent: true } : null);
  }

  function completed() {
    return state.user ? repo.stampsForUser(state.user.id).filter(s => repo.hasReview(state.user.id, s.boothId)) : [];
  }

  function waiting() {
    return state.user ? repo.stampsForUser(state.user.id).filter(s => !repo.hasReview(state.user.id, s.boothId) && reviewEligibility(s.boothId).allowed) : [];
  }

  function reviewPending(booth) {
    if (!state.user || !repo.hasStamp(state.user.id, booth.id) || !reviewEligibility(booth.id).allowed) return false;
    const own = ownReview(booth.id);
    return !own || own.unknownContent || !own.content?.trim();
  }

  function draft(id) {
    try { return JSON.parse(readSessionStorage(draftKey(id)) || "null") || { rating: 0, content: "" }; }
    catch { return { rating: 0, content: "" }; }
  }

  function saveDraft() {
    if (!state.user || !state.selectedBoothId || !reviewEligibility(state.selectedBoothId).allowed) return false;
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

  function points() { return isServerMode() ? festivalOpsUI.snapshot()?.points ?? null : Object.values(progress().points).reduce((a, b) => a + Number(b), 0); }
  function coupons() { return isServerMode() ? festivalOpsUI.snapshot()?.vouchers || [] : progress().coupons; }
  function couponState(c) { return c.state === 'void' ? 'void' : c.redeemedAt || c.state === 'used' ? "used" : new Date(c.expiresAt) <= new Date() ? "expired" : "available"; }
  function boothName(booth) { return escapeHtml(catalogBooth(booth)?.name || booth.name); }

  // Tab roots (stamps, MY) are reached from the bottom nav, so they skip back/home buttons.
  function header(title, subtitle = "", root = false) {
    const copy = `<div><h1>${title}</h1>${subtitle ? `<p>${subtitle}</p>` : ""}</div>`;
    if (root) return `<header class="web-header root">${copy}</header>`;
    return `<header class="web-header"><button type="button" class="icon-btn" data-history-back="home" aria-label="뒤로 가기">${icon("back")}</button>${copy}<button type="button" class="icon-btn" data-route="home" aria-label="홈">${icon("home")}</button></header>`;
  }

  // Demo vouchers drop at 5 and 10 stamps; server rules are operator-set, so no slot is marked there.
  function rewardSlot(index) { return !isServerMode() && (index === 4 || index === 9); }

  // Five slots toward the next demo voucher.
  function stampCard(count) {
    const goal = count >= 5 ? 10 : 5;
    const slots = Array.from({ length: 5 }, (_, i) => {
      const n = goal - 5 + i + 1;
      const state = count >= n ? "on" : n === count + 1 ? "next" : "";
      return `<span class="punch ${state}">${count >= n ? icon("stamp") : n}${rewardSlot(n - 1) && count < n ? `<i>${icon("ticket")}</i>` : ""}</span>`;
    }).join("");
    const text = isServerMode()
      ? "부스 방문 후 별점까지 남기면 스탬프가 찍혀요."
      : !count ? "부스의 NFC 태그에 휴대폰을 대고 별점을 남기면 스탬프가 찍혀요."
        : count >= 10 ? "체험 바우처를 모두 받았어요." : `${goal - count}개 더 모으면 체험 바우처를 받아요.`;
    return `<section class="home-stamp-card" aria-labelledby="homeStampTitle">
      <div class="section-heading"><h2 id="homeStampTitle">내 스탬프 <b data-complete-count>${count}</b>개</h2><button type="button" class="text-link" data-route="stamps">스탬프 판 ${icon("arrow")}</button></div>
      <p>${text}</p>
      <div class="punch-row" aria-hidden="true">${slots}</div>
    </section>`;
  }

  function home() {
    syncRewards();
    const visits = repo.stampsForUser(state.user.id);
    const count = completed().length;
    const pending = waiting().length;
    const notice = isServerMode() ? null : state.db.announcements[0];
    const reviewCount = state.db.booths.filter(b => repo.hasReview(state.user.id, b.id)).length;
    const toWrite = state.db.booths.filter(reviewPending).length;
    const voucherCount = coupons().filter(c => couponState(c) === "available").length;
    return `<main class="web-home">
      <header class="web-brand"><span class="brand-symbol" aria-hidden="true">P.</span><strong>판교고 축제</strong><div class="web-brand-actions"><button type="button" class="icon-btn" data-home-notices aria-label="축제 소식" title="축제 소식">${icon("bell")}</button><button type="button" class="icon-btn web-profile-button" data-route="profile" aria-label="내 정보" title="내 정보">${icon("user")}</button></div></header>
      <section class="web-welcome">
        <div class="welcome-copy"><h1>${escapeHtml(state.user.name)}님,<br>오늘 어디부터 가볼까요?</h1><p>즐기고, 모으고, 기록하는<br>우리의 축제.</p></div>
        <img class="welcome-art" src="./assets/festival-school-1.4.webp" width="1536" height="1024" alt="" fetchpriority="high" />
      </section>
      ${state.db.event.emergencyMode ? emergencyBanner() : ""}
      <button type="button" class="web-map-action" data-route="map">
        <span class="map-action-copy"><strong>부스 찾아보기 ${icon("arrow")}</strong><span>층별 지도에서 부스 위치와 운영 상태를 확인해요.</span></span>
        <img class="map-action-art" src="./assets/festival-map-1.4.webp" width="1536" height="1024" alt="" />
      </button>
      ${stampCard(count)}
      ${pending ? `<button class="web-pending" data-route="stamps">${icon("star")}<span><strong>별점을 기다리는 방문 ${pending}개</strong><small>별점을 남기면 스탬프가 완성돼요.</small></span>${icon("arrow")}</button>` : ""}
      <section class="web-section home-quick-section">
        <div class="section-heading"><h2>바로가기</h2><button type="button" class="text-link" data-home-menu>전체 메뉴 ${icon("arrow")}</button></div>
        <nav class="web-shortcuts" aria-label="축제 바로가기">
          ${[["vouchers", "ticket", "바우처", `사용 가능 ${voucherCount}장`], ["reviews", "message", "리뷰", toWrite ? `작성할 후기 ${toWrite}개` : `남긴 리뷰 ${reviewCount}개`]].map(([route, symbol, title, text]) => `<button type="button" class="shortcut-${route}" data-route="${route}"><span class="shortcut-symbol ${route}">${icon(symbol)}</span><span class="shortcut-copy"><strong>${title}</strong><small>${text}</small></span>${icon("arrow")}</button>`).join("")}
        </nav>
      </section>
      ${visits.length ? `<section class="web-section"><div class="section-heading"><h2>최근 내 기록</h2><button class="text-link" data-route="stamps">전체 보기 ${icon("arrow")}</button></div>
        <div class="web-records">${visits.slice(-3).reverse().map(visitRow).join("")}</div>
      </section>` : ""}
      <section class="web-section web-announcement" id="homeNews" tabindex="-1">${icon("notice")}<div><h2>축제 소식</h2><strong>${notice ? escapeHtml(notice.title) : "등록된 공지가 없어요"}</strong>${notice ? `<p>${escapeHtml(notice.body)}</p>` : ""}</div></section>
      <footer class="web-footer">PANGYO HIGH SCHOOL${isServerMode() ? "" : "<span>체험 기록 · 실제 포인트 및 상품 교환 불가</span>"}</footer>
      ${bottomNav("home")}
    </main>`;
  }

  function showMenu(opener) {
    if (document.querySelector(".web-menu-dialog")) return;
    const dialog = document.createElement("dialog");
    const items = [["map", "map", "부스 지도"], ["stamps", "stamp", "나의 스탬프"], ["vouchers", "ticket", "나의 바우처"], ["reviews", "message", "나의 리뷰"], ["profile", "user", "내 정보"]];
    if (isAdminUser()) items.push(["admin", "admin", "운영자 도구"]);
    dialog.className = "web-menu-dialog";
    dialog.setAttribute("aria-labelledby", "festivalMenuTitle");
    dialog.innerHTML = `<header><h2 id="festivalMenuTitle">전체 메뉴</h2><button type="button" class="icon-btn" data-menu-close aria-label="닫기">${icon("close")}</button></header><nav aria-label="전체 메뉴">${items.map(([route, symbol, label]) => `<button type="button" data-menu-route="${route}"><span class="shortcut-symbol ${route}">${icon(symbol)}</span><strong>${label}</strong>${icon("arrow")}</button>`).join("")}</nav>`;
    const close = () => { dialog.close(); dialog.remove(); opener?.focus({ preventScroll: true }); };
    dialog.querySelector("[data-menu-close]").onclick = close;
    dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
    dialog.addEventListener("click", event => { if (event.target === dialog) close(); });
    dialog.querySelectorAll("[data-menu-route]").forEach(button => button.onclick = () => {
      const route = button.dataset.menuRoute;
      close();
      navigateTo(route);
    });
    document.body.append(dialog);
    dialog.showModal();
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
    const restricted = repo.stampsForUser(state.user.id).filter(s => !repo.hasReview(state.user.id, s.boothId) && !reviewEligibility(s.boothId).allowed);
    const goal = Math.max(5, Math.ceil((earned.length || 1) / 5) * 5);
    const stageCount = earned.length - goal + 5;
    const older = isServerMode() && festivalOpsUI.snapshot()?.ready ? state.db.booths.filter(b => serverCompletedBooths.includes(boothKeyFor(b)) && !repo.hasStamp(state.user.id,b.id)) : [];
    return `<main class="screen web-page web-stamps stamp-path-page">${header("나의 스탬프", "오늘의 축제를 하나씩 완성해요", true)}
      <section class="stamp-path-summary" aria-label="스탬프 진행 상황">
        <div class="stamp-path-total"><span class="stamp-total-icon">${icon("stamp")}</span><div><span>모은 스탬프</span><strong>${earned.length}<small>개</small></strong></div><button type="button" class="stamp-voucher-shortcut" data-route="vouchers">${icon("ticket")}<span>바우처</span>${icon("arrow")}</button></div>
        <div class="stamp-progress-copy"><span>${stageCount === 5 ? `${goal}번째 기록 완성!` : `${goal}번째 기록까지 ${5 - stageCount}개`}</span><b>${stageCount} / 5</b></div>
        <progress class="stamp-path-progress" max="5" value="${stageCount}" aria-label="현재 다섯 개 기록 묶음의 진행">${stageCount} / 5</progress>
      </section>
      ${pending.length ? `<section class="stamp-rating-pending"><div class="section-heading"><h2>${icon("star")} 완성까지 별점 하나 <span>${pending.length}</span></h2></div>${pending.map(visitRow).join("")}</section>` : ""}
      ${stampPath(earned, pending)}
      <section class="web-section"><div class="section-heading"><h2>완료한 방문</h2><button class="text-link" data-route="reviews">후기 쓰기 ${icon("arrow")}</button></div>${earned.length ? earned.slice().reverse().map(visitRow).join("") : `<p class="web-muted">아직 완성된 스탬프가 없어요.</p>`}</section>
      ${restricted.length ? `<section class="web-section"><h2>방문 기록</h2>${restricted.map(s => { const b = state.db.booths.find(x => x.id === s.boothId); return b ? `<button class="web-visit" data-list-select="${escapeHtml(b.id)}">${clubVisual(b)}<span><strong>${boothName(b)}</strong><small>${reviewEligibility(s.boothId).reason === "OWN_CLUB_REVIEW" ? "소속 동아리 · 리뷰 제외" : "이름·소속 확인 대기"}</small></span>${icon("arrow")}</button>` : ""; }).join("")}</section>` : ""}
      ${older.length ? `<section class="web-section"><h2>이전 방문 기록</h2><p class="web-muted">현재 행사 보상 집계 전의 기록</p>${older.map(b=>`<div class="web-visit"><strong>${boothName(b)}</strong><small>시각 미기록</small></div>`).join('')}</section>` : ''}
      ${bottomNav("stamps")}</main>`;
  }

  function stampPath(earned, pending) {
    const chapterCount = Math.max(2, Math.ceil((earned.length + 1) / 5));
    const offsets = [0, -1, 0, 1, 0];
    return `<div class="stamp-path-chapters">${Array.from({ length: chapterCount }, (_, chapter) => {
      const first = chapter * 5;
      const last = first + 5;
      const finished = earned.length >= last;
      const title = chapter === 0 ? "설레는 첫 발걸음" : chapter === 1 ? "축제를 더 가까이" : "계속 쌓이는 우리 순간";
      return `<section class="stamp-path-chapter ${finished ? "is-complete" : ""}" aria-labelledby="stampChapter${chapter}">
        <header class="stamp-chapter-heading"><span class="stamp-chapter-symbol">${icon(finished ? "check" : "map")}</span><div><p>${String(chapter + 1).padStart(2, "0")} · 스탬프 ${first + 1}~${last}</p><h2 id="stampChapter${chapter}">${title}</h2></div>${finished ? `<span class="stamp-chapter-complete">완성</span>` : ""}</header>
        <ol class="stamp-path-list" start="${first + 1}">${offsets.map((offset, local) => {
          const index = first + local;
          const visit = earned[index];
          const booth = visit && state.db.booths.find(b => b.id === visit.boothId);
          const current = index === earned.length;
          const tone = visit ? "is-earned" : current ? "is-current" : "is-upcoming";
          const label = booth ? boothName(booth) : visit ? "방문 완료" : current ? (pending.length ? "별점 남기기" : "부스 찾기") : `${index + 1}번째 스탬프`;
          const face = `<span class="stamp-path-face">${icon(visit ? "check" : current ? "star" : "stamp")}</span>`;
          const action = booth ? `data-list-select="${booth.id}"` : current ? (pending.length ? `data-review-booth="${pending[0].boothId}"` : 'data-route="map"') : "";
          const nextOffset = offsets[local + 1];
          return `<li class="stamp-path-step ${tone}" style="--step-offset:${offset};--link-direction:${nextOffset === undefined ? 0 : nextOffset - offset}">
            ${local < 4 ? `<span class="stamp-path-link" aria-hidden="true"></span>` : ""}
            <div class="stamp-path-stop">${current ? `<span class="stamp-next-label">${pending.length ? "거의 다 왔어요!" : earned.length ? "다음 스탬프" : "여기서 시작!"}</span>` : ""}
              ${action ? `<button type="button" class="stamp-path-node" ${action} ${current ? 'aria-current="step"' : ""} aria-label="${index + 1}번째 스탬프, ${label}${visit ? ', 날인 완료' : ''}">${face}</button>` : `<span class="stamp-path-node" aria-label="${index + 1}번째 스탬프, ${visit ? '날인 완료' : '아직 방문 전'}">${face}</span>`}
              <span class="stamp-path-caption">${label}</span>
            </div>
          </li>`;
        }).join("")}</ol>
        ${rewardSlot(last - 1) ? `<${finished ? 'button type="button" data-route="vouchers"' : 'div'} class="stamp-path-milestone ${finished ? 'is-ready' : ''}"><span>${icon("ticket")}</span><div><strong>${finished ? "체험 바우처가 도착했어요!" : `스탬프 ${last}개, 작은 선물`}</strong><small>${finished ? "바우처 확인" : "체험 바우처 · 실제 교환 불가"}</small></div>${finished ? icon("arrow") : icon("lock")}</${finished ? 'button' : 'div'}>` : ''}
      </section>`;
    }).join("")}</div>`;
  }

  function reviews() {
    const booths = state.db.booths.filter(b => repo.hasStamp(state.user.id, b.id));
    const pending = booths.filter(reviewPending);
    return `<main class="screen web-page">${header("나의 리뷰", "별점은 필수, 글 후기는 선택")}
      <section class="web-review-benefit">${icon("message")}<div><h2>못 남긴 이야기, 이어서</h2><p>${isServerMode() ? `글 후기를 처음 등록하면 ${festivalOpsUI.snapshot()?.event?.review_points || 0}P를 받아요. 부스당 한 번만 지급돼요.` : `글 후기를 처음 등록하면 체험 포인트 ${REVIEW_POINTS}P를 받아요. 부스당 한 번만 지급돼요.`}</p></div></section>
      <section class="web-section"><div class="section-heading"><h2>작성할 후기 <span>${pending.length}</span></h2></div>${pending.length ? pending.map(b => visitRow({boothId: b.id})).join("") : `<div class="web-empty-inline">${icon("check")}<p>${booths.length ? "모든 후기를 남겼어요." : "부스 방문 후 후기를 남길 수 있어요."}</p></div>`}</section>
      <section class="web-section"><div class="section-heading"><h2>남긴 후기</h2></div>${booths.filter(b => ownReview(b.id)?.content?.trim()).map(b => `<article class="web-written"><header><strong>${boothName(b)}</strong><span>${icon("star")} ${ownReview(b.id).rating}</span></header><p>${escapeHtml(ownReview(b.id).content)}</p></article>`).join("") || `<p class="web-muted">아직 글 후기가 없어요.</p>`}</section>
      ${bottomNav("reviews")}</main>`;
  }

  function vouchers() {
    syncRewards();
    const all = coupons();
    const list = all.filter(c => voucherFilter === "available" ? couponState(c) === "available" : couponState(c) !== "available");
    return `<main class="screen web-page">${header("나의 바우처", "축제에서 모은 작은 혜택")}
      <div class="web-segments" role="group" aria-label="바우처 상태"><button data-voucher-filter="available" aria-pressed="${voucherFilter === "available"}">사용 가능 ${all.filter(c => couponState(c) === "available").length}</button><button data-voucher-filter="history" aria-pressed="${voucherFilter === "history"}">사용 완료 · 만료</button></div>
      ${isServerMode() ? `<div class="web-empty"><span>${icon("ticket")}</span><h2>바우처를 준비하고 있어요</h2><p>쿠폰 발급과 교환은 아직 이용할 수 없어요.<br>방문 기록은 그대로 유지돼요.</p></div>` : `<p class="web-demo-note">시연용 바우처 · 실제 상품으로 교환할 수 없어요.</p>${list.length ? `<div class="web-coupons">${list.map(c => `<article class="web-coupon"><span class="coupon-symbol">${icon("ticket")}</span><div><small>DEMO · 스탬프 ${c.target}개 달성</small><h2>${c.title}</h2><p>${new Date(c.expiresAt).toLocaleDateString("ko-KR")}까지</p></div><button class="${couponState(c) === "available" ? "primary-btn" : "ghost-btn"}" data-voucher="${c.id}" ${couponState(c) === "available" ? "" : "disabled"}>${couponState(c) === "available" ? "QR 보기" : couponState(c) === "used" ? "사용 완료" : "만료"}</button></article>`).join("")}</div>` : `<div class="web-empty"><span>${icon("ticket")}</span><h2>${voucherFilter === "available" ? "사용 가능한 바우처가 없어요" : "아직 사용 내역이 없어요"}</h2><p>별점까지 등록한 스탬프 5개, 10개를 모으면<br>체험용 바우처가 한 장씩 발급돼요.</p><button class="ghost-btn" data-route="stamps">스탬프 보기</button></div>`}`}
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
    if (isServerMode() && booth.opsRecord?.description) return `<section class="web-program section"><h2>프로그램 안내</h2><p>${escapeHtml(booth.opsRecord.description)}</p></section>`;
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
    document.querySelector("[data-home-menu]")?.addEventListener("click", event => showMenu(event.currentTarget));
    document.querySelector("[data-home-notices]")?.addEventListener("click", () => {
      const section = document.querySelector("#homeNews");
      section?.scrollIntoView({ block: "center", behavior: "instant" });
      section?.focus({ preventScroll: true });
    });
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
