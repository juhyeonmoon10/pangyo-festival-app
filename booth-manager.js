/* 부스 담당자: students an operator put in charge of their own club's booth. They edit the booth's
   introduction, program and status, and approve manual stamps there when the operator allowed it.
   Every action is re-checked by festival_booth_manager; operators grant the role in 관리 마법사. */
const festivalBoothManager = (() => {
  let owner = null, status = null, loading = false, failure = '', selected = '', note = '', tone = '', busy = false;
  let lookup = null, adminList = null, adminLoading = false, adminFailure = '', candidate = null, adminNote = '', adminTone = '';
  const h = value => escapeHtml(String(value ?? ''));
  const ops = () => festivalAccount?.operations;
  const STATUSES = [['open', '운영 중'], ['paused', '일시 중지'], ['closed', '마감']];
  const PROGRAM = [['title', '프로그램 이름', 80], ['description', '활동 소개', 1000], ['hours', '운영 시간', 100], ['duration', '소요 시간', 100], ['participation', '참여 방법', 300], ['materials', '준비물', 200]];
  const items = () => status?.items || [];
  const current = () => items().find(b => b.key === selected) || items()[0] || null;
  const say = (text, kind = 'success') => { note = text; tone = kind; };
  const sayAdmin = (text, kind = 'success') => { adminNote = text; adminTone = kind; };
  const message = (text, kind) => text ? `<p class="ops-form-status" data-tone="${kind === 'error' ? 'error' : 'success'}" role="status">${h(text)}</p>` : '';

  function reset() {
    owner = state.user?.id || null; status = null; failure = ''; selected = ''; note = ''; lookup = null;
    adminList = null; adminFailure = ''; candidate = null; adminNote = '';
  }

  async function load() {
    if (loading || !ops()) return;
    loading = true;
    const actor = state.user?.id;
    const response = await ops().read('booth_manager');
    loading = false;
    if (state.user?.id !== actor) return;
    // An older server without the role answers "not ready": treat it as "no booths".
    if (response.ok) { status = response.data; failure = ''; }
    else if (response.code === 'OPS_NOT_READY') status = { isAdmin: false, items: [] };
    else failure = response.message;
    if (['manage', 'profile'].includes(state.route)) render();
  }

  function profileButton() {
    if (!isServerMode() || !items().length) return '';
    const label = status.isAdmin ? '부스 소개·프로그램 관리' : `부스 관리 · ${items().map(b => b.name).join(', ')}`;
    return `<button type="button" class="ghost-btn full-action" data-route="manage">${icon('admin')} ${h(label)}</button>`;
  }

  function field(name, label, value, limit, area = false) {
    return `<label>${label}${area ? `<textarea class="textarea" name="${name}" maxlength="${limit}" rows="4">${h(value)}</textarea>`
      : `<input class="input" name="${name}" maxlength="${limit}" value="${h(value)}" autocomplete="off">`}</label>`;
  }

  function approvalSection(b) {
    if (!b.canApprove) return `<section class="ops-section"><h2>스탬프 수동 승인</h2><p class="web-muted">운영자가 허용한 부스만 수동 승인을 할 수 있어요.</p></section>`;
    const accounts = lookup?.booth === b.key ? lookup.accounts : null;
    const chosen = accounts?.find(a => a.ref === lookup.ref) || (accounts?.length === 1 ? accounts[0] : null);
    return `<section class="ops-section"><h2>스탬프 수동 승인</h2><p>NFC가 인식되지 않는 학생에게 이 부스 스탬프를 직접 적립해요. 본인 동아리 학생에게는 적립되지 않아요.</p>
      <form class="ops-form" data-manager-lookup><label>학생 학번<input class="input" name="studentNumber" inputmode="numeric" pattern="[1-3][0-9]{4}" maxlength="5" required autocomplete="off" placeholder="학번 5자리" value="${h(lookup?.booth === b.key ? lookup.studentNumber : '')}"></label>
        <button class="ghost-btn" type="submit" ${busy ? 'disabled' : ''}>${icon('search')} 학생 확인</button></form>
      ${accounts ? `<div class="manager-accounts">${accounts.length > 1 ? '<p>같은 학번으로 가입한 계정이 여러 개예요. 학생 본인의 계정을 골라 주세요.</p>' : ''}
        ${accounts.map(a => `<label class="manager-account ${chosen?.ref === a.ref ? 'is-chosen' : ''}">${accounts.length > 1 ? `<input type="radio" name="managerAccount" value="${h(a.ref)}" ${chosen?.ref === a.ref ? 'checked' : ''}>` : icon('user')}
          <span><strong>${h(a.name)} (${h(lookup.studentNumber)})</strong>${a.email ? `<small>${h(a.email)}</small>` : ''}
          ${a.ownClub ? '<small class="is-warning">본인 동아리 학생이라 적립할 수 없어요.</small>' : a.visited ? '<small>이미 이 부스 스탬프가 있어요.</small>' : ''}</span></label>`).join('')}</div>
        ${chosen && !chosen.ownClub ? `<form class="ops-form" data-manager-approve><label>처리 사유<input class="input" name="reason" required minlength="3" maxlength="300" placeholder="예: 부스 체험 완료, NFC 인식 불가" autocomplete="off"></label>
          <button class="primary-btn" type="submit" ${busy ? 'disabled' : ''}>${icon('stamp')} 스탬프 1개 승인</button></form>` : ''}` : ''}</section>`;
  }

  function view() {
    if (owner !== (state.user?.id || null)) reset();
    const head = `<header class="top-bar"><button class="icon-btn" data-history-back="profile" aria-label="뒤로">${icon('back')}</button><h1>부스 관리</h1><span class="icon-btn" aria-hidden="true"></span></header>`;
    let body;
    if (failure) body = `<p class="ops-alert" role="alert">${h(failure)}</p><button type="button" class="ghost-btn" data-manager-retry>${icon('refresh')} 다시 불러오기</button>`;
    else if (!status) body = '<p role="status">불러오는 중...</p>';
    else if (!items().length) body = `<div class="festival-empty"><span>${icon('admin')}</span><strong>관리할 부스가 없어요</strong><p>운영자가 부스 담당자로 지정하면 이곳에서 부스를 관리할 수 있어요.</p></div>`;
    else {
      const b = current(), p = b.program || {};
      body = `${items().length > 1 ? `<label class="manager-pick">관리할 부스<select class="select" data-manager-booth>${items().map(x => `<option value="${h(x.key)}" ${x.key === b.key ? 'selected' : ''}>${h(x.name)}</option>`).join('')}</select></label>` : ''}
        <section class="ops-section manager-booth"><h2>${h(b.name)}</h2><p class="web-muted">${h(b.location || '위치 미등록')} · ${Number(b.floor) || 1}층${status.isAdmin ? ' · 운영자' : ' · 부스 담당자'}</p>
          <form class="ops-form" data-manager-save>
            <label>운영 상태<select class="select" name="status">${STATUSES.map(([v, t]) => `<option value="${v}" ${b.status === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
            ${field('description', '부스 소개', b.description, 2000, true)}
            <fieldset class="manager-program"><legend>프로그램 안내</legend>${PROGRAM.map(([k, label, limit]) => field(`program.${k}`, label, p[k], limit, k === 'description')).join('')}</fieldset>
            <p class="ops-form-status" role="status"></p>
            <button class="primary-btn" type="submit" ${busy ? 'disabled' : ''}>${icon('save')} 부스 정보 저장</button>
          </form></section>
        ${approvalSection(b)}`;
    }
    return `<main class="screen manage-screen">${head}<div class="ops-body">${message(note, tone)}${body}</div>${bottomNav('profile')}</main>`;
  }

  async function save(form) {
    const b = current();
    if (!b || busy) return;
    const values = Object.fromEntries(new FormData(form));
    const program = Object.fromEntries(PROGRAM.map(([k]) => [k, String(values[`program.${k}`] || '').trim()]).filter(([, v]) => v));
    const payload = { booth: b.key, version: b.version, status: values.status, description: String(values.description || '').trim(), program };
    if (b.status === 'open' && payload.status !== 'open' && !confirm(`'${b.name}'을(를) ${payload.status === 'paused' ? '일시 중지' : '마감'}할까요? 이 부스는 방문 인증이 중지돼요.`)) return;
    busy = true; note = ''; render();
    const actor = state.user?.id;
    const response = await ops().write('booth_manager_save', payload);
    busy = false;
    if (state.user?.id !== actor) return;
    if (!response.ok) say(response.message, 'error');
    else {
      status.items = items().map(x => x.key === b.key ? response.data : x);
      say('부스 정보를 저장했어요. 학생 화면에 바로 보여요.');
      festivalOpsUI.refresh(false);
    }
    render();
  }

  async function find(form) {
    const b = current(), sid = form.elements.studentNumber.value.trim();
    if (!b || busy || !/^[1-3][0-9]{4}$/.test(sid)) { say('학번 5자리를 입력해 주세요.', 'error'); render(); return; }
    busy = true; note = ''; render();
    const actor = state.user?.id;
    const response = await ops().read('booth_manager_lookup', { booth: b.key, studentNumber: sid });
    busy = false;
    if (state.user?.id !== actor) return;
    if (!response.ok) { lookup = null; say(response.message, 'error'); }
    else lookup = { booth: b.key, studentNumber: sid, accounts: response.data.accounts || [], ref: (response.data.accounts || []).find(a => a.selected)?.ref || '' };
    render();
  }

  async function approve(form) {
    const b = current(), accounts = lookup?.accounts || [];
    const chosen = accounts.find(a => a.ref === lookup.ref) || (accounts.length === 1 ? accounts[0] : null);
    if (!b || !chosen || busy) return;
    if (!confirm(`${chosen.name} (${lookup.studentNumber}) 학생에게 '${b.name}' 스탬프 1개를 적립할까요?`)) return;
    busy = true; note = ''; render();
    const actor = state.user?.id;
    const response = await ops().write('booth_manager_visit', { booth: b.key, studentNumber: lookup.studentNumber, ref: chosen.ref, reason: form.elements.reason.value.trim() });
    busy = false;
    if (state.user?.id !== actor) return;
    if (!response.ok) say(response.message, 'error');
    else { say(response.data.result === 'ALREADY_EARNED' ? `${chosen.name} 학생은 이미 이 부스 스탬프가 있어요.` : `${chosen.name} 학생에게 스탬프 1개를 적립했어요.`); lookup = null; }
    render();
  }

  // 관리 마법사 → 부스 담당자 (operators).
  async function loadAdmin() {
    if (adminLoading || !ops()?.boothManagers) return;
    adminLoading = true;
    const response = await ops().boothManagers('list');
    adminLoading = false;
    if (response.ok) { adminList = response.data.items || []; adminFailure = ''; } else adminFailure = response.message;
    render();
  }

  function adminView() {
    if (owner !== (state.user?.id || null)) reset();
    const list = adminList ? `<section class="ops-section"><h2>지정된 담당자 <span class="ops-count">${adminList.length}명</span></h2>${adminList.length ? `<ul class="manager-list">${adminList.map((m, i) => `<li class="${m.active ? '' : 'is-off'}">
        <div><strong>${h(m.name)} (${h(m.studentNumber || '학번 없음')})</strong><small>${h(m.boothName)} · ${m.canApprove ? '스탬프 수동 승인 허용' : '수동 승인 불가'}${m.active ? '' : ' · 소속 확인이 취소돼 권한 중지됨'}</small></div>
        <div class="sun-actions"><button type="button" class="ghost-btn" data-bm-toggle="${i}">${m.canApprove ? '승인 허용 끄기' : '승인 허용 켜기'}</button><button type="button" class="ghost-btn danger" data-bm-revoke="${i}">해제</button></div></li>`).join('')}</ul>`
        : '<p class="ops-empty">아직 지정한 부스 담당자가 없어요.</p>'}</section>`
      : adminFailure ? `<p class="ops-alert" role="alert">${h(adminFailure)}</p><button type="button" class="ghost-btn" data-bm-retry>${icon('refresh')} 다시 불러오기</button>` : '<p role="status">불러오는 중...</p>';
    const pick = candidate ? (candidate.verified
      ? `<form class="ops-form" data-bm-grant><p class="ops-recipient-chosen">${icon('check')} <strong>${h(candidate.name)} (${h(candidate.studentNumber)})</strong> · ${h(candidate.realName || '')}</p>
          <label>맡길 부스 (본인 동아리)<select class="select" name="booth">${candidate.booths.map(b => `<option value="${h(b.key)}">${h(b.name)}${b.managed ? ' · 지정됨' : ''}</option>`).join('')}</select></label>
          <label class="ops-checkbox"><input type="checkbox" name="canApprove">이 부스에서 스탬프 수동 승인 허용</label>
          <button class="primary-btn" type="submit">${icon('plus')} 부스 담당자로 지정</button></form>`
      : `<p class="ops-alert" role="alert">${h(candidate.name)} (${h(candidate.studentNumber)}) 학생은 소속 확인이 끝나지 않았어요. 소속 관리에서 먼저 확인해 주세요.</p>`) : '';
    return `<div data-bm-root><section class="ops-section"><h2>부스 담당자 지정</h2><p>소속 확인이 끝난 학생에게만, 그 학생의 동아리 부스를 맡길 수 있어요. 담당자는 부스 소개·프로그램·운영 상태를 바꿀 수 있어요.</p>
      ${message(adminNote, adminTone)}
      <form class="ops-form" data-bm-find><label>학생 학번<input class="input" name="studentNumber" inputmode="numeric" pattern="[1-3][0-9]{4}" maxlength="5" required autocomplete="off" placeholder="학번 5자리"></label>
        <label>Google 이메일 (같은 학번 계정이 여러 개일 때만)<input class="input" name="email" type="email" maxlength="320" autocomplete="off"></label>
        <button class="ghost-btn" type="submit">${icon('search')} 학생 확인</button></form>${pick}</section>${list}</div>`;
  }

  async function adminAct(action, payload, done) {
    const response = await ops().boothManagers(action, payload);
    if (!response.ok) { sayAdmin(response.message, 'error'); render(); return null; }
    done?.(response.data);
    if (action !== 'candidates') { const listed = await ops().boothManagers('list'); if (listed.ok) adminList = listed.data.items || []; }
    render();
    return response.data;
  }

  let lastRoute = null, adminShown = false;
  function bind() {
    if (!isServerMode() || !state.user) return;
    if (owner !== state.user.id) reset();
    // Grants change on the operator's side: read again whenever 부스 관리 is opened.
    const opened = state.route === 'manage' && lastRoute !== 'manage';
    lastRoute = state.route;
    if ((!status && !failure || opened) && !loading) queueMicrotask(load);
    const root = document.querySelector('.manage-screen');
    if (root) {
      root.querySelector('[data-manager-retry]')?.addEventListener('click', () => { failure = ''; render(); load(); });
      root.querySelector('[data-manager-booth]')?.addEventListener('change', e => { selected = e.target.value; lookup = null; note = ''; render(); });
      root.querySelector('[data-manager-save]')?.addEventListener('submit', e => { e.preventDefault(); save(e.currentTarget); });
      root.querySelector('[data-manager-lookup]')?.addEventListener('submit', e => { e.preventDefault(); find(e.currentTarget); });
      root.querySelectorAll('[name=managerAccount]').forEach(r => r.addEventListener('change', () => { lookup.ref = r.value; render(); }));
      root.querySelector('[data-manager-approve]')?.addEventListener('submit', e => { e.preventDefault(); approve(e.currentTarget); });
    }
    const admin = document.querySelector('[data-bm-root]');
    const adminOpened = Boolean(admin) && !adminShown;
    adminShown = Boolean(admin);
    if (admin && isAdminUser()) {
      if ((!adminList && !adminFailure || adminOpened) && !adminLoading) queueMicrotask(loadAdmin);
      admin.querySelector('[data-bm-retry]')?.addEventListener('click', () => { adminFailure = ''; render(); loadAdmin(); });
      admin.querySelector('[data-bm-find]')?.addEventListener('submit', e => {
        e.preventDefault();
        const f = e.currentTarget, account = { studentNumber: f.elements.studentNumber.value.trim() };
        if (f.elements.email.value.trim()) account.email = f.elements.email.value.trim();
        adminNote = ''; candidate = null;
        adminAct('candidates', { account }, data => { candidate = { ...data, account }; });
      });
      admin.querySelector('[data-bm-grant]')?.addEventListener('submit', e => {
        e.preventDefault();
        const f = e.currentTarget, booth = f.elements.booth.value, canApprove = f.elements.canApprove.checked;
        const name = candidate.booths.find(b => b.key === booth)?.name || booth;
        if (!confirm(`${candidate.name} 학생을 '${name}' 부스 담당자로 지정할까요?${canApprove ? ' 이 부스의 스탬프 수동 승인도 할 수 있어요.' : ''}`)) return;
        adminAct('grant', { account: candidate.account, booth, canApprove }, () => { sayAdmin(`${candidate.name} 학생을 '${name}' 부스 담당자로 지정했어요.`); candidate = null; });
      });
      admin.querySelectorAll('[data-bm-toggle]').forEach(b => b.addEventListener('click', () => {
        const m = adminList[Number(b.dataset.bmToggle)];
        if (!m) return;
        adminAct('grant', { account: { studentNumber: m.studentNumber, email: m.email }, booth: m.booth, canApprove: !m.canApprove },
          () => sayAdmin(`${m.name} 학생의 수동 승인 허용을 ${m.canApprove ? '껐어요' : '켰어요'}.`));
      }));
      admin.querySelectorAll('[data-bm-revoke]').forEach(b => b.addEventListener('click', () => {
        const m = adminList[Number(b.dataset.bmRevoke)];
        if (!m || !confirm(`${m.name} 학생의 '${m.boothName}' 부스 담당자 지정을 해제할까요?`)) return;
        adminAct('revoke', { account: { studentNumber: m.studentNumber, email: m.email }, booth: m.booth }, () => sayAdmin('부스 담당자 지정을 해제했어요.'));
      }));
    }
  }

  return { view, adminView, bind, profileButton, reset };
})();
