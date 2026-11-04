/* 웨이팅 (1.59), the student side. A booth manager turns waiting on in 부스 관리 → 웨이팅 관리
   (waiting-manager.js). Students register online from the booth page or with the booth's on-site QR
   (/waiting/join/<booth>#q=<token>), pick the party size, and follow their place at /waiting/<id>.
   Places come from festival_waiting. While a waiting is open the pages read it again every 10 seconds and
   say in the page when the teams ahead go down. Push notifications (sw.js) reach the phone when the page
   is closed: Android asks for permission here; an iPhone needs the site on the home screen first, which a
   popup right after registering insists on (1.60). */
const festivalWaiting = (() => {
  const h = value => escapeHtml(String(value ?? ''));
  const ops = () => festivalAccount?.operations;
  const POLL_MS = 10000;
  const QR_KEY = 'pangyo-waiting-qr-v1';
  let owner = null, mine = null, mineLoading = null, mineFailure = '';
  const booths = new Map(), boothLoading = new Map(), entries = new Map();
  let join = null;          // { booth, party, busy, note } while the party picker is open
  let justJoined = null;    // entry id whose page shows "웨이팅 등록 완료"
  let postpone = null;      // { id, teams }
  let note = null, timer = null, pushNote = '', pushBusy = false, subscribedFor = null;

  const api = (action, payload) => ops()?.waiting ? ops().waiting(action, payload) : Promise.resolve({ ok: false, message: '웨이팅을 불러올 수 없어요.' });
  const active = entry => ['waiting', 'called'].includes(entry?.status);
  const minutesText = (ahead, total, minutes) => ahead <= 0 ? '곧 입장' : Number.isFinite(minutes) ? `약 ${minutes}분` : '안내 없음';
  const waitText = entry => minutesText(entry.ahead, entry.total, entry.estimateMinutes);
  const sourceName = { online: '온라인 등록', qr: '현장 QR 등록', walkin: '현장 등록' };
  const selected = () => state.db?.booths?.find(b => b.id === state.selectedBoothId) || null;
  const keyOf = booth => booth?.opsKey || booth?.opsRecord?.key || '';
  const nameOf = key => (typeof boothForKey === 'function' ? boothForKey(key) : null)?.opsRecord?.name || key;
  const time = value => value ? new Date(value).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '';

  function reset() {
    owner = state.user?.id || null; mine = null; mineFailure = ''; booths.clear(); entries.clear();
    join = null; justJoined = null; postpone = null; note = null; subscribedFor = null; pushNote = '';
  }
  const ready = () => isServerMode() && state.user && ops()?.waiting;

  // The QR's token is taken out of the address and kept for this tab, so it survives Google sign-in.
  function readQrFromUrl() {
    try {
      const url = new URL(location.href);
      const parsed = window.FestivalRouter?.parse(url.pathname);
      const token = new URLSearchParams(url.hash.slice(1)).get('q');
      if (parsed?.route !== 'waitingJoin' || !token) return;
      sessionStorage.setItem(QR_KEY, JSON.stringify({ booth: parsed.waitingBooth, token: token.slice(0, 60), at: Date.now() }));
      url.hash = '';
      history.replaceState(history.state, '', url.href);
    } catch { /* Storage or History can be unavailable in previews. */ }
  }
  function scannedToken(booth) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(QR_KEY) || 'null');
      return saved && saved.booth === booth && Date.now() - saved.at < 600000 ? saved.token : '';
    } catch { return ''; }
  }
  function forgetToken() { try { sessionStorage.removeItem(QR_KEY); } catch { /* Optional. */ } }

  // Loading ----------------------------------------------------------------------------------------------
  // A read already on its way is shared, so a screen drawn while it runs waits for it instead of asking
  // again (and drawing again) in a loop.
  function loadMine() {
    if (!ready()) return Promise.resolve();
    if (mineLoading) return mineLoading;
    const actor = state.user.id;
    mineLoading = api('mine').then(response => {
      if (state.user?.id !== actor) return;
      // A failed read shows an empty list until the next 10-second read.
      if (!response.ok) { mineFailure = response.message; if (!mine) mine = []; return; }
      const before = mine;
      mine = response.data.items || []; mineFailure = '';
      mine.forEach(item => entries.set(item.id, item));
      if (before) announce(before, mine);
      if (mine.some(active)) ensurePush(false);
    }).finally(() => { mineLoading = null; });
    return mineLoading;
  }
  function loadBooth(key) {
    if (!ready() || !key) return Promise.resolve();
    if (boothLoading.has(key)) return boothLoading.get(key);
    const actor = state.user.id;
    const call = api('booth', { booth: key }).then(response => {
      if (state.user?.id !== actor) return;
      booths.set(key, response.ok ? response.data : { failed: true, message: response.message });
      if (response.ok && response.data.mine) entries.set(response.data.mine.id, response.data.mine);
    }).finally(() => boothLoading.delete(key));
    boothLoading.set(key, call);
    return call;
  }
  const entryLoading = new Map();
  function loadEntry(id) {
    if (!ready() || !id) return Promise.resolve();
    if (entryLoading.has(id)) return entryLoading.get(id);
    const actor = state.user.id;
    const call = api('entry', { id }).then(response => {
      if (state.user?.id !== actor) return;
      entries.set(id, response.ok ? response.data : { id, failed: true, message: response.message });
    }).finally(() => entryLoading.delete(id));
    entryLoading.set(id, call);
    return call;
  }

  // In-page notice when the numbers changed between two reads (the push covers a closed page).
  function announce(before, after) {
    for (const next of after) {
      const old = before.find(item => item.id === next.id);
      if (!old) continue;
      let text = '';
      if (old.status === 'waiting' && next.status === 'called') text = `${next.boothName} · 입장할 차례예요. 부스로 와 주세요.`;
      else if (active(old) && next.status === 'noshow') text = `${next.boothName} · 호출 후 오지 않아 노쇼로 처리됐어요.`;
      else if (active(old) && next.status === 'cancelled' && next.endedBy === 'manager') text = `${next.boothName} · 부스에서 웨이팅을 취소했어요.`;
      else if (next.status === 'waiting' && old.status === 'waiting' && next.ahead < old.ahead) {
        text = `${next.boothName} · 현재 대기순번 ${next.position}번째 · 현재 대기 ${next.total}팀 · 예상 대기시간 ${waitText(next)}`;
      }
      if (text) toast(text, next.id, next.status === 'called');
    }
  }
  function toast(text, id, strong = false) {
    document.querySelector('.waiting-toast')?.remove();
    const box = document.createElement('button');
    box.type = 'button';
    box.className = `waiting-toast${strong ? ' is-called' : ''}`;
    box.setAttribute('role', 'status');
    box.innerHTML = `${icon(strong ? 'bellRing' : 'clock')}<span>${h(text)}</span>`;
    box.addEventListener('click', () => { box.remove(); open(id); });
    document.body.appendChild(box);
    try { if (strong) navigator.vibrate?.([200, 100, 200]); else navigator.vibrate?.(80); } catch { /* Optional. */ }
    setTimeout(() => box.remove(), strong ? 12000 : 6000);
  }

  function open(id) {
    state.waitingId = id;
    navigateTo('waiting');
  }

  // Push ------------------------------------------------------------------------------------------------
  const isApple = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';
  const permission = () => typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
  const decodeKey = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')), c => c.charCodeAt(0));
  const encodeKey = buffer => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  async function worker() {
    if (!('serviceWorker' in navigator)) return null;
    try { await navigator.serviceWorker.register('/sw.js', { scope: '/' }); return await navigator.serviceWorker.ready; } catch { return null; }
  }
  // Subscribes this browser for the signed-in account (once per sign-in) when notifications are allowed.
  async function ensurePush(ask) {
    if (!ready() || !pushSupported()) return false;
    if (ask && permission() === 'default') {
      try { await Notification.requestPermission(); } catch { return false; }
    }
    if (permission() !== 'granted') return false;
    if (subscribedFor === state.user.id) return true;
    const actor = state.user.id;
    const registration = await worker();
    if (!registration) return false;
    const key = await api('push_key');
    if (!key.ok || !key.data.publicKey || state.user?.id !== actor) return false;
    try {
      let subscription = await registration.pushManager.getSubscription();
      // A subscription made for another key cannot receive these messages.
      const current = subscription?.options?.applicationServerKey;
      if (subscription && current && encodeKey(current) !== key.data.publicKey) { await subscription.unsubscribe(); subscription = null; }
      if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeKey(key.data.publicKey) });
      const json = subscription.toJSON();
      const saved = await api('push_subscribe', { endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth });
      if (!saved.ok) return false;
      subscribedFor = actor;
      return true;
    } catch { return false; }
  }
  async function signOut() {
    if (!ready() || !pushSupported()) return;
    try {
      const registration = await navigator.serviceWorker.getRegistration('/');
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) await api('push_unsubscribe', { endpoint: subscription.endpoint });
    } catch { /* The server forgets a stale subscription on its own. */ }
  }

  // iPhone steps, shared by the card and the popup after registering. Since iOS 16.4 every iPhone browser
  // (Safari, Chrome, Edge, ...) can add the site to the home screen, so the steps name no browser.
  const appleSteps = () => `<ol><li>브라우저의 ${icon('share')} 공유 버튼을 눌러요. 보이지 않으면 메뉴(⋯)에서 '공유'를 찾아요.</li><li>'홈 화면에 추가'를 눌러요.</li><li>홈 화면에 생긴 '판교고 축제'로 열고, 같은 계정으로 로그인한 뒤 '알림 허용'을 눌러요.</li></ol>`;
  // Warning popups over the ticket right after registering, for what the notifications still need.
  function warnDialog(kind, html) {
    document.querySelector('.waiting-warn-dialog')?.remove();
    const dialog = document.createElement('dialog');
    dialog.className = `waiting-warn-dialog waiting-${kind}-dialog`;
    dialog.setAttribute('aria-labelledby', 'waitingWarnTitle');
    dialog.setAttribute('aria-describedby', 'waitingWarnLead');
    dialog.innerHTML = html;
    document.body.appendChild(dialog);
    dialog.addEventListener('close', () => dialog.remove());
    dialog.showModal();
    return dialog;
  }
  const warnHead = (iconName, kicker, title, lead) => `<span class="waiting-warn-icon" aria-hidden="true">${icon(iconName)}</span>
    <p class="waiting-warn-kicker">${icon('alert')} ${kicker}</p><h2 id="waitingWarnTitle">${title}</h2><p id="waitingWarnLead">${lead}</p>`;
  // An iPhone in the browser: the notifications cannot arrive at all until the site is on the home screen.
  function appleNotice() {
    const dialog = warnDialog('apple', `${warnHead('bellRing', '꼭 확인해 주세요', '지금 이대로는 알림이 오지 않아요', 'iPhone은 이 사이트를 <strong>홈 화면에 추가</strong>해야 순서가 바뀌거나 입장할 차례가 됐을 때 알림을 받을 수 있어요.')}
      <div class="waiting-warn-steps">${appleSteps()}</div>
      <p class="waiting-warn-keep">${icon('check')} 웨이팅은 이미 등록됐어요. 홈 화면 앱에서 같은 계정으로 로그인하면 그대로 이어서 볼 수 있어요.</p>
      <button type="button" class="primary-btn full-action" data-waiting-apple-ok>확인했어요</button>`);
    dialog.querySelector('[data-waiting-apple-ok]').addEventListener('click', () => dialog.close());
  }
  // Blocked notifications: the browser never asks again, so only the settings can turn them back on.
  function blockedNotice(dialog) {
    const html = `${warnHead('bell', '알림이 차단돼 있어요', '이대로는 차례가 돼도 알림이 오지 않아요', '이 사이트의 알림이 <strong>차단</strong>돼 있어요. 설정에서 직접 <strong>허용</strong>으로 바꿔야 알림을 받을 수 있어요.')}
      <div class="waiting-warn-steps"><ol><li>브라우저 주소창 왼쪽의 자물쇠(또는 설정) 아이콘을 눌러요. 홈 화면 앱이면 휴대폰 '설정' → '알림'에서 '판교고 축제'를 찾아요.</li><li>'알림'을 <strong>'허용'</strong>으로 바꿔요.</li><li>이 화면으로 돌아와 새로고침해요.</li></ol></div>
      <button type="button" class="primary-btn full-action" data-waiting-warn-ok>확인했어요</button>`;
    if (dialog) dialog.innerHTML = html; else dialog = warnDialog('permission', html);
    dialog.querySelector('[data-waiting-warn-ok]').addEventListener('click', () => dialog.close());
  }
  // Anywhere else the browser asks for the permission itself. The warning comes first and its one button
  // opens the browser's question, which only appears reliably when a tap opens it. There is no "later":
  // until the button has been pressed once, Back does not close the popup either.
  function permissionNotice() {
    if (!pushSupported() || permission() === 'granted') return;
    if (permission() === 'denied') { blockedNotice(); return; }
    const dialog = warnDialog('permission', `${warnHead('bellRing', '반드시 허용해 주세요', '알림을 허용하지 않으면 차례를 놓칠 수 있어요', "곧 알림 권한을 묻는 창이 떠요. 꼭 <strong>'허용'</strong>을 눌러 주세요. 허용하지 않으면 입장할 차례가 돼도 알림이 오지 않고, 호출에 늦으면 노쇼로 처리돼 웨이팅이 취소될 수 있어요.")}
      <div class="waiting-warn-steps"><ol><li>아래 '알림 허용하기'를 눌러요.</li><li>뜨는 창에서 <strong>'허용'</strong>을 눌러요. '차단'이나 '허용 안함'을 누르면 다시 켜기 어려워요.</li></ol></div>
      <p class="waiting-warn-note" role="status" data-waiting-warn-note hidden></p>
      <button type="button" class="primary-btn full-action" data-waiting-warn-allow>${icon('bell')} 알림 허용하기</button>`);
    let asked = false;
    dialog.addEventListener('cancel', event => { if (!asked) event.preventDefault(); });
    const button = dialog.querySelector('[data-waiting-warn-allow]');
    const message = dialog.querySelector('[data-waiting-warn-note]');
    button.addEventListener('click', async () => {
      asked = true; button.disabled = true;
      const done = await ensurePush(true);
      redraw('alert');
      if (done) { dialog.close(); return; }
      if (permission() === 'denied') { blockedNotice(dialog); return; }
      button.disabled = false;
      button.innerHTML = `${icon('bell')} 다시 허용하기`;
      message.hidden = false;
      message.textContent = permission() === 'granted' ? '알림은 허용됐지만 연결하지 못했어요. 다시 눌러 주세요.' : "아직 허용되지 않았어요. 다시 눌러 '허용'을 선택해 주세요.";
    });
  }

  // What the student needs to do so a closed page still gets the notifications.
  function alertCard() {
    if (!ready()) return '';
    const p = permission();
    if (isApple() && !standalone()) {
      return `<section class="waiting-alert-card is-apple" data-waiting-alert>${icon('bell')}<div><strong>iPhone에서 알림을 받으려면 홈 화면에 추가해 주세요</strong>
        ${appleSteps()}
        <small>지금 이 화면을 열어 두면 순서가 바뀔 때 화면에서 알려 드려요.</small></div></section>`;
    }
    if (!pushSupported()) return `<section class="waiting-alert-card" data-waiting-alert>${icon('bell')}<div><strong>이 브라우저는 알림을 받을 수 없어요</strong><small>이 화면을 열어 두면 순서가 바뀔 때 화면에서 알려 드려요.</small></div></section>`;
    if (p === 'denied') return `<section class="waiting-alert-card is-warning" data-waiting-alert>${icon('bell')}<div><strong>알림이 차단돼 있어요</strong><small>브라우저 설정에서 이 사이트의 알림을 '허용'으로 바꿔 주세요. 그동안은 이 화면을 열어 두면 화면에서 알려 드려요.</small></div></section>`;
    if (p === 'granted' && subscribedFor === state.user?.id) return `<p class="waiting-alert-ok" data-waiting-alert>${icon('check')} 순서가 바뀌거나 호출되면 알림으로 알려 드려요.</p>`;
    return `<section class="waiting-alert-card is-warning" data-waiting-alert>${icon('bellRing')}<div><strong>알림을 허용해야 차례 알림을 받을 수 있어요</strong><small>${p === 'granted' ? '알림 연결이 아직 끝나지 않았어요. 아래 버튼을 눌러 주세요.' : '지금은 알림이 꺼져 있어요. 허용하지 않으면 입장할 차례가 돼도 알림이 오지 않아요.'}</small>
      <button type="button" class="primary-btn" data-waiting-push ${pushBusy ? 'disabled' : ''}>${icon('bell')} 알림 허용</button>${pushNote ? `<small class="is-warning" role="status">${h(pushNote)}</small>` : ''}</div></section>`;
  }

  // Booth page ---------------------------------------------------------------------------------------------
  function boothSection(booth) {
    if (!ready()) return '';
    const key = keyOf(booth);
    if (!key) return '';
    const info = booths.get(key);
    if (!info) { queueMicrotask(() => loadBooth(key).then(() => redraw('booth'))); return `<div data-waiting-booth="${h(key)}" hidden></div>`; }
    if (info.failed || !info.enabled) return `<div data-waiting-booth="${h(key)}" hidden></div>`;
    const own = info.mine && active(info.mine) ? info.mine : null;
    const badge = info.accepting ? '<span class="waiting-badge">접수 중</span>' : '<span class="waiting-badge is-off">접수 일시 중단</span>';
    const action = own
      ? `<button type="button" class="primary-btn full-action" data-waiting-open="${h(own.id)}">${icon('clock')} 내 웨이팅 보기 · 대기번호 ${own.number}번 · ${own.position}번째</button>`
      : !info.accepting ? '<p class="notice">지금은 웨이팅 접수를 잠시 멈췄어요. 잠시 후 다시 확인해 주세요.</p>'
      : info.online ? `<button type="button" class="primary-btn full-action" data-waiting-join="${h(key)}">${icon('clock')} 웨이팅 등록</button>`
      : info.qr ? `<p class="waiting-qr-only">${icon('qr')} 현장에서 부스의 QR을 찍어 웨이팅을 등록해 주세요.</p>` : '';
    return `<section class="panel section waiting-panel" data-waiting-booth="${h(key)}">
      <div class="waiting-panel-head"><h2>웨이팅</h2>${badge}</div>
      <dl class="waiting-stats"><div><dt>현재 대기</dt><dd>${info.total}<small>팀</small></dd></div>
        <div><dt>예상 대기시간</dt><dd>${h(minutesText(info.total, info.total, info.estimateMinutes))}</dd></div></dl>
      ${action}</section>`;
  }

  // Party picker: a sheet over the booth page, or the page opened by the on-site QR.
  function partyForm(key, info, viaQr) {
    const max = Math.max(1, Number(info?.maxParty) || 1);
    const party = Math.min(max, join?.booth === key ? join.party : 1);
    return `<form class="waiting-join-form" data-waiting-join-form="${h(key)}" data-via-qr="${viaQr ? 1 : 0}">
      <p class="waiting-join-label" id="waitingPartyLabel">인원수 <small>한 팀 최대 ${max}명</small></p>
      <div class="waiting-stepper" role="group" aria-labelledby="waitingPartyLabel">
        <button type="button" class="icon-btn" data-waiting-party="-1" aria-label="한 명 빼기" ${party <= 1 ? 'disabled' : ''}>${icon('minus')}</button>
        <output aria-live="polite"><strong>${party}</strong>명</output>
        <button type="button" class="icon-btn" data-waiting-party="1" aria-label="한 명 더하기" ${party >= max ? 'disabled' : ''}>${icon('plus')}</button>
      </div>
      ${info && Number.isFinite(info.total) ? `<p class="web-muted">지금 등록하면 현재 대기 ${info.total}팀 · 예상 대기시간 ${h(minutesText(info.total, info.total, info.estimateMinutes))}</p>` : ''}
      ${spotMarkup(note, 'join')}
      <button type="submit" class="primary-btn full-action" ${join?.busy ? 'disabled' : ''}>${icon('clock')} ${join?.busy ? '등록하는 중...' : '웨이팅 등록'}</button>
    </form>`;
  }
  function openSheet(key) {
    const info = booths.get(key);
    if (!info?.enabled) return;
    document.querySelector('.waiting-sheet')?.remove();
    join = { booth: key, party: 1, busy: false }; note = null;
    const dialog = document.createElement('dialog');
    dialog.className = 'waiting-sheet';
    dialog.setAttribute('aria-labelledby', 'waitingSheetTitle');
    dialog.innerHTML = `<header><h2 id="waitingSheetTitle">웨이팅 등록</h2><button type="button" class="icon-btn" data-waiting-close aria-label="닫기">${icon('close')}</button></header>
      <p class="waiting-sheet-booth">${h(nameOf(key))}</p><div data-waiting-sheet-body>${partyForm(key, info, false)}</div>`;
    document.body.appendChild(dialog);
    dialog.addEventListener('close', () => { dialog.remove(); join = null; });
    dialog.querySelector('[data-waiting-close]').addEventListener('click', () => dialog.close());
    bindForm(dialog);
    dialog.showModal();
  }
  function bindForm(root) {
    const form = root.querySelector('[data-waiting-join-form]');
    if (!form) return;
    const key = form.dataset.waitingJoinForm;
    form.querySelectorAll('[data-waiting-party]').forEach(button => button.addEventListener('click', () => {
      const max = Math.max(1, Number(booths.get(key)?.maxParty) || 1);
      join = { ...(join?.booth === key ? join : { booth: key, busy: false }), party: Math.min(max, Math.max(1, (join?.booth === key ? join.party : 1) + Number(button.dataset.waitingParty))) };
      form.outerHTML = partyForm(key, booths.get(key), form.dataset.viaQr === '1');
      bindForm(root);
    }));
    form.addEventListener('submit', event => { event.preventDefault(); submitJoin(key, form.dataset.viaQr === '1', root); });
  }
  async function submitJoin(key, viaQr, root) {
    if (join?.busy) return;
    join = { ...(join?.booth === key ? join : { booth: key, party: 1 }), busy: true };
    const button = root.querySelector('[data-waiting-join-form] button[type=submit]');
    if (button) { button.disabled = true; button.lastChild.textContent = ' 등록하는 중...'; }
    showSpot('join', '등록하는 중...', 'info');
    const payload = { booth: key, party: join.party };
    if (viaQr) payload.qr = scannedToken(key);
    const actor = state.user?.id;
    const response = await api('join', payload);
    if (state.user?.id !== actor) return;
    join = { ...join, busy: false };
    if (!response.ok) {
      note = { at: 'join', text: response.message, tone: 'error' };
      const form = root.querySelector('[data-waiting-join-form]');
      if (form) { form.outerHTML = partyForm(key, booths.get(key), viaQr); bindForm(root); }
      return;
    }
    if (viaQr) forgetToken();
    entries.set(response.data.id, response.data);
    booths.delete(key);
    justJoined = response.data.already ? null : response.data.id;
    note = response.data.already ? { at: 'entry', text: '이미 이 부스에 웨이팅 중이에요. 지금 순서를 보여 드려요.', tone: 'info' } : null;
    document.querySelector('.waiting-sheet')?.close();
    join = null;
    mine = null; loadMine();
    open(response.data.id);
    if (!response.data.already) { if (isApple() && !standalone()) appleNotice(); else permissionNotice(); }
    ensurePush(false).then(done => { if (done) redraw('alert'); });
  }

  // /waiting/join/<booth>: the page the on-site QR opens.
  function joinView() {
    const key = state.waitingBooth || '';
    const info = booths.get(key);
    if (ready() && key && !info) queueMicrotask(() => loadBooth(key).then(() => state.route === 'waitingJoin' && render()));
    const token = scannedToken(key);
    let body;
    if (!info) body = '<p role="status">불러오는 중...</p>';
    else if (info.failed) body = `<p class="ops-alert" role="alert">${h(info.message)}</p>`;
    else if (info.mine && active(info.mine)) body = `<p class="notice">이미 이 부스에 웨이팅 중이에요.</p><button type="button" class="primary-btn full-action" data-waiting-open="${h(info.mine.id)}">${icon('clock')} 내 웨이팅 보기</button>`;
    else if (!info.enabled) body = '<p class="notice">이 부스는 지금 웨이팅을 받지 않아요.</p>';
    else if (!info.qr) body = `<p class="notice">이 부스는 지금 현장 QR 등록을 받지 않아요.</p>${info.online && info.accepting ? '<p class="web-muted">부스 정보에서 온라인으로 등록할 수 있어요.</p>' : ''}`;
    else if (!info.accepting) body = '<p class="notice">지금은 웨이팅 접수를 잠시 멈췄어요. 잠시 후 다시 찍어 주세요.</p>';
    else if (!token) body = '<p class="notice">QR 정보를 찾을 수 없어요. 부스에 있는 QR을 다시 찍어 주세요.</p>';
    else body = partyForm(key, info, true);
    return `<main class="screen waiting-screen waiting-join-screen">
      <header class="top-bar"><button class="icon-btn" data-history-back="home" aria-label="뒤로">${icon('back')}</button><h1>웨이팅 등록</h1><span class="icon-btn" aria-hidden="true"></span></header>
      <section class="waiting-join-card"><span class="waiting-join-icon">${icon('qr')}</span><p class="waiting-sheet-booth">${h(nameOf(key))}</p><p class="web-muted">현장 QR로 웨이팅을 등록해요.</p>${body}</section>
      ${bottomNav('home')}</main>`;
  }

  // /waiting/<id>: the registration result and the live place in line.
  function entryView() {
    const id = state.waitingId;
    const entry = entries.get(id);
    if (ready() && id && !entry) queueMicrotask(() => loadEntry(id).then(() => state.route === 'waiting' && render()));
    const head = `<header class="top-bar"><button class="icon-btn" data-history-back="profile" aria-label="뒤로">${icon('back')}</button><h1>내 웨이팅</h1><button type="button" class="icon-btn" data-waiting-refresh aria-label="새로고침" title="새로고침">${icon('refresh')}</button></header>`;
    let body;
    if (!entry) body = '<p role="status">불러오는 중...</p>';
    else if (entry.failed) body = `<p class="ops-alert" role="alert">${h(entry.message)}</p>`;
    else body = active(entry) ? liveTicket(entry) : endedTicket(entry);
    return `<main class="screen waiting-screen">${head}<div class="waiting-body">${body}</div>${bottomNav('profile')}</main>`;
  }
  function liveTicket(entry) {
    const called = entry.status === 'called';
    const title = called ? '입장할 차례예요' : justJoined === entry.id ? '웨이팅 등록 완료' : '웨이팅 중';
    const deadline = called && entry.noshowAt ? new Date(entry.noshowAt) : null;
    return `<section class="waiting-ticket${called ? ' is-called' : ''}">
        <span class="waiting-check" aria-hidden="true">${icon(called ? 'bellRing' : 'check')}</span>
        <h1>${title}</h1><p class="waiting-ticket-booth">${h(entry.boothName)}</p>
        <div class="waiting-number"><small>대기번호</small><strong>${entry.number}</strong><span>번</span></div>
        <dl class="waiting-stats is-three">
          <div><dt>현재 대기순번</dt><dd>${entry.position}<small>번째</small></dd></div>
          <div><dt>현재 대기</dt><dd>${entry.total}<small>팀</small></dd></div>
          <div><dt>예상 대기시간</dt><dd>${h(called ? '지금 입장' : waitText(entry))}</dd></div>
        </dl>
        <p class="waiting-meta">${entry.party}명 · ${h(sourceName[entry.source] || '')} · ${h(time(entry.createdAt))} 등록</p>
        ${called ? `<p class="waiting-called-note" role="alert">지금 부스로 와 주세요.${deadline ? ` <span data-waiting-deadline="${h(entry.noshowAt)}">${h(deadlineText(deadline))}</span>` : ''}</p>` : ''}
      </section>
      ${spotMarkup(note, 'entry')}
      ${alertCard()}
      ${postponeCard(entry)}
      <div class="waiting-actions">
        <button type="button" class="ghost-btn full-action" data-waiting-booth-open="${h(entry.booth)}">${icon('map')} 부스 정보 보기</button>
        <button type="button" class="ghost-btn danger full-action" data-waiting-cancel="${h(entry.id)}">웨이팅 취소</button>
      </div>`;
  }
  function deadlineText(deadline) {
    const left = Math.max(0, Math.ceil((deadline.getTime() - Date.now()) / 1000));
    return left ? `${Math.floor(left / 60)}분 ${String(left % 60).padStart(2, '0')}초 안에 오지 않으면 웨이팅이 취소돼요.` : '곧 노쇼로 처리돼요.';
  }
  function endedTicket(entry) {
    const by = entry.endedBy;
    const [symbol, title, text] = entry.status === 'entered' ? ['check', '입장 완료', '즐거운 시간 보내세요!']
      : entry.status === 'noshow' ? ['notice', '노쇼로 처리됐어요', by === 'auto' ? '호출 후 정해진 시간 안에 오지 않아 웨이팅이 자동으로 취소됐어요.' : '호출에 응답이 없어 부스에서 노쇼로 처리했어요.']
      : by === 'manager' ? ['notice', '부스에서 웨이팅을 취소했어요', '']
      : ['close', '웨이팅을 취소했어요', ''];
    return `<section class="waiting-ticket is-ended">
        <span class="waiting-check" aria-hidden="true">${icon(symbol)}</span><h1>${title}</h1><p class="waiting-ticket-booth">${h(entry.boothName)}</p>
        <p class="waiting-meta">대기번호 ${entry.number}번 · ${entry.party}명 · ${h(time(entry.createdAt))} 등록${entry.finishedAt ? ` · ${h(time(entry.finishedAt))} 종료` : ''}</p>
        ${text ? `<p class="waiting-ended-text">${h(text)}</p>` : ''}
        ${entry.status === 'cancelled' && by === 'manager' ? `<div class="waiting-reason"><strong>취소 사유</strong><p>${h(entry.cancelReason || '사유가 남지 않았어요.')}</p></div>
          <p class="waiting-ended-text">궁금한 점은 부스 담당자에게 물어봐 주세요. 다시 기다리려면 부스 정보에서 웨이팅을 새로 등록해 주세요.</p>` : ''}
      </section>
      <div class="waiting-actions"><button type="button" class="primary-btn full-action" data-waiting-booth-open="${h(entry.booth)}">${icon('map')} 부스 정보 보기</button></div>`;
  }

  // 순서 미루기: within 3 teams of the front; the booth picks "by teams" or "to the back" and the limit.
  function postponeCard(entry) {
    if (entry.status !== 'waiting') return '';
    const rule = entry.postpone || {};
    if (!rule.allowed) {
      const why = rule.left === 0 ? '이 부스에서 정한 미루기 횟수를 모두 썼어요.' : entry.ahead > 3 ? '앞에 3팀 이내로 남으면 입장 순서를 미룰 수 있어요.' : '';
      return why ? `<p class="waiting-postpone-hint">${icon('clock')} ${why}</p>` : '';
    }
    const most = rule.mode === 'last' ? entry.behind : Math.min(rule.maxTeams || 1, entry.behind);
    const teams = rule.mode === 'last' ? entry.behind : Math.min(most, Math.max(1, postpone?.id === entry.id ? postpone.teams : 1));
    const to = entry.position + teams;
    return `<section class="waiting-postpone" data-waiting-postpone="${h(entry.id)}"><h2>입장 순서 미루기</h2>
      <p class="web-muted">아직 준비가 안 됐다면 뒤 팀에게 먼저 순서를 넘길 수 있어요. ${rule.left == null ? '횟수 제한은 없어요.' : `남은 미루기 ${rule.left}번`}</p>
      ${rule.mode === 'last' ? '' : `<div class="waiting-postpone-options" role="radiogroup" aria-label="미룰 팀 수">${Array.from({ length: most }, (_, i) => i + 1).map(n => `<label><input type="radio" name="postponeTeams" value="${n}" ${n === teams ? 'checked' : ''}><span>${n}팀</span></label>`).join('')}</div>`}
      <p class="waiting-postpone-preview" data-postpone-preview><strong>${entry.position}번째</strong> ${icon('arrow')} <strong>${to}번째</strong>${rule.mode === 'last' ? ' (맨 뒤)' : ''}로 미뤄져요.</p>
      ${spotMarkup(note, 'postpone')}
      <button type="button" class="ghost-btn full-action" data-waiting-postpone-go>${icon('clock')} 순서 미루기</button></section>`;
  }

  // Home and 내 정보 ---------------------------------------------------------------------------------------
  function homeBanner() {
    if (!ready()) return '';
    if (!mine) { queueMicrotask(() => loadMine().then(() => redraw('banner'))); return '<div data-waiting-banner hidden></div>'; }
    const live = mine.filter(active);
    if (!live.length) return '<div data-waiting-banner hidden></div>';
    const first = live.find(e => e.status === 'called') || live.slice().sort((a, b) => a.ahead - b.ahead)[0];
    const called = first.status === 'called';
    return `<button type="button" class="waiting-banner${called ? ' is-called' : ''}" data-waiting-banner data-waiting-open="${h(first.id)}">
      ${icon(called ? 'bellRing' : 'clock')}<span><strong>${h(first.boothName)} 웨이팅</strong>
      <small>${called ? '입장할 차례예요 · 부스로 와 주세요' : `대기번호 ${first.number}번 · ${first.position}번째 · 예상 ${h(waitText(first))}`}</small></span>
      ${live.length > 1 ? `<em>+${live.length - 1}</em>` : ''}${icon('arrow')}</button>`;
  }
  function profileList() {
    if (!ready()) return '';
    if (!mine) { queueMicrotask(() => loadMine().then(() => redraw('list'))); return '<section class="festival-profile-waiting" data-waiting-list><div class="section-heading"><h2>내 웨이팅</h2></div><p class="web-muted">불러오는 중...</p></section>'; }
    const status = e => e.status === 'called' ? '입장할 차례' : e.status === 'waiting' ? `${e.position}번째 · 예상 ${waitText(e)}`
      : e.status === 'entered' ? '입장 완료' : e.status === 'noshow' ? '노쇼 처리' : e.endedBy === 'manager' ? '부스에서 취소' : '취소함';
    return `<section class="festival-profile-waiting" data-waiting-list><div class="section-heading"><h2>내 웨이팅</h2><span>${mine.filter(active).length}곳 대기 중</span></div>
      ${mine.length ? `<ul class="waiting-list">${mine.map(e => `<li><button type="button" class="${active(e) ? 'is-active' : ''}" data-waiting-open="${h(e.id)}">
        <span class="waiting-list-number">${e.number}</span><span><strong>${h(e.boothName)}</strong><small>${h(status(e))}</small></span>${icon('arrow')}</button></li>`).join('')}</ul>`
        : `<p class="web-muted">${mineFailure ? h(mineFailure) : '웨이팅 중인 부스가 없어요. 부스 정보에서 웨이팅을 등록할 수 있어요.'}</p>`}</section>`;
  }

  // Redraws just the waiting part of a page, so a review being typed on the booth page stays.
  function redraw(part) {
    if (part === 'booth' && state.route === 'detail') {
      const box = document.querySelector('[data-waiting-booth]');
      const booth = selected();
      if (box && booth) { box.outerHTML = boothSection(booth); bind(); }
    } else if (part === 'banner' && state.route === 'home') {
      const box = document.querySelector('[data-waiting-banner]');
      if (box) { box.outerHTML = homeBanner(); bind(); }
    } else if (part === 'list' && state.route === 'profile') {
      const box = document.querySelector('[data-waiting-list]');
      if (box) { box.outerHTML = profileList(); bind(); }
    } else if (part === 'alert') {
      const box = document.querySelector('[data-waiting-alert]');
      if (box) { box.outerHTML = alertCard(); bind(); }
    }
  }

  async function poll() {
    if (!ready() || document.hidden) return;
    const route = state.route;
    if (route === 'waiting' && state.waitingId) {
      const before = entries.get(state.waitingId);
      await loadMine();
      if (!mine?.some(e => e.id === state.waitingId)) await loadEntry(state.waitingId);
      if (state.route === 'waiting' && JSON.stringify(before) !== JSON.stringify(entries.get(state.waitingId))) render();
    } else if (route === 'detail') {
      const booth = selected();
      if (booth && keyOf(booth)) { await loadBooth(keyOf(booth)); redraw('booth'); }
      if (mine?.some(active)) await loadMine();
    } else if (['home', 'profile'].includes(route)) {
      if (mine?.some(active) || route === 'profile') { await loadMine(); redraw(route === 'home' ? 'banner' : 'list'); }
    } else if (mine?.some(active)) await loadMine();
  }
  function tickDeadline() {
    document.querySelectorAll('[data-waiting-deadline]').forEach(node => { node.textContent = deadlineText(new Date(node.dataset.waitingDeadline)); });
  }

  async function cancel(id) {
    const entry = entries.get(id);
    if (!entry || !confirm(`'${entry.boothName}' 웨이팅을 취소할까요? 취소하면 순서가 사라져요.`)) return;
    showSpot('entry', '취소하는 중...', 'info');
    const response = await api('cancel', { id });
    if (!response.ok) { note = { at: 'entry', text: response.message, tone: 'error' }; render(); return; }
    entries.set(id, response.data); mine = null; booths.delete(entry.booth); note = null; justJoined = null;
    loadMine(); render();
  }
  async function postponeNow(id) {
    const entry = entries.get(id);
    if (!entry?.postpone?.allowed) return;
    const rule = entry.postpone;
    const teams = rule.mode === 'last' ? entry.behind : Math.min(Math.min(rule.maxTeams || 1, entry.behind), Math.max(1, postpone?.id === id ? postpone.teams : 1));
    if (!confirm(`입장 순서를 ${entry.position}번째에서 ${entry.position + teams}번째로 미룰까요?`)) return;
    showSpot('postpone', '미루는 중...', 'info');
    const response = await api('postpone', rule.mode === 'last' ? { id } : { id, teams });
    if (!response.ok) { note = { at: 'postpone', text: response.message, tone: 'error' }; await loadEntry(id); render(); return; }
    entries.set(id, response.data.entry); postpone = null; justJoined = null; mine = null; loadMine();
    note = { at: 'entry', text: `입장 순서를 ${response.data.from}번째에서 ${response.data.to}번째로 미뤘어요.`, tone: 'success' };
    render();
  }

  let lastRoute = null, workerListening = false;
  function bind() {
    if (!isServerMode() || !state.user) return;
    if (owner !== state.user.id) reset();
    if (lastRoute !== state.route) {
      if (state.route !== 'waiting') justJoined = null;
      note = null; lastRoute = state.route;
      // Opening home or 내 정보 reads the places again instead of showing the last ones.
      if (['home', 'profile'].includes(state.route) && mine) loadMine().then(() => redraw(state.route === 'home' ? 'banner' : 'list'));
    }
    if (!timer) {
      timer = setInterval(() => { poll(); }, POLL_MS);
      setInterval(tickDeadline, 1000);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
    }
    if (!workerListening && 'serviceWorker' in navigator) {
      workerListening = true;
      navigator.serviceWorker.addEventListener('message', event => {
        const data = event.data || {};
        if (data.type === 'festival-waiting-push') { poll(); return; }
        if (data.type === 'festival-waiting-open') {
          const target = window.FestivalRouter?.parse(new URL(data.url, location.origin).pathname);
          if (target?.route === 'waiting') { entries.delete(target.waitingId); open(target.waitingId); }
        }
      });
    }
    document.querySelectorAll('[data-waiting-open]').forEach(b => { b.onclick = () => open(b.dataset.waitingOpen); });
    document.querySelectorAll('[data-waiting-join]').forEach(b => { b.onclick = () => openSheet(b.dataset.waitingJoin); });
    document.querySelectorAll('[data-waiting-push]').forEach(b => { b.onclick = async () => {
      pushBusy = true; pushNote = ''; redraw('alert');
      const done = await ensurePush(true);
      pushBusy = false;
      if (!done) pushNote = permission() === 'denied' ? '' : '알림을 켜지 못했어요. 잠시 후 다시 눌러 주세요.';
      redraw('alert');
    }; });
    document.querySelectorAll('[data-waiting-cancel]').forEach(b => { b.onclick = () => cancel(b.dataset.waitingCancel); });
    document.querySelector('[data-waiting-refresh]')?.addEventListener('click', async () => { entries.delete(state.waitingId); mine = null; render(); await loadMine(); render(); });
    document.querySelectorAll('[data-waiting-booth-open]').forEach(b => { b.onclick = () => {
      const local = typeof boothForKey === 'function' ? boothForKey(b.dataset.waitingBoothOpen) : null;
      if (!local) return;
      booths.delete(b.dataset.waitingBoothOpen);
      state.selectedBoothId = local.id;
      navigateTo('detail');
    }; });
    const box = document.querySelector('[data-waiting-postpone]');
    if (box) {
      box.querySelectorAll('[name=postponeTeams]').forEach(r => r.addEventListener('change', () => {
        postpone = { id: box.dataset.waitingPostpone, teams: Number(r.value) };
        const entry = entries.get(postpone.id);
        const preview = box.querySelector('[data-postpone-preview]');
        if (entry && preview) preview.innerHTML = `<strong>${entry.position}번째</strong> ${icon('arrow')} <strong>${entry.position + postpone.teams}번째</strong>로 미뤄져요.`;
      }));
      box.querySelector('[data-waiting-postpone-go]')?.addEventListener('click', () => postponeNow(box.dataset.waitingPostpone));
    }
    if (state.route === 'waitingJoin') bindForm(document.querySelector('.waiting-join-screen') || document);
  }

  return { readQrFromUrl, boothSection, joinView, entryView, homeBanner, profileList, bind, reset, signOut, ensurePush, alertCard };
})();
