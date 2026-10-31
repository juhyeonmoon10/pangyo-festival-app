/* Operator screen for NTAG 424 DNA secure cards (SUN). Managed apart from the signed NFC tags; every
   action is re-checked by festival_sun_admin, and a card read is only ever verified on the server. */
const festivalSunCards = (() => {
  let owner = null, status = null, loading = false, failure = '', busy = false, note = '', tone = '';
  let keys = null, inspected = null, reader = null;
  const h = value => escapeHtml(String(value ?? ''));
  const api = () => festivalAccount?.operations;
  const time = value => value ? new Date(value).toLocaleString('ko-KR') : '-';
  const booths = () => state.db.booths.filter(b => b.officialClubId && boothKeyFor(b))
    .map(b => [boothKeyFor(b), catalogBooth(b)?.name || b.name]);
  const boothName = key => booths().find(([k]) => k === key)?.[1] || key;
  const REASONS = {
    format: '보안 카드 주소 형식이 아니에요. 카드에 쓴 주소에 picc_data와 cmac이 있는지 확인해 주세요.',
    meta: '카드의 SDM Meta Read 키(Key 1)가 서버 키와 다르거나, PICC 데이터 암호화(UID·카운터)가 꺼져 있어요.',
    mac: '카드의 SDM File Read 키(Key 2)가 서버 키와 다르거나, CMAC 위치·입력 위치가 가이드와 달라요.',
  };

  function reset() {
    owner = state.user?.id || null; status = null; failure = ''; note = ''; keys = null; inspected = null;
    stopReading();
  }
  function say(text, kind = 'success') { note = text; tone = kind; }

  async function load() {
    if (loading) return;
    if (!api()?.sun) { failure = '서버 연결을 확인할 수 없어요. 새로고침해 주세요.'; render(); return; }
    loading = true; failure = '';
    const actor = state.user?.id;
    const response = await api().sun('status');
    loading = false;
    if (state.user?.id !== actor) return;
    if (response.ok) status = response.data; else failure = response.message;
    render();
  }

  async function act(action, payload, done) {
    if (busy) return;
    busy = true; note = ''; render();
    const actor = state.user?.id;
    const response = await api().sun(action, payload);
    busy = false;
    if (state.user?.id !== actor) return;
    if (!response.ok) say(response.message, 'error');
    else { done?.(response.data); if (action !== 'inspect' && action !== 'keys_reveal') await reloadStatus(); }
    render();
  }
  async function reloadStatus() {
    const response = await api().sun('status');
    if (response.ok) status = response.data;
  }

  function inspect(read) {
    inspected = { read, result: null };
    return act('inspect', FestivalSun.payload(read), data => { inspected = { read, result: data }; });
  }

  function stopReading() {
    reader?.abort(); reader = null;
  }
  async function readCard() {
    if (reader) { stopReading(); render(); return; }
    if (!window.isSecureContext || !('NDEFReader' in window)) return;
    const controller = new AbortController();
    reader = controller; say('카드를 휴대폰 뒷면에 대 주세요.'); render();
    try {
      const ndef = new NDEFReader();
      ndef.onreading = event => {
        if (controller.signal.aborted) return;
        for (const record of event.message.records) {
          if (record.recordType !== 'url') continue;
          const read = FestivalSun.parse(new TextDecoder().decode(record.data));
          if (read) { stopReading(); note = ''; inspect(read); return; }
        }
        say('이 카드에는 보안 카드 주소가 없어요. 가이드대로 작성했는지 확인해 주세요.', 'error'); render();
      };
      ndef.onreadingerror = () => { say('카드를 읽지 못했어요. 다시 가까이 대 주세요.', 'error'); render(); };
      await ndef.scan({ signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) return;
      stopReading();
      say(error.name === 'NotAllowedError' ? 'NFC 권한을 허용해 주세요.' : 'NFC를 시작하지 못했어요. 휴대폰의 NFC 설정을 확인해 주세요.', 'error');
      render();
    }
  }

  function keySection() {
    if (!status.configured) {
      return `<section class="ops-section"><h2>1. 카드 키 만들기</h2><p>카드와 서버가 함께 쓰는 AES-128 키 두 개를 만들어요. 키는 서버 금고(Vault)에만 저장돼요.</p>
        <button type="button" class="primary-btn" data-sun-keys-create ${busy ? 'disabled' : ''}>${icon('lock')} 키 만들기</button>
        <details class="sun-details"><summary>이미 카드에 쓴 키가 있으면 직접 입력</summary>
          <form class="ops-form" data-sun-keys-form>
            <label>SDM Meta Read 키 (Key 1, 32자리)<input class="input sun-mono" name="metaKey" required pattern="[0-9A-Fa-f]{32}" maxlength="32" autocomplete="off" spellcheck="false"></label>
            <label>SDM File Read 키 (Key 2, 32자리)<input class="input sun-mono" name="fileKey" required pattern="[0-9A-Fa-f]{32}" maxlength="32" autocomplete="off" spellcheck="false"></label>
            <button class="ghost-btn" type="submit">${icon('save')} 입력한 키 저장</button>
          </form></details></section>`;
    }
    return `<section class="ops-section"><h2>1. 카드 키</h2>
      <p class="sun-status ${status.enabled ? '' : 'is-off'}">${icon(status.enabled ? 'check' : 'notice')}<span>보안 카드 적립 <strong>${status.enabled ? '사용 중' : '중지됨'}</strong> · 키 생성 ${h(time(status.keysCreatedAt))}</span></p>
      <div class="sun-actions">
        <button type="button" class="ghost-btn" data-sun-enable="${!status.enabled}" ${busy ? 'disabled' : ''}>${status.enabled ? '보안 카드 적립 중지' : '보안 카드 적립 다시 사용'}</button>
        <button type="button" class="ghost-btn" data-sun-keys-reveal ${busy ? 'disabled' : ''}>${icon('lock')} ${keys ? '키 숨기기' : '카드 작성용 키 보기'}</button>
      </div>
      ${keys ? `<div class="sun-keys" role="group" aria-label="카드 작성용 키"><p class="ops-alert" role="alert">화면을 공유하거나 촬영하지 마세요. 키를 본 기록이 남아요.</p>
        ${[['SDM Meta Read 키 · Key 1', keys.metaKey], ['SDM File Read 키 · Key 2', keys.fileKey]].map(([label, value]) => `<label>${label}<span class="sun-key"><code class="sun-mono">${h(value.toUpperCase())}</code><button type="button" class="icon-btn" data-sun-copy="${h(value.toUpperCase())}" aria-label="${label} 복사">${icon('copy')}</button></span></label>`).join('')}</div>` : ''}
      <details class="sun-details"><summary>키 교체</summary>
        <p>키를 바꾸면 지금까지 작성한 카드가 모두 인식되지 않아요. 카드를 새 키로 다시 작성해야 해요.</p>
        <form class="ops-form" data-sun-keys-form data-replace><label>확인 문구 ("키 교체")<input class="input" name="confirm" required autocomplete="off"></label>
          <button class="ghost-btn" type="submit">새 키 만들기</button></form>
      </details></section>`;
  }

  function writeSection() {
    let layout;
    try { layout = FestivalSun.layout(location.origin); }
    catch { return '<section class="ops-section"><h2>2. 카드에 쓸 내용</h2><p class="sun-hint">축제 사이트(https 주소)에서 이 화면을 열면 카드에 쓸 주소와 위치 값이 보여요.</p></section>'; }
    const row = (label, value) => `<div><dt>${label}</dt><dd><code class="sun-mono">${h(value)}</code></dd></div>`;
    return `<section class="ops-section"><h2>2. 카드에 쓸 내용</h2><p>모든 카드에 같은 내용을 써요. 자세한 순서는 NTAG 424 DNA 카드 작성 가이드를 따라 주세요.</p>
      <dl class="sun-layout">
        ${row('주소 (URL 레코드)', layout.url)}
        ${row('PICC 데이터 위치 (PICCDataOffset)', `${layout.piccOffset} (0x${layout.piccOffset.toString(16).toUpperCase()})`)}
        ${row('CMAC 위치 (SDMMACOffset)', `${layout.macOffset} (0x${layout.macOffset.toString(16).toUpperCase()})`)}
        ${row('CMAC 입력 위치 (SDMMACInputOffset)', `${layout.macInputOffset} (CMAC 위치와 같게)`)}
        ${row('SDM 옵션', 'UID 미러 + 읽기 카운터 미러 + ASCII')}
        ${row('키 번호', 'Meta Read = Key 1 · File Read = Key 2 · 카운터 조회 = 없음(F)')}
        ${row('NDEF 파일 접근', '읽기 자유(E) · 쓰기/설정 변경 = Key 0')}
      </dl>
      <button type="button" class="text-link" data-sun-copy="${h(layout.url)}">${icon('copy')} 주소 복사</button></section>`;
  }

  function inspectView() {
    if (!inspected) return '';
    const r = inspected.result;
    if (!r) return '<p role="status">카드를 확인하는 중...</p>';
    if (!r.ok) return `<div class="sun-inspect is-error" role="alert"><strong>${icon('notice')} 확인되지 않은 카드</strong><p>${h(REASONS[r.reason] || '카드를 확인하지 못했어요.')}</p></div>`;
    const card = r.card;
    const facts = `<p>UID <code class="sun-mono">${h(r.uid)}</code> · 읽기 ${Number(r.counter)}회째 · CMAC ${r.macMode === 'input' ? '주소 문자열 포함' : '빈 입력'}</p>`
      + (r.fresh ? '' : '<p>이 주소는 이미 사용됐어요. 학생이 적립하려면 카드를 다시 찍어야 해요.</p>');
    if (card) return `<div class="sun-inspect" role="status"><strong>${icon('check')} 등록된 카드 · ${h(boothName(card.boothKey))}${card.label ? ` · ${h(card.label)}` : ''}${card.revokedAt ? ' · 사용 중지됨' : ''}</strong>${facts}</div>`;
    return `<div class="sun-inspect" role="status"><strong>${icon('check')} 정상 카드 · 아직 등록 전</strong>${facts}
      <form class="ops-form" data-sun-register>
        <label>연결할 부스<select class="select" name="booth" required>${booths().map(([key, name]) => `<option value="${h(key)}">${h(name)}</option>`).join('')}</select></label>
        <label>카드 메모 (선택)<input class="input" name="label" maxlength="40" autocomplete="off" placeholder="예: 정문 카드"></label>
        <button class="primary-btn" type="submit" ${busy ? 'disabled' : ''}>${icon('plus')} 이 부스에 카드 등록</button>
      </form></div>`;
  }

  function checkSection() {
    let last = null;
    try { last = FestivalSun.fromToken(sessionStorage.getItem(SUN_LAST_READ_KEY) || ''); } catch { /* Optional. */ }
    const canRead = window.isSecureContext && 'NDEFReader' in window;
    return `<section class="ops-section"><h2>3. 카드 확인·등록</h2><p>작성한 카드를 찍어 서버 키로 확인하고 부스에 연결해요. 확인만으로는 카드 주소가 사용되지 않아요.</p>
      <div class="sun-actions">
        ${canRead ? `<button type="button" class="primary-btn" data-sun-read>${icon('scan')} ${reader ? '읽기 중지' : '카드 읽기'}</button>` : ''}
        ${last ? `<button type="button" class="ghost-btn" data-sun-last>${icon('refresh')} 방금 찍은 카드 확인</button>` : ''}
      </div>
      ${canRead ? '' : '<p class="sun-hint">이 브라우저는 카드를 직접 읽지 못해요. 카드를 휴대폰에 대서 열린 주소를 붙여 넣거나, 카드를 찍은 뒤 이 화면으로 돌아와 "방금 찍은 카드 확인"을 눌러 주세요.</p>'}
      <form class="ops-form" data-sun-paste><label>카드 주소 붙여넣기<input class="input sun-mono" name="address" required autocomplete="off" spellcheck="false" placeholder="https://…#picc_data=…&cmac=…"></label>
        <button class="ghost-btn" type="submit">${icon('search')} 주소 확인</button></form>
      ${inspectView()}</section>`;
  }

  function listSection() {
    const items = status.items || [];
    return `<section class="ops-section"><h2>4. 등록된 카드 <span>${items.length}장</span></h2>${items.length ? `<ul class="sun-card-list">${items.map(c => `<li class="${c.revokedAt ? 'is-off' : ''}">
      <div><strong>${h(boothName(c.boothKey))}</strong>${c.label ? ` · ${h(c.label)}` : ''}${c.revokedAt ? ' · <em>사용 중지</em>' : ''}
        <small>UID ${h(c.uid)} · 적립 ${Number(c.useCount)}회 · 마지막 ${h(time(c.lastUsedAt))} · 등록 ${h(c.registeredByName || '-')}</small></div>
      <details class="sun-details"><summary>관리</summary><form class="ops-form" data-sun-edit="${h(c.uid)}">
        <label>부스<select class="select" name="booth">${booths().map(([key, name]) => `<option value="${h(key)}" ${key === c.boothKey ? 'selected' : ''}>${h(name)}</option>`).join('')}</select></label>
        <label>메모<input class="input" name="label" maxlength="40" value="${h(c.label)}" autocomplete="off"></label>
        <div class="sun-actions"><button class="ghost-btn" type="submit">${icon('save')} 저장</button>
          <button type="button" class="ghost-btn" data-sun-toggle="${h(c.uid)}" data-revoked="${c.revokedAt ? 'true' : 'false'}">${c.revokedAt ? '다시 사용' : '사용 중지'}</button></div>
      </form></details></li>`).join('')}</ul>` : '<p class="ops-empty">아직 등록한 카드가 없어요.</p>'}</section>`;
  }

  function view() {
    if (owner !== (state.user?.id || null)) reset();
    const intro = `<h1>보안 NFC 카드</h1><p class="sun-intro">NTAG 424 DNA 카드는 찍을 때마다 암호화된 1회용 주소를 만들어요. 주소를 복사해 다른 사람에게 보내도 적립되지 않아요. 일반 NFC 태그와 따로 관리돼요.</p>`;
    const message = note ? `<p class="ops-form-status" data-tone="${tone === 'error' ? 'error' : 'success'}" role="status">${h(note)}</p>` : '';
    if (failure) return `<div class="ops-body" data-sun-root>${intro}<p class="ops-alert" role="alert">${h(failure)}</p><button type="button" class="ghost-btn" data-sun-refresh>${icon('refresh')} 다시 불러오기</button></div>`;
    if (!status) return `<div class="ops-body" data-sun-root aria-busy="true">${intro}<p role="status">불러오는 중...</p></div>`;
    return `<div class="ops-body" data-sun-root>${intro}${message}${keySection()}${status.configured ? writeSection() + checkSection() + listSection() : ''}</div>`;
  }

  function bind() {
    const root = document.querySelector('[data-sun-root]');
    if (!root) { stopReading(); return; }
    if (!isAdminUser()) return;
    if (!status && !failure && !loading) queueMicrotask(load);
    root.querySelector('[data-sun-refresh]')?.addEventListener('click', () => { failure = ''; render(); load(); });
    root.querySelector('[data-sun-keys-create]')?.addEventListener('click', () => act('keys_create', {}, () => say('키를 만들었어요. 카드 작성용 키를 보고 카드에 써 주세요.')));
    root.querySelectorAll('[data-sun-keys-form]').forEach(form => form.addEventListener('submit', event => {
      event.preventDefault();
      const body = Object.fromEntries(new FormData(form));
      if (form.hasAttribute('data-replace') && !confirm('키를 바꾸면 지금까지 작성한 카드가 모두 인식되지 않아요. 계속할까요?')) return;
      act('keys_create', body, () => { keys = null; say(form.hasAttribute('data-replace') ? '새 키로 바꿨어요. 카드를 새 키로 다시 작성해 주세요.' : '입력한 키를 저장했어요.'); });
    }));
    root.querySelector('[data-sun-keys-reveal]')?.addEventListener('click', () => {
      if (keys) { keys = null; render(); return; }
      act('keys_reveal', {}, data => { keys = data; });
    });
    root.querySelector('[data-sun-enable]')?.addEventListener('click', event => {
      const enabled = event.currentTarget.dataset.sunEnable === 'true';
      if (!enabled && !confirm('보안 카드 적립을 중지할까요? 일반 NFC 태그는 영향을 받지 않아요.')) return;
      act('enable', { enabled }, () => say(enabled ? '보안 카드 적립을 다시 사용해요.' : '보안 카드 적립을 중지했어요.'));
    });
    root.querySelectorAll('[data-sun-copy]').forEach(button => button.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(button.dataset.sunCopy); say('복사했어요.'); } catch { say('복사하지 못했어요. 직접 선택해 복사해 주세요.', 'error'); }
      render();
    }));
    root.querySelector('[data-sun-read]')?.addEventListener('click', readCard);
    root.querySelector('[data-sun-last]')?.addEventListener('click', () => {
      try { const read = FestivalSun.fromToken(sessionStorage.getItem(SUN_LAST_READ_KEY) || ''); if (read) inspect(read); } catch { /* Optional. */ }
    });
    root.querySelector('[data-sun-paste]')?.addEventListener('submit', event => {
      event.preventDefault();
      const read = FestivalSun.parse(event.currentTarget.elements.address.value.trim());
      if (!read) { inspected = { read: null, result: { ok: false, reason: 'format' } }; render(); return; }
      inspect(read);
    });
    root.querySelector('[data-sun-register]')?.addEventListener('submit', event => {
      event.preventDefault();
      const form = event.currentTarget, read = inspected?.read;
      if (!read) return;
      act('register', { ...FestivalSun.payload(read), booth: form.elements.booth.value, label: form.elements.label.value.trim() },
        data => { inspected = null; say(`${boothName(data.boothKey)}에 카드를 등록했어요.`); });
    });
    root.querySelectorAll('[data-sun-edit]').forEach(form => form.addEventListener('submit', async event => {
      event.preventDefault();
      const uid = form.dataset.sunEdit, card = status.items.find(c => c.uid === uid);
      if (!card) return;
      if (form.elements.booth.value !== card.boothKey) await act('move', { uid, booth: form.elements.booth.value }, () => say('부스를 바꿨어요.'));
      if (form.elements.label.value.trim() !== card.label) await act('label', { uid, label: form.elements.label.value.trim() }, () => say('메모를 저장했어요.'));
    }));
    root.querySelectorAll('[data-sun-toggle]').forEach(button => button.addEventListener('click', () => {
      const restore = button.dataset.revoked === 'true';
      if (!restore && !confirm('이 카드를 사용 중지할까요? 학생이 찍어도 적립되지 않아요.')) return;
      act(restore ? 'restore' : 'revoke', { uid: button.dataset.sunToggle }, () => say(restore ? '카드를 다시 사용해요.' : '카드를 사용 중지했어요.'));
    }));
  }

  return { view, bind };
})();
