/* 웨이팅 관리 (1.59): the booth manager's own screen, opened from 부스 관리 (/manage/waiting/<booth>).
   Operators can open it for any booth. Tabs: 대기 (call, enter, no-show, cancel with a reason, walk-ins),
   완료 (today's finished teams), QR (fixed QR to print, or a QR that changes every few seconds on this
   screen) and 설정 (on/off, online and QR registration, party size, minutes per team, automatic no-show,
   postponing). Every action is checked again by festival_waiting_manage. The list is read again every
   5 seconds while the screen is open. */
const festivalWaitingManager = (() => {
  const h = value => escapeHtml(String(value ?? ''));
  const ops = () => festivalAccount?.operations;
  const POLL_MS = 5000;
  let owner = null, booth = '', board = null, loading = false, failure = '', tab = 'queue', note = null, busy = false;
  let walkin = null, qr = null, qrTimer = null, offset = 0;
  const api = (action, payload) => ops()?.waitingManage ? ops().waitingManage(action, payload) : Promise.resolve({ ok: false, message: '웨이팅을 불러올 수 없어요.' });
  const slot = at => spotMarkup(note, at);
  const now = () => Date.now() + offset;
  const minutesSince = value => Math.max(0, Math.floor((now() - new Date(value).getTime()) / 60000));
  const time = value => value ? new Date(value).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '';
  const SOURCES = { online: '온라인', qr: '현장 QR', walkin: '현장 등록' };
  const ENDED = { entered: '입장', noshow: '노쇼', cancelled: '취소' };

  function reset() {
    owner = state.user?.id || null; booth = ''; board = null; failure = ''; tab = 'queue'; note = null; busy = false; walkin = null; stopQr(); qr = null;
  }
  function report(at, text, tone = 'error') { note = text ? { at, text, tone } : null; if (!showSpot(at, text, tone)) render(); }

  async function load() {
    if (loading || !booth) return;
    loading = true;
    const actor = state.user?.id, key = booth;
    const response = await api('board', { booth: key });
    loading = false;
    if (state.user?.id !== actor || booth !== key) return;
    if (response.ok) { board = response.data; failure = ''; offset = new Date(board.serverTime).getTime() - Date.now(); }
    else failure = response.message;
  }

  // Header, counts and tabs ---------------------------------------------------------------------------------
  function view() {
    if (owner !== (state.user?.id || null)) reset();
    if (booth !== (state.waitingBooth || '')) { reset(); booth = state.waitingBooth || ''; }
    const head = `<header class="top-bar"><button class="icon-btn" data-history-back="manage" aria-label="뒤로">${icon('back')}</button><h1>웨이팅 관리</h1><button type="button" class="icon-btn" data-wm-refresh aria-label="새로고침" title="새로고침">${icon('refresh')}</button></header>`;
    let body;
    if (failure) body = `<p class="ops-alert" role="alert">${h(failure)}</p><button type="button" class="ghost-btn" data-wm-retry>${icon('refresh')} 다시 불러오기</button>`;
    else if (!board) { if (!loading) queueMicrotask(() => load().then(() => state.route === 'manageWaiting' && render())); body = '<p role="status">불러오는 중...</p>'; }
    else body = summary() + tabs() + (tab === 'queue' ? queue() : tab === 'done' ? done() : tab === 'qr' ? qrView() : settingsForm());
    return `<main class="screen manage-screen waiting-admin-screen">${head}<div class="ops-body">${body}</div>${bottomNav('profile')}</main>`;
  }
  function summary() {
    const s = board.settings, c = board.counts;
    const state_ = !s.enabled ? ['is-off', '웨이팅 사용 안 함'] : s.paused ? ['is-paused', '접수 일시 중단'] : ['is-on', '접수 중'];
    const ways = [s.online && '온라인', s.qr && '현장 QR'].filter(Boolean).join(' · ') || '등록 방법 없음';
    return `<section class="waiting-admin-head"><div><h2>${h(board.booth.name)}</h2>
        <p><span class="waiting-state ${state_[0]}">${state_[1]}</span> ${h(ways)} · 한 팀 최대 ${s.maxParty}명 · 팀당 ${board.booth.durationMinutes ? `${board.booth.durationMinutes}분` : '소요시간 미입력'}</p></div>
        ${s.enabled ? `<button type="button" class="${s.paused ? 'primary-btn' : 'ghost-btn'}" data-wm-pause="${s.paused ? 0 : 1}">${icon(s.paused ? 'play' : 'pause')} ${s.paused ? '접수 다시 시작' : '접수 일시 중단'}</button>` : ''}
        ${slot('head')}</section>
      <dl class="waiting-admin-counts"><div><dt>대기</dt><dd>${c.waiting}<small>팀</small></dd></div><div><dt>호출</dt><dd>${c.called}<small>팀</small></dd></div>
        <div><dt>대기 인원</dt><dd>${c.people}<small>명</small></dd></div><div><dt>오늘 입장</dt><dd>${c.entered}<small>팀</small></dd></div>
        <div><dt>노쇼</dt><dd>${c.noshow}</dd></div><div><dt>취소</dt><dd>${c.cancelled}</dd></div></dl>`;
  }
  function tabs() {
    const items = [['queue', `대기 ${board.active.length}`], ['done', `완료 ${board.done.length}`], ['qr', 'QR'], ['settings', '설정']];
    return `<nav class="festival-view-tabs waiting-admin-tabs" aria-label="웨이팅 관리 화면">${items.map(([id, label]) => `<button type="button" data-wm-tab="${id}" aria-pressed="${tab === id}">${h(label)}</button>`).join('')}</nav>`;
  }

  // 대기 ------------------------------------------------------------------------------------------------------
  function queue() {
    const s = board.settings;
    const add = walkin ? `<form class="ops-form waiting-walkin" data-wm-walkin><h3>현장 등록</h3><p class="web-muted">휴대폰이 없는 방문자를 대기열에 넣어요. 이 팀은 알림을 받지 못해요.</p>
        <label>이름 또는 메모<input class="input" name="name" maxlength="30" required autocomplete="off" value="${h(walkin.name)}" placeholder="예: 김판교, 파란 모자"></label>
        <label>인원수<input class="input" name="party" type="number" inputmode="numeric" min="1" max="${s.maxParty}" required value="${h(walkin.party)}"></label>
        ${slot('walkin')}<div class="sun-actions"><button type="submit" class="primary-btn" ${busy ? 'disabled' : ''}>${icon('plus')} 대기열에 추가</button><button type="button" class="ghost-btn" data-wm-walkin-close>닫기</button></div></form>`
      : `<button type="button" class="ghost-btn full-action" data-wm-walkin-open>${icon('plus')} 현장 등록</button>`;
    const rows = board.active.map((e, i) => {
      const called = e.status === 'called';
      const left = called && e.noshowAt ? Math.max(0, Math.ceil((new Date(e.noshowAt).getTime() - now()) / 1000)) : null;
      return `<article class="waiting-row${called ? ' is-called' : ''}">
        <div class="waiting-row-number"><small>${i + 1}번째</small><strong>${e.number}</strong></div>
        <div class="waiting-row-main"><strong>${h(e.name)}${e.studentNumber ? ` <small>${h(e.studentNumber)}</small>` : ''}</strong>
          <span>${e.party}명 · ${h(SOURCES[e.source])} · ${minutesSince(e.createdAt)}분 대기${e.postponed ? ` · 미룸 ${e.postponed}회` : ''}</span>
          ${called ? `<span class="waiting-row-called">${icon('bellRing')} ${minutesSince(e.calledAt)}분 전 호출${left !== null ? ` · 자동 노쇼까지 <b data-wm-deadline="${h(e.noshowAt)}">${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}</b>` : ''}</span>` : ''}
          ${slot(`row:${e.id}`)}</div>
        <div class="waiting-row-actions">
          ${called ? '' : `<button type="button" class="primary-btn" data-wm-act="call" data-id="${h(e.id)}">${icon('bell')} 호출</button>`}
          <button type="button" class="${called ? 'primary-btn' : 'ghost-btn'}" data-wm-act="enter" data-id="${h(e.id)}">${icon('check')} 입장</button>
          <button type="button" class="ghost-btn" data-wm-act="noshow" data-id="${h(e.id)}">노쇼</button>
          <button type="button" class="ghost-btn danger" data-wm-act="cancel" data-id="${h(e.id)}">취소</button>
        </div></article>`;
    }).join('');
    return `<section class="ops-section waiting-queue">${!s.enabled ? '<p class="ops-alert">웨이팅을 사용하지 않는 중이에요. 새 등록은 받지 않고, 남은 팀만 처리할 수 있어요. 설정 탭에서 켤 수 있어요.</p>' : ''}
      ${add}${slot('queue')}${rows || '<p class="ops-empty">기다리는 팀이 없어요.</p>'}</section>`;
  }
  function done() {
    if (!board.done.length) return '<section class="ops-section"><p class="ops-empty">오늘 끝난 웨이팅이 없어요.</p></section>';
    return `<section class="ops-section waiting-done">${board.done.map(e => `<article class="waiting-row is-${h(e.status)}">
      <div class="waiting-row-number"><strong>${e.number}</strong></div>
      <div class="waiting-row-main"><strong>${h(e.name)}${e.studentNumber ? ` <small>${h(e.studentNumber)}</small>` : ''}</strong>
        <span>${e.party}명 · ${h(SOURCES[e.source])} · ${h(time(e.createdAt))} 등록 · ${h(time(e.finishedAt))} ${h(ENDED[e.status])}${e.status === 'noshow' && e.endedBy === 'auto' ? ' (자동)' : ''}${e.status === 'cancelled' && e.endedBy === 'user' ? ' (본인)' : ''}</span>
        ${e.cancelReason ? `<span class="waiting-row-reason">사유: ${h(e.cancelReason)}</span>` : ''}</div>
      <span class="waiting-state is-${h(e.status)}">${h(ENDED[e.status])}</span></article>`).join('')}</section>`;
  }

  // QR --------------------------------------------------------------------------------------------------------
  const joinUrl = token => `${location.origin}/waiting/join/${encodeURIComponent(booth)}#q=${encodeURIComponent(token)}`;
  function qrSvg(token) {
    const code = qrcode(0, 'M');
    code.addData(joinUrl(token)); code.make();
    return code;
  }
  function qrView() {
    const s = board.settings;
    if (!qr) { queueMicrotask(loadQr); return '<section class="ops-section"><p role="status">QR을 만드는 중...</p></section>'; }
    const warn = !s.enabled ? '웨이팅을 사용하지 않는 중이라 QR로 등록할 수 없어요.' : !s.qr ? '현장 QR 등록이 꺼져 있어 QR로 등록할 수 없어요. 설정 탭에서 켜 주세요.' : s.paused ? '접수 일시 중단 중이라 지금은 QR로 등록할 수 없어요.' : '';
    const code = qrSvg(qr.token);
    const rotating = qr.mode === 'rotating';
    return `<section class="ops-section waiting-qr">${warn ? `<p class="ops-alert">${h(warn)}</p>` : ''}
      <div class="waiting-qr-card" data-wm-qr-card><p class="waiting-qr-booth">${h(board.booth.name)}</p><p class="waiting-qr-title">QR을 찍어 웨이팅을 등록하세요</p>
        <div class="waiting-qr-code">${code.createSvgTag({ cellSize: 6, margin: 4, scalable: true })}</div>
        ${rotating ? `<p class="waiting-qr-timer" data-wm-qr-timer>${qrLeft()}초 뒤 바뀌어요</p>` : `<p class="waiting-qr-timer">QR ${qr.version}번째 · 재발급하기 전까지 계속 쓸 수 있어요</p>`}</div>
      <p class="web-muted">${rotating ? `${qr.period}초마다 새 QR로 바뀌어요. 이 화면을 켠 채로 방문자에게 보여 주세요. 사진으로 찍어 간 QR은 잠시 뒤 쓸 수 없어요.` : '인쇄해서 부스에 붙여 둘 수 있어요. QR이 밖으로 퍼졌다면 재발급하면 이전 QR은 바로 쓸 수 없게 돼요.'}</p>
      ${slot('qr')}
      <div class="sun-actions">${rotating ? `<button type="button" class="primary-btn" data-wm-qr-full>${icon('qr')} 전체 화면으로 보기</button>`
        : `<button type="button" class="primary-btn" data-wm-qr-save>${icon('download')} QR 이미지 저장</button><button type="button" class="ghost-btn" data-wm-qr-print>${icon('printer')} 인쇄</button>`}
        <button type="button" class="ghost-btn danger" data-wm-qr-reissue>${icon('refresh')} QR 재발급</button></div>
      <p class="web-muted">QR 방식(고정 / 자주 바뀌는 QR)과 바뀌는 주기는 설정 탭에서 바꿔요.</p></section>`;
  }
  const qrLeft = () => qr?.expiresAt ? Math.max(0, Math.ceil((new Date(qr.expiresAt).getTime() - now()) / 1000)) : 0;
  function stopQr() { clearInterval(qrTimer); qrTimer = null; }
  async function loadQr(reissue = false) {
    const key = booth;
    const response = await api(reissue ? 'qr_reissue' : 'qr', { booth: key });
    if (booth !== key || state.route !== 'manageWaiting') return;
    if (!response.ok) { report('qr', response.message); return; }
    qr = response.data;
    offset = new Date(qr.serverTime).getTime() - Date.now();
    if (tab === 'qr') drawQr();
    stopQr();
    if (qr.mode === 'rotating') {
      qrTimer = setInterval(() => {
        const timer = document.querySelector('[data-wm-qr-timer]');
        if (timer) timer.textContent = `${qrLeft()}초 뒤 바뀌어요`;
        if (qrLeft() <= 0) { stopQr(); loadQr(); }
      }, 1000);
    }
  }
  // Only the QR card changes, so the full-screen view stays open while the code rotates.
  function drawQr() {
    const card = document.querySelector('[data-wm-qr-card] .waiting-qr-code');
    if (card && qr) card.innerHTML = qrSvg(qr.token).createSvgTag({ cellSize: 6, margin: 4, scalable: true });
    else render();
  }

  // 설정 ------------------------------------------------------------------------------------------------------
  function toggle(name, label, on, hint = '') {
    return `<label class="waiting-switch"><input type="checkbox" name="${name}" ${on ? 'checked' : ''}><span><strong>${label}</strong>${hint ? `<small>${hint}</small>` : ''}</span></label>`;
  }
  function settingsForm() {
    const s = board.settings;
    return `<section class="ops-section"><form class="ops-form waiting-settings" data-wm-settings novalidate>
      <fieldset class="manager-program"><legend>웨이팅 사용</legend>
        ${toggle('enabled', '이 부스에서 웨이팅 사용', s.enabled, '끄면 새 등록만 막혀요. 이미 기다리는 팀은 계속 처리할 수 있어요.')}
        ${toggle('online', '온라인 등록 허용', s.online, '부스 정보의 \'웨이팅 등록\' 버튼으로 어디서나 등록해요.')}
        ${toggle('qr', '현장 QR 등록 허용', s.qr, '부스에 있는 QR을 찍어 등록해요. 온라인을 끄고 QR만 켜면 현장에서만 등록할 수 있어요.')}</fieldset>
      <fieldset class="manager-program"><legend>인원과 시간</legend>
        <label>한 팀 최대 인원<input class="input" type="number" inputmode="numeric" name="maxParty" min="1" max="50" required value="${s.maxParty}"></label>
        <label>팀당 예상 소요시간 (분)<input class="input" type="number" inputmode="numeric" name="durationMinutes" min="1" max="240" value="${h(board.booth.durationMinutes ?? '')}" placeholder="예: 5">
          <small class="web-muted">예상 대기시간 = 앞 팀 수 × 이 시간. 부스 정보의 '예상 소요시간'과 같은 값이에요.</small></label></fieldset>
      <fieldset class="manager-program"><legend>호출과 노쇼</legend>
        ${toggle('autoNoshow', '호출 후 오지 않으면 자동으로 노쇼 처리', s.autoNoshow)}
        <label>자동 노쇼까지 (분)<input class="input" type="number" inputmode="numeric" name="noshowMinutes" min="1" max="60" required value="${s.noshowMinutes}"></label></fieldset>
      <fieldset class="manager-program"><legend>입장 순서 미루기</legend><p class="web-muted">앞에 3팀 이내로 남은 방문자가 스스로 순서를 미룰 수 있어요.</p>
        <label class="ops-checkbox"><input type="radio" name="postponeMode" value="count" ${s.postponeMode === 'count' ? 'checked' : ''}>미룰 팀 수를 고르게 하기</label>
        <label class="ops-checkbox"><input type="radio" name="postponeMode" value="last" ${s.postponeMode === 'last' ? 'checked' : ''}>맨 뒤로만 미루게 하기</label>
        <label>한 번에 미룰 수 있는 최대 팀 수<input class="input" type="number" inputmode="numeric" name="postponeMaxTeams" min="1" max="50" required value="${s.postponeMaxTeams}"></label>
        <label class="ops-checkbox"><input type="radio" name="postponeLimited" value="0" ${s.postponeLimit == null ? 'checked' : ''}>미루기 횟수 제한 없음</label>
        <label class="ops-checkbox"><input type="radio" name="postponeLimited" value="1" ${s.postponeLimit != null ? 'checked' : ''}>한 웨이팅에 최대 횟수 정하기</label>
        <label>최대 미루기 횟수<input class="input" type="number" inputmode="numeric" name="postponeLimit" min="1" max="20" value="${s.postponeLimit ?? 1}"></label></fieldset>
      <fieldset class="manager-program"><legend>현장 QR</legend>
        <label class="ops-checkbox"><input type="radio" name="qrMode" value="fixed" ${s.qrMode === 'fixed' ? 'checked' : ''}>고정 QR (인쇄해서 붙여 두기, 재발급 전까지 유지)</label>
        <label class="ops-checkbox"><input type="radio" name="qrMode" value="rotating" ${s.qrMode === 'rotating' ? 'checked' : ''}>자주 바뀌는 QR (관리 화면에 띄워 두기)</label>
        <label>QR이 바뀌는 주기 (초)<input class="input" type="number" inputmode="numeric" name="qrPeriod" min="15" max="300" required value="${s.qrPeriod}"></label></fieldset>
      ${slot('settings')}
      <button type="submit" class="primary-btn full-action" ${busy ? 'disabled' : ''}>${icon('save')} 설정 저장</button></form></section>`;
  }
  function readSettings(form) {
    const f = form.elements, num = name => Number(f[name].value);
    const whole = (name, min, max, label) => {
      const v = num(name);
      if (!Number.isInteger(v) || v < min || v > max) throw { field: name, message: `${label}은(는) ${min}~${max} 사이 숫자로 입력해 주세요.` };
      return v;
    };
    const duration = String(f.durationMinutes.value).trim();
    const limited = form.querySelector('[name=postponeLimited]:checked')?.value === '1';
    return { booth, version: board.settings.version, enabled: f.enabled.checked, online: f.online.checked, qr: f.qr.checked,
      maxParty: whole('maxParty', 1, 50, '한 팀 최대 인원'),
      durationMinutes: duration ? whole('durationMinutes', 1, 240, '팀당 예상 소요시간') : null,
      autoNoshow: f.autoNoshow.checked, noshowMinutes: whole('noshowMinutes', 1, 60, '자동 노쇼까지 시간'),
      postponeMode: form.querySelector('[name=postponeMode]:checked')?.value || 'count',
      postponeMaxTeams: whole('postponeMaxTeams', 1, 50, '최대 미룰 팀 수'),
      postponeLimit: limited ? whole('postponeLimit', 1, 20, '최대 미루기 횟수') : null,
      qrMode: form.querySelector('[name=qrMode]:checked')?.value || 'fixed', qrPeriod: whole('qrPeriod', 15, 300, 'QR이 바뀌는 주기') };
  }

  // Actions ---------------------------------------------------------------------------------------------------
  async function act(action, id) {
    const e = board?.active.find(x => x.id === id);
    if (!e || busy) return;
    let payload = { id };
    if (action === 'cancel') {
      const reason = prompt(`대기번호 ${e.number}번 (${e.name}) 웨이팅을 취소할까요?\n취소 사유를 입력해 주세요. 방문자에게 알림으로 전해져요.`);
      if (reason === null) return;
      if (!reason.trim()) { report(`row:${id}`, '취소 사유를 입력해 주세요.'); return; }
      payload.reason = reason.trim().slice(0, 200);
    }
    if (action === 'noshow' && !confirm(`대기번호 ${e.number}번 (${e.name})을(를) 노쇼로 처리할까요?`)) return;
    busy = true;
    showSpot(`row:${id}`, '처리 중...', 'info');
    const response = await api(action, payload);
    busy = false;
    if (!response.ok) { await load(); report(`row:${id}`, response.message); render(); return; }
    await load();
    note = { at: 'queue', text: `대기번호 ${e.number}번 ${({ call: '호출했어요', enter: '입장 처리했어요', noshow: '노쇼로 처리했어요', cancel: '취소했어요' })[action]}.`, tone: 'success' };
    render();
  }

  let pollTimer = null, lastRoute = null;
  function bind() {
    if (!isServerMode() || !state.user) return;
    if (owner !== state.user.id) reset();
    const opened = state.route === 'manageWaiting' && lastRoute !== 'manageWaiting';
    lastRoute = state.route;
    if (state.route !== 'manageWaiting') { stopQr(); clearInterval(pollTimer); pollTimer = null; return; }
    if (opened) { note = null; board = null; qr = null; }
    if (!pollTimer) pollTimer = setInterval(async () => {
      if (state.route !== 'manageWaiting' || document.hidden || busy || !['queue', 'done'].includes(tab)) return;
      // Typing in the walk-in form or an open prompt is never interrupted.
      if (document.activeElement?.closest?.('.waiting-admin-screen form')) return;
      await load();
      if (state.route === 'manageWaiting' && ['queue', 'done'].includes(tab)) render();
    }, POLL_MS);
    const root = document.querySelector('.waiting-admin-screen');
    if (!root) return;
    root.querySelector('[data-wm-refresh]')?.addEventListener('click', async () => { await load(); qr = null; render(); });
    root.querySelector('[data-wm-retry]')?.addEventListener('click', () => { failure = ''; render(); });
    root.querySelectorAll('[data-wm-tab]').forEach(b => b.addEventListener('click', () => { tab = b.dataset.wmTab; note = null; if (tab !== 'qr') stopQr(); else qr = null; render(); }));
    root.querySelectorAll('[data-wm-act]').forEach(b => b.addEventListener('click', () => act(b.dataset.wmAct, b.dataset.id)));
    root.querySelector('[data-wm-pause]')?.addEventListener('click', async e => {
      const paused = e.currentTarget.dataset.wmPause === '1';
      if (paused && !confirm('새 웨이팅 접수를 잠시 멈출까요? 이미 기다리는 팀은 그대로예요.')) return;
      const response = await api('pause', { booth, paused });
      if (!response.ok) { report('head', response.message); return; }
      await load(); render();
    });
    root.querySelector('[data-wm-walkin-open]')?.addEventListener('click', () => { walkin = { name: '', party: 1 }; note = null; render(); root.isConnected && document.querySelector('[data-wm-walkin] [name=name]')?.focus(); });
    root.querySelector('[data-wm-walkin-close]')?.addEventListener('click', () => { walkin = null; render(); });
    const walk = root.querySelector('[data-wm-walkin]');
    walk?.addEventListener('input', () => { walkin = { name: walk.elements.name.value, party: walk.elements.party.value }; });
    walk?.addEventListener('submit', async e => {
      e.preventDefault();
      const name = walk.elements.name.value.trim(), party = Number(walk.elements.party.value);
      if (!name) { report('walkin', '이름이나 메모를 입력해 주세요.'); return; }
      if (!Number.isInteger(party) || party < 1 || party > board.settings.maxParty) { report('walkin', `인원수는 1~${board.settings.maxParty}명으로 입력해 주세요.`); return; }
      busy = true; showSpot('walkin', '추가하는 중...', 'info');
      const response = await api('walkin', { booth, name, party });
      busy = false;
      if (!response.ok) { report('walkin', response.message); return; }
      walkin = null; await load();
      note = { at: 'queue', text: `대기번호 ${response.data.number}번으로 추가했어요.`, tone: 'success' };
      render();
    });
    const form = root.querySelector('[data-wm-settings]');
    form?.addEventListener('submit', async e => {
      e.preventDefault();
      let payload;
      try { payload = readSettings(form); } catch (problem) { report('settings', problem.message); form.elements[problem.field]?.focus(); return; }
      if (!payload.online && !payload.qr && payload.enabled) { report('settings', '온라인 등록과 현장 QR 등록 중 하나는 켜 주세요.'); return; }
      busy = true; showSpot('settings', '저장하는 중...', 'info');
      const response = await api('settings', payload);
      busy = false;
      if (!response.ok) { if (response.code === 'VERSION_CONFLICT') await load(); report('settings', response.message); return; }
      await load(); qr = null;
      note = { at: 'settings', text: '설정을 저장했어요. 학생 화면에 바로 반영돼요.', tone: 'success' };
      render();
      festivalOpsUI?.refresh?.(false);
    });
    root.querySelector('[data-wm-qr-reissue]')?.addEventListener('click', () => {
      if (!confirm('QR을 재발급할까요? 지금 붙어 있거나 공유된 QR은 바로 쓸 수 없게 돼요.')) return;
      loadQr(true).then(() => { note = { at: 'qr', text: '새 QR을 만들었어요. 인쇄한 QR이 있다면 새로 붙여 주세요.', tone: 'success' }; render(); });
    });
    root.querySelector('[data-wm-qr-save]')?.addEventListener('click', () => {
      const link = document.createElement('a');
      link.href = qrSvg(qr.token).createDataURL(12, 4);
      link.download = `${board.booth.name}-웨이팅-QR.gif`;
      document.body.appendChild(link); link.click(); link.remove();
    });
    root.querySelector('[data-wm-qr-print]')?.addEventListener('click', () => {
      document.body.classList.add('print-waiting-qr');
      const done = () => { document.body.classList.remove('print-waiting-qr'); window.removeEventListener('afterprint', done); };
      window.addEventListener('afterprint', done);
      window.print();
      setTimeout(done, 1000);
    });
    root.querySelector('[data-wm-qr-full]')?.addEventListener('click', () => {
      const card = root.querySelector('[data-wm-qr-card]');
      (card?.requestFullscreen?.() || Promise.reject()).catch(() => card?.classList.toggle('is-full'));
    });
    if (tab === 'qr' && qr?.mode === 'rotating' && !qrTimer) loadQr();
  }

  // 1 second clock for the no-show countdowns.
  setInterval(() => {
    document.querySelectorAll('[data-wm-deadline]').forEach(node => {
      const left = Math.max(0, Math.ceil((new Date(node.dataset.wmDeadline).getTime() - now()) / 1000));
      node.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    });
  }, 1000);

  return { view, bind, reset };
})();
