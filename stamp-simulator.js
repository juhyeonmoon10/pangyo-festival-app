/* Operator-only, memory-only simulation. Never calls the real stamp or reward gateway. */
const festivalStampSimulator = (() => {
  const titles = { photo: '포토부스 이용권', food: '푸드트럭 교환권' };
  let owner = null, visits = [], vouchers = [], selected = '', message = '', tone = 'success';
  const h = value => escapeHtml(String(value ?? ''));
  const scope = () => state.user?.id && isAdminUser()
    ? JSON.stringify([state.user.id, isServerMode(), isServerMode() && typeof festivalOpsUI !== 'undefined'
      ? festivalOpsUI.eventId() : state.db.event?.id ?? null]) : null;

  function closePreview(restore = false) {
    const dialog = document.querySelector('.stamp-sim-dialog');
    if (dialog) { dialog.close(); dialog.remove(); }
    if (restore) document.querySelector('[data-stamp-sim-preview]')?.focus({ preventScroll: true });
  }
  function guard() {
    const current = scope();
    if (current !== owner || !current) {
      owner = current; visits = []; vouchers = []; selected = ''; message = '';
      closePreview();
    }
    return !!current;
  }
  const booths = () => state.db.booths.filter(b => !isServerMode() || b.opsRecord || b.officialClubId);
  const denied = () => ({ ok: false, message: '운영자만 사용할 수 있어요.' });
  function autoComplete() {
    for (const first of vouchers.filter(v => v.target === 3)) {
      const target = first.target + 3;
      if (visits.length >= target && !vouchers.some(v => v.target === target)) {
        vouchers.push({ target, kind: first.kind === 'photo' ? 'food' : 'photo' });
      }
    }
  }
  function rewardState() {
    const firstTarget = 3;
    return { ready: true, count: visits.length, firstTarget, secondTarget: firstTarget + 3,
      firstChoice: vouchers.find(v => v.target === firstTarget)?.kind || null,
      secondIssued: vouchers.some(v => v.target === 6), canChoose: visits.length >= 3 && !vouchers.some(v=>v.target===3) };
  }
  function snapshot() {
    if (!guard()) return null;
    return { visits: visits.map(v => ({ ...v })), vouchers: vouchers.map(v => ({ ...v })), reward: rewardState() };
  }
  function issue(boothId) {
    if (!guard()) return denied();
    const booth = booths().find(b => b.id === boothId);
    if (!booth) return { ok: false, message: '테스트할 부스를 선택해 주세요.' };
    if (visits.some(v => v.boothId === boothId)) return { ok: false, message: '이 부스는 이미 모의 발급했어요.' };
    visits.push({ boothId, createdAt: new Date().toISOString() });
    selected = boothId;
    autoComplete();
    return { ok: true, message: `${booth.name} 스탬프를 모의 발급했어요.` };
  }
  function choose(kind, target) {
    if (!guard()) return denied();
    if (!Object.hasOwn(titles, kind) || target!==3) return { ok: false, message: '바우처는 스탬프 3개와 6개에서만 지급돼요.' };
    const existing = vouchers.find(v => v.target === target);
    if (existing) return existing.kind === kind ? { ok: true, message: '이미 모의 발급된 바우처예요.' }
      : { ok: false, message: '이미 선택한 바우처는 바꿀 수 없어요.' };
    const reward = rewardState();
    if (target !== reward.firstTarget || !reward.canChoose) return { ok: false, message: '필요한 스탬프를 먼저 모의 발급해 주세요.' };
    vouchers.push({ target, kind });
    autoComplete();
    return { ok: true, message: `${titles[kind]}를 모의 발급했어요.` };
  }
  function reset() {
    if (!guard()) return denied();
    visits = []; vouchers = []; selected = '';
    closePreview();
    return { ok: true, message: '모의 발급 기록만 초기화했어요.' };
  }
  function view() {
    if (!guard()) return '';
    const list = booths(), reward = rewardState();
    const current = list.find(b => b.id === selected) || list[0];
    selected = current?.id || '';
    const already = visits.some(v => v.boothId === selected);
    const next = visits.length<3?3:6;
    return `<section class="stamp-simulator" data-stamp-simulator aria-label="스탬프 모의 발급">
      <header class="stamp-sim-heading"><h1>스탬프 모의 발급</h1><span>테스트 전용</span></header>
      <p class="stamp-sim-boundary">완성 스탬프를 가정한 테스트예요. 실제 방문·별점·포인트·바우처는 바뀌지 않으며, 새로고침하면 모의 기록이 사라집니다.</p>
      <dl class="stamp-sim-stats"><div><dt>모의 스탬프</dt><dd>${visits.length}<small>개</small></dd></div><div><dt>모의 바우처</dt><dd>${vouchers.length}<small>장</small></dd></div></dl>
      <form id="stampSimIssueForm" class="stamp-sim-form"><label for="stampSimBooth">발급할 부스</label><select id="stampSimBooth" class="select" ${list.length?'':'disabled'}>${list.map(b=>`<option value="${h(b.id)}" ${b.id===selected?'selected':''}>${h(b.name)}${visits.some(v=>v.boothId===b.id)?' · 발급됨':''}</option>`).join('')}</select>
        <button type="submit" id="stampSimIssue" class="primary-btn" ${!current||already?'disabled':''}>${icon('stamp')} ${already?'이 부스 발급 완료':'모의 발급'}</button>
      </form>
      ${!list.length?'<p class="stamp-sim-note">테스트할 부스가 없어요.</p>':''}
      <p class="stamp-sim-status" role="status" data-tone="${tone}">${h(message)}</p>
      <div class="stamp-sim-actions"><button type="button" class="ghost-btn" data-stamp-sim-preview>${icon('stamp')} 스탬프판 확인</button><button type="button" class="icon-btn" data-stamp-sim-reset aria-label="모의 기록 초기화" title="모의 기록 초기화" ${visits.length?'':'disabled'}>${icon('refresh')}</button></div>
      <section class="stamp-sim-rewards"><h2>바우처 모의 발급</h2>
        ${!reward.firstChoice && reward.canChoose?`<form id="stampSimRewardForm"><input type="hidden" name="target" value="${reward.firstTarget}"><fieldset><legend>스탬프 ${reward.firstTarget}개 달성</legend>${Object.entries(titles).map(([kind,title])=>`<label><input type="radio" name="kind" value="${kind}" required><span>${title}</span></label>`).join('')}</fieldset><button type="submit" class="primary-btn">선택한 바우처 모의 발급</button></form>`:`<p class="stamp-sim-note">${reward.secondIssued?'바우처 2장 모의 지급 완료':`${Math.max(0,next-visits.length)}개 더 발급하면 ${next}개 바우처를 테스트할 수 있어요.`}</p>`}
        <ul class="stamp-sim-vouchers">${vouchers.map(v=>`<li><span>${icon('ticket')}<strong>${titles[v.kind]}</strong></span><small>${v.target}개 · 모의 발급</small></li>`).join('')}</ul>
      </section>
      <details class="stamp-sim-history"><summary>모의 발급 기록 <span>${visits.length}개</span></summary><ul>${visits.slice().reverse().map(v=>`<li><span>${h(state.db.booths.find(b=>b.id===v.boothId)?.name || '삭제된 부스')}</span><time>${new Date(v.createdAt).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'})}</time></li>`).join('')}</ul></details>
    </section>`;
  }
  function repaint(result, focus) {
    if (!guard()) { document.querySelector('[data-stamp-simulator]')?.remove(); return; }
    if (result) { message = result.message; tone = result.ok ? 'success' : 'error'; }
    const root = document.querySelector('[data-stamp-simulator]');
    if (root) { root.outerHTML = view(); bind(); }
    if (focus) document.querySelector(focus)?.focus({ preventScroll: true });
  }
  function preview() {
    const current = snapshot();
    if (!current) return;
    closePreview();
    const dialog = document.createElement('dialog');
    dialog.className = 'stamp-sim-dialog';
    dialog.setAttribute('aria-labelledby', 'stampSimPreviewTitle');
    dialog.innerHTML = `<header><div><h2 id="stampSimPreviewTitle">스탬프판 확인</h2><span>테스트 전용 · 실제 기록 아님</span></div><button type="button" class="icon-btn" data-stamp-sim-close aria-label="닫기">${icon('close')}</button></header>${festivalWeb.previewStamps(current.visits,current.reward)}`;
    dialog.querySelector('[data-stamp-sim-close]').onclick = () => closePreview(true);
    dialog.addEventListener('cancel', event => { event.preventDefault(); closePreview(true); });
    dialog.addEventListener('click', event => { if (event.target === dialog) closePreview(true); });
    document.body.append(dialog);
    dialog.showModal();
  }
  function bind() {
    if (!guard()) { document.querySelector('[data-stamp-simulator]')?.remove(); return; }
    if (state.route !== 'admin' || !document.querySelector('[data-stamp-simulator]')) { closePreview(); return; }
    const form = document.querySelector('#stampSimIssueForm');
    if (form) form.onsubmit = event => {
      event.preventDefault();
      repaint(issue(document.querySelector('#stampSimBooth').value), '#stampSimBooth');
    };
    const select = document.querySelector('#stampSimBooth');
    if (select) select.onchange = () => { selected = select.value; message = ''; repaint(null, '#stampSimBooth'); };
    const reward = document.querySelector('#stampSimRewardForm');
    if (reward) reward.onsubmit = event => {
      event.preventDefault();
      const data = new FormData(reward);
      repaint(choose(data.get('kind'), Number(data.get('target'))), '[data-stamp-sim-preview]');
    };
    const resetButton = document.querySelector('[data-stamp-sim-reset]');
    if (resetButton) resetButton.onclick = () => {
      if (guard() && confirm('이 화면의 모의 스탬프와 모의 바우처만 초기화할까요? 실제 기록은 유지돼요.')) repaint(reset(), '#stampSimBooth');
    };
    const previewButton = document.querySelector('[data-stamp-sim-preview]');
    if (previewButton) previewButton.onclick = preview;
  }
  return { view, bind, issue, choose, reset, snapshot, preview };
})();
