/* Mobile-web experience. Shared DB contracts are never changed by this module. */
const festivalWeb = (() => {
  const REVIEW_POINTS = 10; // Preview policy only; not a production reward amount.
  const REWARD_TITLES = { photo: "포토부스 이용권", food: "푸드트럭 교환권" };
  const REWARD_POLICY = "choice-3-6";
  let rewardBusy = false;
  const progressKey = () => `festival-web-demo:${state.user?.id || "guest"}`;
  const draftKey = id => `festival-review-draft:${isServerMode() ? "server" : "demo"}:${state.user?.id}:${id}`;
  let voucherFilter = "claim";
  let reviewFilter = "pending";
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
    const seen = new Set();
    return state.user ? repo.stampsForUser(state.user.id).filter(s => {
      if (!s.boothId || s.status === 'revoked' || seen.has(s.boothId)) return false;
      seen.add(s.boothId); return true;
    }) : [];
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
    completeSecondReward(value);
    saveProgress(value);
  }

  function appendReward(value, kind, target) {
    value.coupons.push({ id: makeId(), policy: REWARD_POLICY, kind, target, title: REWARD_TITLES[kind],
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), redeemedAt: null });
  }
  function completeSecondReward(value) {
    for (const first of value.coupons.filter(c => c.policy === REWARD_POLICY && c.target === 3 && REWARD_TITLES[c.kind])) {
      if (completed().length >= first.target + 3 && !value.coupons.some(c => c.policy === REWARD_POLICY && c.target === first.target + 3)) {
        appendReward(value, first.kind === "photo" ? "food" : "photo", first.target + 3);
      }
    }
  }
  function rewardState() {
    if (isServerMode()) return festivalOpsUI.snapshot()?.rewardProgram || { ready: false };
    const issued = progress().coupons.filter(c => c.policy === REWARD_POLICY && [3,6].includes(c.target));
    const firstTarget=3;
    return { ready: true, count: completed().length, firstTarget, secondTarget:firstTarget+3, issuedCount:issued.length,
      firstChoice: issued.find(c => c.target === firstTarget)?.kind || null,
      secondIssued: issued.some(c => c.target === 6), canChoose: completed().length >= 3 && !issued.some(c=>c.target===3),
      options: Object.entries(REWARD_TITLES).map(([kind,title]) => ({ kind,title,available:true })) };
  }
  async function chooseReward(kind, firstTarget=rewardState().firstTarget) {
    if (!REWARD_TITLES[kind] || !state.user) return { ok:false, message:"받을 바우처를 선택해 주세요." };
    if (firstTarget!==3) return {ok:false,message:"바우처는 스탬프 3개와 6개에서만 지급돼요."};
    if (isServerMode()) return festivalOpsUI.chooseReward(kind,firstTarget);
    if (completed().length < firstTarget) return { ok:false, message:`완성 스탬프 ${firstTarget}개가 필요해요.` };
    const value = progress();
    const first = value.coupons.find(c => c.policy === REWARD_POLICY && c.target === firstTarget);
    if (!first && firstTarget!==rewardState().firstTarget) return {ok:false,message:"앞선 바우처부터 선택해 주세요."};
    if (first && first.kind !== kind) return { ok:false, message:"이미 선택한 바우처는 바꿀 수 없어요." };
    if (!first) appendReward(value, kind, firstTarget);
    completeSecondReward(value);
    return saveProgress(value) ? { ok:true } : { ok:false, message:"저장하지 못했어요. 다시 시도해 주세요." };
  }
  function rewardPanel() {
    const reward = rewardState();
    if (!reward.ready) return `<section class="reward-choice-section" aria-labelledby="rewardChoiceTitle"><div class="section-heading"><h2 id="rewardChoiceTitle">스탬프 혜택</h2><span>3개·6개, 총 2장</span></div><p role="status">${reward.supported ? '바우처 발급 준비 중이에요. 방문 스탬프는 계속 쌓여요.' : '바우처 발급 상태를 확인하지 못했어요.'}</p>${reward.supported ? '' : `<button type="button" class="ghost-btn" data-ops-refresh>${icon('refresh')} 다시 확인</button>`}</section>`;
    const first = reward.firstChoice, other = first === "photo" ? "food" : "photo", a=reward.firstTarget, b=reward.secondTarget;
    return `<section class="reward-choice-section" aria-labelledby="rewardChoiceTitle"><div class="section-heading"><h2 id="rewardChoiceTitle">스탬프 혜택</h2><span>3개·6개, 총 2장</span></div>
      ${!first ? `<p>${a}개에서 하나 선택, ${b}개에서 나머지 하나</p><form id="rewardChoiceForm"><input type="hidden" name="firstTarget" value="${a}"><fieldset ${rewardBusy || !reward.canChoose ? "disabled" : ""}><legend class="sr-only">받을 바우처 선택</legend><div class="reward-choice-options">${reward.options.map(o => `<label class="reward-option"><input type="radio" name="kind" value="${escapeHtml(o.kind)}" required ${!o.available ? "disabled" : ""}><span>${icon("ticket")}<strong>${escapeHtml(o.title)}</strong>${!o.available ? '<small>발급 대기</small>' : ''}</span></label>`).join("")}</div><button class="primary-btn full-action" type="submit">${reward.count < a ? `스탬프 ${a-reward.count}개 더 필요해요` : rewardBusy ? "발급 중..." : "선택한 바우처 받기"}</button></fieldset><p class="reward-choice-note">선택 후에는 변경할 수 없어요.</p><p class="reward-choice-status" role="status"></p></form>`
      : `<ol class="reward-earned-steps"><li><b>${a}개</b><span>${REWARD_TITLES[first]}</span><strong>지급 완료</strong></li><li><b>${b}개</b><span>${REWARD_TITLES[other]}</span><strong>${reward.secondIssued ? "지급 완료" : reward.count < b ? `${b-reward.count}개 남음` : "발급 대기"}</strong></li></ol>${reward.count >= b && !reward.secondIssued ? `<button class="primary-btn full-action" data-reward-retry="${first}" data-reward-target="${a}" ${rewardBusy || !reward.options.find(o=>o.kind===other)?.available ? 'disabled' : ''}>나머지 바우처 받기</button><p class="reward-choice-status" role="status"></p>` : ''}`}
    </section>`;
  }
  async function redeemRewardChoice(kind, form, firstTarget) {
    if (rewardBusy) return;
    const actor = state.user?.id;
    rewardBusy = true;
    document.querySelectorAll('#rewardChoiceForm fieldset,[data-reward-retry]').forEach(n=>{n.disabled=true;});
    try {
      const result = await chooseReward(kind,firstTarget);
      if (state.user?.id !== actor) return;
      rewardBusy = false;
      if (result.ok) { voucherFilter = 'available'; render(); }
      else { const note = form?.querySelector('[role=status]') || document.querySelector('.reward-choice-status'); if(note) note.textContent=result.message; }
    } finally {
      rewardBusy=false;
      if (state.user?.id === actor) {
        const reward=rewardState(), other=reward.firstChoice==='photo'?'food':'photo';
        document.querySelectorAll('#rewardChoiceForm fieldset').forEach(n=>{n.disabled=!reward.canChoose;});
        document.querySelectorAll('[data-reward-retry]').forEach(n=>{n.disabled=!reward.options?.find(o=>o.kind===other)?.available;});
      }
    }
  }

  function points() { return isServerMode() ? festivalOpsUI.snapshot()?.points ?? null : Object.values(progress().points).reduce((a, b) => a + Number(b), 0); }
  function coupons() { return isServerMode() ? festivalOpsUI.snapshot()?.vouchers || [] : progress().coupons; }
  // The server stores "no deadline" as 'infinity', which Date cannot parse.
  const noDeadline = value => value === 'infinity';
  function couponState(c) { const expiry = c.expiresAt || c.expires_at; return c.state === 'void' ? 'void' : c.redeemedAt || c.state === 'used' ? "used" : !noDeadline(expiry) && new Date(expiry) <= new Date() ? "expired" : "available"; }
  function walletSummary() {
    const reward = rewardState(), all = coupons();
    // Only the server's confirmed reward state can advertise an unissued entitlement.
    const claimable = reward.ready ? Math.max(0, Math.min(2,Math.floor(reward.count / 3)) - reward.issuedCount) : null;
    return { claimable, available: all.filter(c => couponState(c) === 'available').length,
      used: all.filter(c => couponState(c) === 'used').length };
  }
  function walletSummaryView() {
    const wallet = walletSummary();
    return `<dl class="festival-wallet-summary"><div><dt>받을 바우처</dt><dd>${wallet.claimable ?? '—'}<small>장</small></dd></div><div><dt>사용 가능</dt><dd>${wallet.available}<small>장</small></dd></div><div><dt>사용 완료</dt><dd>${wallet.used}<small>장</small></dd></div></dl>`;
  }
  function walletTabs() {
    const summary = walletSummary(), historyCount = coupons().filter(c => couponState(c) !== 'available').length;
    return `<nav class="festival-view-tabs" aria-label="바우처 분류">${[['claim', '받기', summary.claimable ?? '—'], ['available', '보유', summary.available], ['history', '사용·종료', historyCount]].map(([id, label, count]) => `<button type="button" data-voucher-filter="${id}" aria-pressed="${voucherFilter === id}">${label} <span>${count}</span></button>`).join('')}</nav>`;
  }
  function reviewRow(booth) {
    const rated = repo.hasReview(state.user.id, booth.id);
    return `<button type="button" class="web-visit festival-review-row" data-review-booth="${escapeHtml(booth.id)}">${clubVisual(booth)}<span><strong>${boothName(booth)}</strong><small>${rated ? '별점 등록 완료 · 글 후기 남기기' : '방문 완료 · 별점 등록하기'}</small></span>${icon('message')}</button>`;
  }
  function boothName(booth) { return escapeHtml(catalogBooth(booth)?.name || booth.name); }

  // Tab roots (stamps, MY) are reached from the bottom nav, so they skip back/home buttons.
  function header(title, subtitle = "", root = false) {
    const copy = `<div><h1>${title}</h1>${subtitle ? `<p>${subtitle}</p>` : ""}</div>`;
    if (root) return `<header class="web-header root">${copy}</header>`;
    return `<header class="web-header"><button type="button" class="icon-btn" data-history-back="home" aria-label="뒤로 가기">${icon("back")}</button>${copy}<button type="button" class="icon-btn" data-route="home" aria-label="홈">${icon("home")}</button></header>`;
  }

  function rewardSlot(index) { return index===2 || index===5; }

  // The two benefits belong to the fixed three-visit and six-visit milestones.
  function stampCard(count) {
    const goal = count<3?3:6;
    const slots = Array.from({ length: 6 }, (_, i) => {
      const n = i + 1;
      const state = count >= n ? "on" : n === count + 1 ? "next" : "";
      return `<span class="punch ${state}">${n}${rewardSlot(n - 1) ? `<i>${icon("ticket")}</i>` : ""}</span>`;
    }).join("");
    const rewards = rewardState();
    const text = !rewards.ready ? "스탬프 3개·6개에서 바우처 지급"
      : rewards.secondIssued ? "바우처 2장 지급 완료"
      : !rewards.firstChoice && rewards.canChoose ? "받을 바우처를 선택할 수 있어요."
      : rewards.firstChoice && count>=rewards.secondTarget ? "남은 바우처를 확인해 주세요." : `${goal-count}개 더 모으면 바우처를 받아요.`;
    const wallet = walletSummary();
    return `<section class="home-stamp-card" aria-labelledby="homeStampTitle">
      <div class="festival-pass-heading"><div><h2 id="homeStampTitle">내 스탬프</h2><strong class="festival-pass-count"><span data-complete-count>${count}</span><small>개</small></strong></div><button type="button" class="festival-wallet-link ${wallet.claimable > 0 ? 'is-ready' : ''}" data-route="vouchers">${icon('ticket')}<span>${wallet.claimable > 0 ? `받을 바우처 ${wallet.claimable}` : `내 바우처 ${wallet.available}`}</span>${icon('arrow')}</button></div>
      <div class="festival-pass-progress"><div class="punch-row" aria-hidden="true">${slots}</div><button type="button" class="icon-btn" data-route="stamps" aria-label="스탬프 판 보기" title="스탬프 판 보기">${icon('arrow')}</button></div>
      <div class="festival-pass-caption"><p>${text}</p><span>3개·6개 혜택</span></div>
    </section>`;
  }

  // Shown only to roster-eligible accounts whose club membership is not confirmed yet.
  function identityPrompt() {
    const identity = isServerMode() ? festivalOpsUI.identity() : null;
    if (!identity || identity.verified || !identity.eligible) return "";
    return `<button type="button" class="festival-identity-prompt" data-route="identity">${icon("user")}<span><strong>본인 소속 확인을 먼저 해 주세요</strong><small>${identity.locked ? "운영자 확인이 필요해요. 운영 부스에 문의해 주세요." : "소속 동아리를 확인해야 부스에 별점을 남길 수 있어요."}</small></span>${icon("arrow")}</button>`;
  }

  function home() {
    syncRewards();
    const visits = repo.stampsForUser(state.user.id);
    const count = completed().length;
    const pending = waiting().length;
    // Server notices come sorted with important ones first.
    const news = isServerMode() ? (festivalOpsUI.notices?.() || []) : state.db.announcements;
    const notice = isServerMode() ? news.find(n => n.important) || null : news[0];
    const reviewCount = state.db.booths.filter(b => repo.hasReview(state.user.id, b.id)).length;
    const pendingReviews = state.db.booths.filter(reviewPending);
    const toWrite = pendingReviews.length;
    const voucherCount = coupons().filter(c => couponState(c) === "available").length;
    return `<main class="web-home">
      <header class="web-brand"><span class="brand-symbol" aria-hidden="true">P.</span><strong>판교고 축제</strong><div class="web-brand-actions"><button type="button" class="icon-btn" data-route="notices" aria-label="축제 소식" title="축제 소식">${icon("bell")}</button><button type="button" class="icon-btn web-profile-button" data-route="profile" aria-label="내 정보" title="내 정보">${icon("user")}</button></div></header>
      ${notice ? `<button type="button" class="festival-notice-strip" data-notice-open="${escapeHtml(notice.id)}">${icon('notice')}<span>${escapeHtml(notice.title)}</span>${icon('arrow')}</button>` : ''}
      <section class="web-welcome"><h1>${escapeHtml(state.user.name)}님,<br>오늘의 축제를 모아봐요.</h1></section>
      ${identityPrompt()}
      ${state.db.event.emergencyMode ? emergencyBanner() : ""}
      ${stampCard(count)}
      <button type="button" class="web-map-action" data-route="map">
        <span class="map-action-copy"><strong>부스 찾아보기 ${icon("arrow")}</strong><span>층별 지도에서 부스 위치와 운영 상태를 확인해요.</span></span>
        <img class="map-action-art" src="./assets/festival-map-1.4.webp" width="1536" height="1024" alt="" />
      </button>
      <section class="web-section festival-continue"><div class="section-heading"><h2>이어서 남기기</h2><button type="button" class="text-link" data-route="reviews">${toWrite}개 ${icon('arrow')}</button></div>${pendingReviews.length ? pendingReviews.slice(0, 2).map(reviewRow).join('') : `<div class="festival-empty"><span>${icon('message')}</span><strong>남길 후기가 없어요</strong><p>새로운 부스를 방문해 보세요.</p><button type="button" class="ghost-btn" data-route="map">부스 찾아보기 ${icon('arrow')}</button></div>`}</section>
      <section class="web-section home-quick-section">
        <div class="section-heading"><h2>축제 바로가기</h2><button type="button" class="text-link" data-home-menu>전체 메뉴 ${icon("arrow")}</button></div>
        <nav class="web-shortcuts" aria-label="축제 바로가기">
          ${[["vouchers", "ticket", "바우처", `사용 가능 ${voucherCount}장`], ["reviews", "message", "리뷰", toWrite ? `작성할 후기 ${toWrite}개` : `남긴 리뷰 ${reviewCount}개`]].map(([route, symbol, title, text]) => `<button type="button" class="shortcut-${route}" data-route="${route}"><span class="shortcut-symbol ${route}">${icon(symbol)}</span><span class="shortcut-copy"><strong>${title}</strong><small>${text}</small></span>${icon("arrow")}</button>`).join("")}
        </nav>
      </section>
      ${visits.length ? `<section class="web-section"><div class="section-heading"><h2>최근 내 기록</h2><button class="text-link" data-route="stamps">전체 보기 ${icon("arrow")}</button></div>
        <div class="web-records">${visits.slice(-3).reverse().map(visitRow).join("")}</div>
      </section>` : ""}
      <section class="web-section web-announcement" id="homeNews" tabindex="-1">${icon("notice")}<div><div class="section-heading"><h2>축제 소식</h2>${news.length ? `<button type="button" class="text-link" data-route="notices">전체 보기 ${icon('arrow')}</button>` : ''}</div>${news.length ? `<ul class="web-news-list">${news.slice(0, 5).map(n => `<li class="${n.important ? 'important' : ''}"><button type="button" class="web-news-open" data-notice-open="${escapeHtml(n.id)}"><strong>${n.important ? '<span class="web-news-flag">중요</span>' : ''}${escapeHtml(n.title)}</strong>${n.body ? `<p>${escapeHtml(n.body)}</p>` : ''}${n.publishedAt ? `<small>${new Date(n.publishedAt).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' })}${n.images?.length ? ` · 사진 ${n.images.length}장` : ''}</small>` : ''}</button></li>`).join('')}</ul>` : '<strong>등록된 공지가 없어요</strong>'}</div></section>
      <footer class="web-footer">PANGYO HIGH SCHOOL${isServerMode() ? "" : "<span>체험 기록 · 실제 포인트 및 상품 교환 불가</span>"}</footer>
      ${bottomNav("home")}
    </main>`;
  }

  function showMenu(opener) {
    if (document.querySelector(".web-menu-dialog")) return;
    const dialog = document.createElement("dialog");
    const items = [["map", "map", "부스 지도"], ["stamps", "stamp", "나의 스탬프"], ["vouchers", "ticket", "나의 바우처"], ["reviews", "message", "나의 리뷰"], ["profile", "user", "내 정보"]];
    if (isAdminUser()) items.push(["admin", "admin", "관리 마법사"]);
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
    return `<button type="button" class="web-visit" data-review-booth="${booth.id}">${clubVisual(booth)}<span><strong>${boothName(booth)}</strong><small>${escapeHtml(booth.location)}${visit.createdAt ? ` · ${formatTime(visit.createdAt)}` : ""}</small></span><em class="done">적립 완료</em>${icon("arrow")}</button>`;
  }

  function stamps() {
    syncRewards();
    const earned = completed();
    const pending = waiting();
    const restricted = repo.stampsForUser(state.user.id).filter(s => !repo.hasReview(state.user.id, s.boothId) && !reviewEligibility(s.boothId).allowed);
    const goal = earned.length<3?3:6;
    const rewards=rewardState(), claimable=rewards.ready && !rewards.secondIssued && rewards.count>= (rewards.firstChoice?6:3);
    const cycleProgress = Math.min(6,earned.length);
    const older = isServerMode() && festivalOpsUI.snapshot()?.ready && !festivalOpsUI.visitSyncPending?.() ? state.db.booths.filter(b => serverCompletedBooths.includes(boothKeyFor(b)) && !repo.hasStamp(state.user.id,b.id)) : [];
    return `<main class="screen web-page web-stamps stamp-path-page"><header class="stamp-board-header"><h1>스탬프</h1><button type="button" class="stamp-voucher-shortcut" data-route="vouchers">${icon("ticket")}<span>바우처</span>${claimable?'<i aria-label="받을 바우처 있음"></i>':''}</button></header>
      <section class="stamp-path-summary" aria-label="스탬프 진행 상황">
        <div class="stamp-count-line"><span>모은 스탬프</span><strong>${earned.length}<small>개</small></strong></div>
        <div class="stamp-progress-copy"><b>${rewards.ready && rewards.secondIssued?'바우처 2장 지급 완료':claimable?'바우처 받기 가능':!rewards.ready && earned.length>=3?'바우처 발급 상태 확인 대기':`다음 바우처까지 ${Math.max(0,goal-earned.length)}개`}</b><span>3개·6개 혜택</span></div>
        <progress class="stamp-path-progress" max="6" value="${cycleProgress}" aria-label="3개·6개 바우처 진행">${cycleProgress} / 6</progress>
      </section>
      ${pending.length ? `<section class="stamp-rating-pending"><div class="section-heading"><h2>${icon("star")} 방문한 부스 평가 <span>${pending.length}</span></h2></div>${pending.map(visitRow).join("")}</section>` : ""}
      ${restricted.length ? `<section class="web-section"><h2>방문 기록</h2>${restricted.map(s => { const b = state.db.booths.find(x => x.id === s.boothId); return b ? `<button class="web-visit" data-list-select="${escapeHtml(b.id)}">${clubVisual(b)}<span><strong>${boothName(b)}</strong><small>${reviewEligibility(s.boothId).reason === "OWN_CLUB_REVIEW" ? "소속 동아리 · 리뷰 제외" : "이름·소속 확인 대기"}</small></span>${icon("arrow")}</button>` : ""; }).join("")}</section>` : ""}
      ${stampPath(earned, pending, rewards)}
      <details class="stamp-visit-history"><summary><span>완료한 방문</span><span>${earned.length}개 ${icon("arrow")}</span></summary><div class="stamp-history-body"><button class="text-link" data-route="reviews">후기 쓰기 ${icon("arrow")}</button>${earned.length ? earned.slice().reverse().map(visitRow).join("") : `<p class="web-muted">아직 완성된 스탬프가 없어요.</p>`}</div></details>
      ${older.length ? `<section class="web-section"><h2>이전 방문 기록</h2><p class="web-muted">현재 행사 보상 집계 전의 기록</p>${older.map(b=>`<div class="web-visit"><strong>${boothName(b)}</strong><small>시각 미기록</small></div>`).join('')}</section>` : ''}
      ${bottomNav("stamps")}</main>`;
  }

  function stampPath(earned, pending, rewards, interactive = true) {
    const nodeCount = Math.max(15,Math.ceil((earned.length+1)/3)*3);
    return `<section class="stamp-path-track" aria-label="누적 스탬프"><ol class="stamp-path-list">${Array.from({length:nodeCount}, (_, index) => {
      const row=Math.floor(index/3),position=index%3,reverse=row%2===1,column=reverse?3-position:position+1;
      const visit = earned[index];
      const booth = visit && state.db.booths.find(b => b.id === visit.boothId);
      const current = index === earned.length;
      const tone = visit ? "is-earned" : current ? "is-current" : "is-upcoming";
      const label = booth ? boothName(booth) : visit ? "방문 완료" : current ? "부스 찾기" : `${index + 1}번째 스탬프`;
      const target=index+1, reward=target===3 || target===6;
      // Milestones are always visible; only a confirmed snapshot proves issuance or eligibility.
      const issued=reward && rewards.ready && ((target===3 && !!rewards.firstChoice) || (target===6 && rewards.secondIssued));
      const claimable=reward && rewards.ready && !!visit && !issued && target===(rewards.firstChoice?rewards.secondTarget:rewards.firstTarget);
      const rewardLabel=issued?'받음':claimable?'받기 가능':visit?(rewards.ready?'바우처 확인':'확인 대기'):'바우처';
      const face = `<span class="stamp-path-face">${visit && !claimable ? '<small>판교 축제</small>' : ''}${claimable ? `${icon('ticket')}<small>${target}개</small>` : `<b>${target}</b>${visit ? '<small>방문 완료</small>' : reward ? icon('ticket') : ''}`}</span>`;
      const action = !interactive ? "" : reward && visit ? 'data-route="vouchers"' : booth ? `data-list-select="${escapeHtml(booth.id)}"` : current ? 'data-route="map"' : "";
      const accessible=reward?`${target}번째 스탬프, ${visit?rewardLabel:'바우처 지급 지점'}`:`${target}번째 스탬프, ${label}${visit?', 날인 완료':''}`;
      return `<li class="stamp-path-step ${tone}${reverse?' is-reverse':''}${reward?' is-reward':''}${issued?' is-issued':''}${claimable?' is-claimable':''}" style="grid-row:${row+1};grid-column:${column}">
        ${index < nodeCount - 1 ? `<span class="stamp-path-link${position===2?' is-turn':''}" aria-hidden="true"></span>` : ""}
        <div class="stamp-path-stop">
          ${action ? `<button type="button" class="stamp-path-node" ${action} ${current ? 'aria-current="step"' : ""} aria-label="${accessible}">${face}</button>` : `<span class="stamp-path-node" aria-label="${accessible}">${face}</span>`}
          ${reward?`<span class="stamp-reward-marker">${issued?icon('check'):''}${rewardLabel}</span>`:current?`<span class="stamp-current-label">다음 스탬프</span>`:booth?`<span class="stamp-booth-label">${boothName(booth)}</span>`:''}
        </div>
      </li>`;
    }).join("")}</ol></section>`;
  }

  function previewStamps(visits, rewards) {
    return `<section class="stamp-path-page stamp-sim-board" aria-label="모의 스탬프판"><div class="stamp-count-line"><span>모의 스탬프</span><strong>${visits.length}<small>개</small></strong></div>${stampPath(visits,[],rewards,false)}</section>`;
  }

  function reviews() {
    const booths = state.db.booths.filter(b => repo.hasStamp(state.user.id, b.id));
    const pending = booths.filter(reviewPending);
    const written = booths.filter(b => ownReview(b.id)?.content?.trim());
    return `<main class="screen web-page festival-reviews">${header("내 리뷰")}
      <nav class="festival-view-tabs" aria-label="내 리뷰 분류">${[['pending','이어서 쓰기',pending.length],['written','작성한 리뷰',written.length]].map(([id,label,count]) => `<button type="button" data-review-filter="${id}" aria-pressed="${reviewFilter === id}">${label} <span>${count}</span></button>`).join('')}</nav>
      <p class="festival-review-rule">리뷰 작성 시 별점은 필수, 글 후기는 선택<br>글 후기 ${isServerMode() ? festivalOpsUI.snapshot()?.event?.review_points || 0 : REVIEW_POINTS}P · 부스당 한 번만 지급</p>
      <section class="festival-tab-content">${reviewFilter === 'pending' ? pending.length ? pending.map(reviewRow).join('') : `<div class="festival-empty"><span>${icon('check')}</span><strong>남길 후기가 없어요</strong><p>방문한 부스의 후기를 여기에 모아둘게요.</p><button class="ghost-btn" data-route="map">부스 찾아보기</button></div>` : written.map(b => `<article class="web-written"><header><button class="text-link" data-list-select="${escapeHtml(b.id)}">${boothName(b)}</button><span>${icon('star')} ${ownReview(b.id).rating}</span></header><p>${escapeHtml(ownReview(b.id).content)}</p></article>`).join('') || `<div class="festival-empty"><span>${icon('message')}</span><strong>아직 글 후기가 없어요</strong><p>방문한 부스의 이야기를 남겨보세요.</p></div>`}</section>
      ${bottomNav("reviews")}</main>`;
  }

  function voucherCard(c) {
    const status = couponState(c), valid = status === 'available';
    const kind = c.kind || c.reward_kind || (c.title?.includes('포토') ? 'photo' : c.title?.includes('푸드') ? 'food' : 'other');
    const target = c.target || c.stamp_target;
    const expiry = c.expiresAt || c.expires_at;
    const stateLabel = {available:'사용 가능', used:'사용 완료', expired:'만료', void:'발급 취소'}[status];
    return `<article class="festival-ticket ${valid ? kind : 'used'}"><span class="festival-ticket-state">${stateLabel}</span><h2>${escapeHtml(c.title)}</h2>${noDeadline(expiry) ? '<p>사용 기한 없음</p>' : expiry ? `<p>${new Date(expiry).toLocaleString('ko-KR')}까지</p>` : ''}<div class="festival-ticket-bottom"><span>${target ? `스탬프 ${Number(target)}개 달성` : '축제 바우처'}</span>${valid ? `<button type="button" class="text-link" ${isServerMode() ? 'data-ops-qr' : 'data-voucher'}="${escapeHtml(c.id)}">${icon('scan')} QR 보기</button>` : `<span>${stateLabel}</span>`}</div></article>`;
  }
  function vouchers({ loading = false, failure = '' } = {}) {
    syncRewards();
    const all = coupons();
    const list = all.filter(c => voucherFilter === "available" ? couponState(c) === "available" : couponState(c) !== "available");
    return `<main class="screen web-page festival-wallet">${header("바우처")}${walletTabs()}
      <section class="festival-tab-content" aria-busy="${loading}">${failure ? `<p class="ops-alert" role="alert">${escapeHtml(failure)}</p><button class="ghost-btn" data-ops-refresh>${icon('refresh')} 다시 불러오기</button>` : ''}${loading ? '<p role="status">바우처를 불러오는 중이에요.</p>' : voucherFilter === 'claim' ? rewardPanel() : list.length ? list.map(voucherCard).join('') : `<div class="festival-empty"><span>${icon('ticket')}</span><strong>${voucherFilter === 'available' ? '보유한 바우처가 없어요' : '사용한 바우처가 없어요'}</strong><p>${voucherFilter === 'available' ? '달성한 혜택을 받아 보세요.' : '사용·만료·취소된 바우처는 여기에 남아요.'}</p>${voucherFilter === 'available' ? '<button class="ghost-btn" data-voucher-filter="claim">받을 바우처 확인</button>' : ''}</div>`}
      ${!isServerMode() ? '<p class="web-demo-note">시연용 바우처 · 실제 상품으로 교환할 수 없어요.</p>' : ''}<p id="opsVoucherStatus" role="status"></p></section>
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
    const served = isServerMode() && booth.opsRecord?.program && Object.keys(booth.opsRecord.program).length ? booth.opsRecord.program : null;
    const p = served || (!isServerMode() && booth.program) || window.FestivalPrograms?.[booth.officialClubId || booth.id];
    return `<section class="web-program section"><div class="section-heading"><h2>프로그램 안내</h2><span>${p ? "행사 프로그램" : "안내 준비 중"}</span></div>${p ? `${p.title ? `<h3>${escapeHtml(p.title)}</h3>` : ''}${p.description ? `<p>${escapeHtml(p.description)}</p>` : ''}<dl>${[["운영 시간", p.hours], ["소요 시간", p.duration], ["참여 방법", p.participation], ["준비물", p.materials]].map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value || "추후 안내")}</dd></div>`).join("")}</dl>` : `<p>이 동아리의 행사 프로그램은 아직 등록되지 않았어요. 확정된 활동과 참여 방법이 이곳에 표시됩니다.</p><dl><div><dt>운영 시간</dt><dd>추후 안내</dd></div><div><dt>참여 방법</dt><dd>현장 운영자에게 문의</dd></div></dl>`}${canUseMockNfcTools() ? programEditor(booth, p) : ""}</section>`;
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
            // A secure card produces a new one-time link on every read.
            const sun = window.FestivalSun?.parse(url.href);
            if (sun) {
              stopScan(); button.textContent = "NFC 읽기 시작";
              nfcAdapter.scan(createNfcClaim(window.FestivalSun.toToken(sun), "web-nfc")); return;
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
    // Cards always open the site root, whichever admin screen issued them.
    url.pathname = "/"; url.search = ""; url.hash = new URLSearchParams({ t: token }).toString();
    return url.href;
  }

  function bind() {
    document.querySelector('#rewardChoiceForm')?.addEventListener('submit',event=>{
      event.preventDefault(); const form=event.currentTarget;
      const values=new FormData(form);
      redeemRewardChoice(values.get('kind'),form,Number(values.get('firstTarget')));
    });
    document.querySelector('[data-reward-retry]')?.addEventListener('click',event=>redeemRewardChoice(event.currentTarget.dataset.rewardRetry,null,Number(event.currentTarget.dataset.rewardTarget)));
    document.querySelector("[data-home-menu]")?.addEventListener("click", event => showMenu(event.currentTarget));
    document.querySelectorAll("[data-voucher-filter]").forEach(b => b.onclick = () => { voucherFilter = b.dataset.voucherFilter; render(); });
    document.querySelectorAll('[data-review-filter]').forEach(b => b.onclick = () => { reviewFilter = b.dataset.reviewFilter; render(); });
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
    draft, saveDraft, clearDraft, syncRewards, rewardState, rewardPanel, chooseReward, points, coupons, walletSummary, walletSummaryView, header, afterRender, refreshIndicators,
    loadReviewContents, scanControls, webTagUrl, bind, previewStamps, visitRow, REVIEW_POINTS };
})();
