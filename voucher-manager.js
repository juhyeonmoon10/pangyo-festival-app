/* 바우처 담당자: students an operator put in charge of approving voucher use (사용 승인) for one
   kind — 푸드트럭 바우처 담당자 (food) or 포토부스 바우처 담당자 (photo). They only check and redeem
   voucher codes of that kind, on the 부스 관리 screen (route 'manage'); they cannot redeem their own.
   Every action is re-checked by festival_voucher_redeem; operators grant the role in 권한 관리.
   Results are shown next to the button that was pressed (spotMarkup/showSpot). */
const festivalVoucherManager = (() => {
  let owner = null, status = null, loading = false, failure = '', note = null, busy = false;
  let adminList = null, adminLoading = false, adminFailure = '', candidate = null, adminNote = null, adminQuery = null;
  const h = value => escapeHtml(String(value ?? ''));
  const ops = () => festivalAccount?.operations;
  const ROLES = { food: '푸드트럭 바우처 담당자', photo: '포토부스 바우처 담당자' };
  const NAMES = { food: '푸드트럭', photo: '포토부스' };
  const CODE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/;
  const slot = at => spotMarkup(note, at);
  const adminSlot = at => spotMarkup(adminNote, at);
  function report(at, text, tone = 'error', redraw = false) {
    note = text ? { at, text, tone } : null;
    if (redraw || !showSpot(at, text, tone)) { render(); showSpot(at, text, tone); }
  }
  function reportAdmin(at, text, tone = 'error', redraw = false) {
    adminNote = text ? { at, text, tone } : null;
    if (redraw || !showSpot(at, text, tone)) { render(); showSpot(at, text, tone); }
  }

  function reset() {
    owner = state.user?.id || null; status = null; failure = ''; note = null; busy = false;
    adminList = null; adminFailure = ''; candidate = null; adminNote = null; adminQuery = null;
  }

  async function load() {
    if (loading || !ops()) return;
    loading = true;
    const actor = state.user?.id;
    const response = await ops().read('voucher_manager');
    loading = false;
    if (state.user?.id !== actor) return;
    // A server without voucher-managers.sql refuses 'status' (INVALID_INPUT): treat it as "no kinds".
    if (response.ok) { status = response.data; failure = ''; }
    else if (['OPS_NOT_READY', 'INVALID_INPUT'].includes(response.code)) status = { isAdmin: false, kinds: [] };
    else failure = response.message;
    if (['manage', 'profile'].includes(state.route)) render();
  }

  // Kinds this student approves. Operators redeem in 관리 마법사, so they get none here.
  const kinds = () => status && !status.isAdmin ? (status.kinds || []).filter(k => ROLES[k]) : [];
  const ready = () => Boolean(status || failure);

  function profileButton() {
    if (!isServerMode() || !kinds().length) return '';
    return `<button type="button" class="ghost-btn full-action" data-route="manage">${icon('ticket')} ${h(`바우처 사용 승인 · ${kinds().map(k => NAMES[k]).join(', ')}`)}</button>`;
  }

  function section() {
    if (owner !== (state.user?.id || null)) reset();
    if (failure) return `<section class="ops-section"><h2>바우처 사용 승인</h2><p class="ops-alert" role="alert">${h(failure)}</p><button type="button" class="ghost-btn" data-vm-retry>${icon('refresh')} 다시 불러오기</button></section>`;
    if (!kinds().length) return '';
    return `<section class="ops-section voucher-manager"><h2>바우처 사용 승인</h2>
      <p class="web-muted">${kinds().map(k => h(ROLES[k])).join(' · ')}</p>
      <p>학생 바우처 화면의 QR을 카메라로 스캔하거나 인증키 8자리를 입력해 확인한 뒤, 상품을 전달하고 사용 완료로 처리해요. ${kinds().map(k => NAMES[k]).join('·')} 바우처만 승인할 수 있고, 본인 바우처는 승인할 수 없어요.</p>
      <button type="button" class="primary-btn full-action" data-vm-camera ${busy ? 'disabled' : ''}>${icon('scan')} QR 스캔으로 승인</button>
      <form class="ops-form" data-vm-redeem><label>인증키 (8자리)<input class="input ops-code-input" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" required maxlength="11" placeholder="예: AB12CD34"></label>
        ${slot('vm-redeem')}<button class="ghost-btn" type="submit" ${busy ? 'disabled' : ''}>${icon('ticket')} 인증키로 확인</button></form></section>`;
  }

  async function redeem(form) {
    if (busy) return;
    const code = form.elements.code.value.toUpperCase().replace(/[\s-]/g, '');
    if (!CODE.test(code)) { report('vm-redeem', '인증키 8자리를 확인해 주세요.'); return; }
    const button = form.querySelector('button[type=submit]'), actor = state.user?.id;
    busy = true; button.disabled = true; note = null;
    showSpot('vm-redeem', '확인하는 중...', 'info');
    try {
      const preview = await ops().read('voucher_code_check', { code });
      if (state.user?.id !== actor || !form.isConnected) return;
      if (!preview.ok) { report('vm-redeem', preview.code === 'VOUCHER_INVALID' ? '맞지 않거나 시간이 지난 인증키예요. 학생 화면의 새 인증키를 확인해 주세요.' : preview.message); return; }
      const p = preview.data;
      if (!p.valid) { report('vm-redeem', p.state === 'used' ? '이미 사용한 바우처예요.' : p.state === 'void' ? '취소된 바우처예요.' : p.state === 'expired' ? '만료된 바우처예요.' : !p.eventOpen ? '축제가 운영 중이 아니어서 사용할 수 없어요.' : '사용할 수 없는 바우처예요.'); return; }
      showSpot('vm-redeem', '');
      if (!confirm(`${p.title}\n${p.participant}${p.studentNumber ? ` (${p.studentNumber})` : ''}\n상품을 전달하고 사용 완료로 처리할까요?`)) return;
      showSpot('vm-redeem', '처리하는 중...', 'info');
      const r = await ops().write('voucher_code_redeem', { code });
      if (state.user?.id !== actor || !form.isConnected) return;
      if (!r.ok) { report('vm-redeem', r.message); return; }
      form.reset();
      report('vm-redeem', `${r.data.participant || '학생'} 학생의 ${r.data.title}을(를) 사용 완료로 처리했어요.`, 'success');
      festivalVoucherScan.approved(r.data);
    } finally { busy = false; if (button.isConnected) button.disabled = false; }
  }

  // 관리 마법사 → 권한 관리 → 바우처 담당자 (operators).
  async function loadAdmin() {
    if (adminLoading || !ops()?.voucherManagers) return;
    adminLoading = true;
    const response = await ops().voucherManagers('list');
    adminLoading = false;
    if (response.ok) { adminList = response.data.items || []; adminFailure = ''; }
    else adminFailure = response.code === 'OPS_NOT_READY' ? '바우처 담당자는 서버 업데이트 후 지정할 수 있어요.' : response.message;
    render();
  }

  const managerSpot = m => `voucher-manager:${m.kind}:${m.studentNumber}:${m.email || ''}`;
  function adminView() {
    if (owner !== (state.user?.id || null)) reset();
    const list = adminList ? `<section class="ops-section"><h2>지정된 바우처 담당자 <span class="ops-count">${adminList.length}명</span></h2>${adminSlot('vm-list')}${adminList.length ? `<ul class="manager-list">${adminList.map((m, i) => `<li class="${m.active ? '' : 'is-off'}">
        <div><strong>${h(m.name)} (${h(m.studentNumber || '학번 없음')})</strong><small>${h(ROLES[m.kind] || m.kind)}${m.active ? '' : ' · 소속 확인이 취소돼 권한 중지됨'}</small></div>
        <div class="sun-actions"><button type="button" class="ghost-btn danger" data-vm-revoke="${i}">해제</button></div>
        ${adminSlot(managerSpot(m))}</li>`).join('')}</ul>`
        : '<p class="ops-empty">아직 지정한 바우처 담당자가 없어요.</p>'}</section>`
      : adminFailure ? `<p class="ops-alert" role="alert">${h(adminFailure)}</p><button type="button" class="ghost-btn" data-vm-admin-retry>${icon('refresh')} 다시 불러오기</button>` : '<p role="status">불러오는 중...</p>';
    const open = candidate ? Object.keys(ROLES).filter(k => !candidate.kinds.includes(k)) : [];
    const pick = candidate ? (candidate.verified
      ? `<form class="ops-form" data-vm-grant><p class="ops-recipient-chosen">${icon('check')} <strong>${h(candidate.name)} (${h(candidate.studentNumber)})</strong> · ${h(candidate.realName || '')}</p>
          ${candidate.kinds.length ? `<p class="web-muted">이미 맡은 권한: ${candidate.kinds.map(k => h(ROLES[k])).join(', ')}</p>` : ''}
          ${open.length ? `<label>맡길 권한<select class="select" name="kind">${open.map(k => `<option value="${k}">${h(ROLES[k])}</option>`).join('')}</select></label>
          ${adminSlot('vm-grant')}<button class="primary-btn" type="submit">${icon('plus')} 바우처 담당자로 지정</button>` : '<p class="web-muted">두 권한을 모두 맡고 있어요.</p>'}</form>`
      : `<p class="ops-alert" role="alert">${h(candidate.name)} (${h(candidate.studentNumber)}) 학생은 소속 확인이 끝나지 않았어요. 소속 관리에서 먼저 확인해 주세요.</p>`) : '';
    return `<div data-vm-root><section class="ops-section"><h2>바우처 담당자 지정</h2><p>바우처 사용 승인만 맡는 권한이에요. 푸드트럭 바우처 담당자는 푸드트럭 바우처만, 포토부스 바우처 담당자는 포토부스 바우처만 사용 완료로 처리할 수 있어요. 소속 확인이 끝난 학생에게만 맡길 수 있어요.</p>
      <form class="ops-form" data-vm-find><label>학생 학번<input class="input" name="studentNumber" inputmode="numeric" pattern="[1-3][0-9]{4}" maxlength="5" required autocomplete="off" placeholder="학번 5자리" value="${h(adminQuery?.studentNumber)}"></label>
        <label>Google 이메일 (같은 학번 계정이 여러 개일 때만)<input class="input" name="email" type="email" maxlength="320" autocomplete="off" value="${h(adminQuery?.email)}"></label>
        ${adminSlot('vm-find')}<button class="ghost-btn" type="submit">${icon('search')} 학생 확인</button></form>${pick}</section>${list}</div>`;
  }

  // at: where progress and a failure are shown; done returns [spot, message] for the success,
  // shown after the list is read again.
  async function adminAct(action, payload, at, done) {
    showSpot(at, '처리 중...', 'info');
    const response = await ops().voucherManagers(action, payload);
    if (!response.ok) { reportAdmin(at, response.message); return; }
    const message = done?.(response.data);
    if (action !== 'candidates') { const listed = await ops().voucherManagers('list'); if (listed.ok) adminList = listed.data.items || []; }
    if (message) reportAdmin(message[0], message[1], 'success', true);
    else { adminNote = null; render(); }
  }

  let lastRoute = null, adminShown = false;
  function bind() {
    if (!isServerMode() || !state.user) return;
    if (owner !== state.user.id) reset();
    // Grants change on the operator's side: read again whenever 부스 관리 is opened.
    const opened = state.route === 'manage' && lastRoute !== 'manage';
    lastRoute = state.route;
    if (opened) note = null;
    if ((!status && !failure || opened) && !loading) queueMicrotask(load);
    const root = document.querySelector('.manage-screen');
    if (root) {
      root.querySelector('[data-vm-retry]')?.addEventListener('click', () => { failure = ''; render(); load(); });
      root.querySelector('[data-vm-redeem]')?.addEventListener('submit', e => { e.preventDefault(); redeem(e.currentTarget); });
      // A scanned code goes through the same check, confirmation and redemption as a typed one.
      root.querySelector('[data-vm-camera]')?.addEventListener('click', () => festivalVoucherScan.scan(code => {
        const form = document.querySelector('[data-vm-redeem]');
        if (!form) return;
        form.elements.code.value = code;
        redeem(form);
      }));
    }
    const admin = document.querySelector('[data-vm-root]');
    const adminOpened = Boolean(admin) && !adminShown;
    adminShown = Boolean(admin);
    if (admin && isAdminUser()) {
      if (adminOpened) adminNote = null;
      if ((!adminList && !adminFailure || adminOpened) && !adminLoading) queueMicrotask(loadAdmin);
      admin.querySelector('[data-vm-admin-retry]')?.addEventListener('click', () => { adminFailure = ''; render(); loadAdmin(); });
      admin.querySelector('[data-vm-find]')?.addEventListener('submit', e => {
        e.preventDefault();
        const f = e.currentTarget, account = { studentNumber: f.elements.studentNumber.value.trim() };
        if (f.elements.email.value.trim()) account.email = f.elements.email.value.trim();
        adminQuery = { ...account }; adminNote = null; candidate = null;
        adminAct('candidates', { account }, 'vm-find', data => { candidate = { ...data, kinds: data.kinds || [], account }; });
      });
      admin.querySelector('[data-vm-grant]')?.addEventListener('submit', e => {
        e.preventDefault();
        const kind = e.currentTarget.elements.kind?.value, who = candidate.name;
        if (!ROLES[kind] || !confirm(`${who} 학생을 ${ROLES[kind]}로 지정할까요? ${NAMES[kind]} 바우처를 사용 완료로 처리할 수 있어요.`)) return;
        adminAct('grant', { account: candidate.account, kind }, 'vm-grant', () => { candidate = null; adminQuery = null; return ['vm-find', `${who} 학생을 ${ROLES[kind]}로 지정했어요.`]; });
      });
      admin.querySelectorAll('[data-vm-revoke]').forEach(b => b.addEventListener('click', () => {
        const m = adminList[Number(b.dataset.vmRevoke)];
        if (!m || !confirm(`${m.name} 학생의 ${ROLES[m.kind] || m.kind} 지정을 해제할까요?`)) return;
        adminAct('revoke', { account: { studentNumber: m.studentNumber, email: m.email }, kind: m.kind }, managerSpot(m), () => ['vm-list', `${m.name} 학생의 ${ROLES[m.kind] || m.kind} 지정을 해제했어요.`]);
      }));
    }
  }

  return { section, adminView, bind, profileButton, kinds, ready, reset };
})();
