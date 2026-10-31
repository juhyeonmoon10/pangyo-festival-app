/* 부스 담당자: students an operator put in charge of their own club's booth. They edit the booth's
   profile photo, status, operating hours, location (floor, map room, description), introduction and
   program, and approve manual stamps there when the operator allowed it.
   Every action is re-checked by festival_booth_manager; operators grant the role in 관리 마법사. */
const festivalBoothManager = (() => {
  let owner = null, status = null, loading = false, failure = '', selected = '', note = '', tone = '', busy = false;
  let lookup = null, adminList = null, adminLoading = false, adminFailure = '', candidate = null, adminNote = '', adminTone = '';
  // Photo chosen but not saved yet: { booth, blob, preview } or { booth, removed: true }.
  let photo = null, photoNote = '';
  const images = () => festivalAccount?.boothImages;
  const h = value => escapeHtml(String(value ?? ''));
  const ops = () => festivalAccount?.operations;
  const STATUSES = [['open', '운영 중'], ['paused', '일시 중지'], ['closed', '마감']];
  // Operating hours are stored in program.hours but edited with the basic information.
  const PROGRAM = [['title', '프로그램 이름', 80], ['description', '활동 소개', 1000], ['duration', '소요 시간', 100], ['participation', '참여 방법', 300], ['materials', '준비물', 200]];
  const FLOORS = [1, 2, 3, 4];
  // Rooms drawn on the map for a floor (stairs left out), so the booth lands on the right room.
  const roomsOn = floor => typeof mapPlanForFloor === 'function'
    ? [...new Set(mapPlanForFloor(Number(floor)).rooms.filter(r => r.type !== 'core').map(r => r.label))] : [];
  const roomOptions = (floor, value) => `<option value="">지도에서 고르지 않음</option>${roomsOn(floor).map(r => `<option value="${h(r)}" ${r === value ? 'selected' : ''}>${h(r)}</option>`).join('')}`;
  const items = () => status?.items || [];
  const current = () => items().find(b => b.key === selected) || items()[0] || null;
  const say = (text, kind = 'success') => { note = text; tone = kind; };
  const sayAdmin = (text, kind = 'success') => { adminNote = text; adminTone = kind; };
  const message = (text, kind) => text ? `<p class="ops-form-status" data-tone="${kind === 'error' ? 'error' : 'success'}" role="status">${h(text)}</p>` : '';

  function reset() {
    owner = state.user?.id || null; status = null; failure = ''; selected = ''; note = ''; lookup = null; dropPhoto();
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

  function dropPhoto() { if (photo?.preview) URL.revokeObjectURL(photo.preview); photo = null; photoNote = ''; }

  // The photo shown now: the unsaved choice, the saved photo, or the club's catalog image.
  function photoMarkup(b) {
    const local = typeof boothForKey === 'function' ? boothForKey(b.key) : null;
    const pending = photo?.booth === b.key ? photo : null;
    const fallback = local?.catalogImage || '';
    const src = pending ? (pending.removed ? fallback : pending.preview) : b.image ? images()?.url(b.image) : fallback;
    const own = pending ? !pending.removed : Boolean(b.image);
    return `<div class="manager-photo" data-manager-photo>
      ${src ? `<img src="${h(src)}" alt="${h(b.name)} 프로필 사진">` : `<span class="manager-photo-empty" aria-hidden="true">${h(String(b.name || '부').slice(0, 1))}</span>`}
      <div><strong>프로필 사진</strong><small>${pending ? '저장하면 바뀌어요.' : own ? '올린 사진' : src ? '동아리 기본 이미지' : '사진 없음'}</small>
        <span class="sun-actions"><label class="ghost-btn">${icon('plus')} 사진 고르기<input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" data-manager-photo-file hidden></label>
        ${pending ? `<button type="button" class="ghost-btn" data-manager-photo-undo>되돌리기</button>` : own ? `<button type="button" class="ghost-btn" data-manager-photo-remove>사진 빼기</button>` : ''}</span>
        ${photoNote ? `<small class="is-warning" role="status">${h(photoNote)}</small>` : ''}</div></div>`;
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
      // A server without booth-profile.sql sends no 'room': the new fields would not be saved.
      const full = 'room' in b;
      body = `${items().length > 1 ? `<label class="manager-pick">관리할 부스<select class="select" data-manager-booth>${items().map(x => `<option value="${h(x.key)}" ${x.key === b.key ? 'selected' : ''}>${h(x.name)}</option>`).join('')}</select></label>` : ''}
        <section class="ops-section manager-booth"><h2>${h(b.name)}</h2><p class="web-muted">${h(b.location || '위치 미등록')} · ${Number(b.floor) || 1}층${status.isAdmin ? ' · 운영자' : ' · 부스 담당자'}</p>
          <form class="ops-form" data-manager-save>
            ${full ? photoMarkup(b) : ''}
            <label>운영 상태<select class="select" name="status">${STATUSES.map(([v, t]) => `<option value="${v}" ${b.status === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
            <label>운영 시간<input class="input" name="program.hours" maxlength="100" value="${h(p.hours)}" placeholder="예: 10:00–12:00, 13:00–15:00" autocomplete="off"></label>
            ${full ? `<fieldset class="manager-program"><legend>위치</legend>
              <label>층<select class="select" name="floor" data-manager-floor>${FLOORS.map(f => `<option value="${f}" ${Number(b.floor) === f ? 'selected' : ''}>${f}층</option>`).join('')}</select></label>
              <label>지도 위치<select class="select" name="room" data-manager-room>${roomOptions(b.floor, b.room)}</select><small class="web-muted">고른 방에 부스가 지도에 표시돼요.</small></label>
              ${field('location', '위치 설명', b.location, 200)}</fieldset>` : '<p class="web-muted">사진·위치는 서버 업데이트 후 바꿀 수 있어요.</p>'}
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
    const program = Object.fromEntries([...PROGRAM.map(([k]) => k), 'hours'].map(k => [k, String(values[`program.${k}`] || '').trim()]).filter(([, v]) => v));
    const payload = { booth: b.key, version: b.version, status: values.status, description: String(values.description || '').trim(), program };
    if ('room' in b) {
      payload.floor = Number(values.floor) || 1;
      payload.room = String(values.room || '').trim();
      // Without a description the room names the place, e.g. "3층 다목적강당".
      payload.location = String(values.location || '').trim() || (payload.room ? `${payload.floor}층 ${payload.room}` : '');
      payload.image = b.image || '';
    }
    if (b.status === 'open' && payload.status !== 'open' && !confirm(`'${b.name}'을(를) ${payload.status === 'paused' ? '일시 중지' : '마감'}할까요? 이 부스는 방문 인증이 중지돼요.`)) return;
    busy = true; note = ''; render();
    const actor = state.user?.id;
    const pending = 'room' in b && photo?.booth === b.key ? photo : null;
    let uploaded = '';
    if (pending?.blob) {
      const result = await images()?.upload(pending.blob);
      if (state.user?.id !== actor) return;
      if (!result?.ok) { busy = false; say(result?.message || '사진을 올리지 못했어요. 다시 시도해 주세요.', 'error'); render(); return; }
      uploaded = payload.image = result.path;
    } else if (pending?.removed) payload.image = '';
    const response = await ops().write('booth_manager_save', payload);
    busy = false;
    if (state.user?.id !== actor) return;
    if (!response.ok) { say(response.message, 'error'); if (uploaded) images()?.remove([uploaded]); }
    else {
      // The replaced photo is deleted when this account may (its uploader or an operator).
      if (b.image && b.image !== response.data.image) images()?.remove([b.image]);
      if (pending) dropPhoto();
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
    return `<div data-bm-root><section class="ops-section"><h2>부스 담당자 지정</h2><p>소속 확인이 끝난 학생에게만, 그 학생의 동아리 부스를 맡길 수 있어요. 담당자는 프로필 사진·운영 상태·운영 시간·위치·부스 소개·프로그램을 바꿀 수 있어요.</p>
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

  // Only the photo block is redrawn, so text typed in the form stays.
  function redrawPhoto(root, b) {
    const box = root.querySelector('[data-manager-photo]');
    if (!box || !b) return;
    box.outerHTML = photoMarkup(b);
    bindPhoto(root);
  }
  function bindPhoto(root) {
    root.querySelector('[data-manager-photo-file]')?.addEventListener('change', async e => {
      const file = e.currentTarget.files?.[0], b = current();
      if (!file || !b) return;
      try {
        const blob = await festivalNotices.shrink(file, 1080);
        dropPhoto(); photo = { booth: b.key, blob, preview: URL.createObjectURL(blob) };
      } catch { photoNote = '이 사진은 열 수 없어요. JPG·PNG 사진을 골라 주세요.'; }
      redrawPhoto(root, b);
    });
    root.querySelector('[data-manager-photo-remove]')?.addEventListener('click', () => { const b = current(); dropPhoto(); photo = { booth: b.key, removed: true }; redrawPhoto(root, b); });
    root.querySelector('[data-manager-photo-undo]')?.addEventListener('click', () => { dropPhoto(); redrawPhoto(root, current()); });
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
      root.querySelector('[data-manager-booth]')?.addEventListener('change', e => { selected = e.target.value; lookup = null; note = ''; dropPhoto(); render(); });
      root.querySelector('[data-manager-floor]')?.addEventListener('change', e => {
        const room = root.querySelector('[data-manager-room]');
        if (room) room.innerHTML = roomOptions(e.target.value, room.value);
      });
      bindPhoto(root);
      
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
