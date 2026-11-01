/* 관리 마법사 → 미니게임 관리 (1.41). Operators only; every action is re-checked on the server.
   주식 follows the admin menu of ORBIT develop (관리자 → 주식: 시장·종목, 호재·악재, 뉴스·공지, 감사 로그, and the
   종목 price editor of its 설정 tab) and calls ORBIT's own admin functions (orbit_admin_stock_dashboard/mutate/
   audit_log, orbit_admin_publish_stock_price), which allow public.users.admin, the same flag as festival operators.
   블랙잭 has no develop counterpart: festival_blackjack_admin shows the tables and sets the card limits.
   Results are shown next to the control that was used (spotMarkup/showSpot). */
const festivalGamesAdmin = (() => {
  let owner = null, section = 'stock', stockTab = 'control';
  let dash = null, logs = null, blackjack = null, loading = false, failure = '', busy = false, note = null;
  // A write whose result never arrived (network). It is sent again with the same key to learn the result.
  let pending = null;
  const h = value => escapeHtml(String(value ?? ''));
  const call = (name, args) => festivalAccount?.games?.call(name, args) ?? Promise.resolve({ ok: false, code: 'NETWORK_ERROR' });
  const time = value => value ? new Date(value).toLocaleString('ko-KR') : '-';
  const point = value => `${Math.round(Number(value) || 0).toLocaleString('ko-KR')}P`;
  // datetime-local values are Korean wall-clock time.
  const kstInput = date => new Date(date.getTime() + 9 * 3600000).toISOString().slice(0, 16);
  const fromKst = value => { const at = new Date(`${String(value).slice(0, 16)}:00+09:00`); return Number.isNaN(at.valueOf()) ? '' : at.toISOString(); };
  const MARKET = { open: '개장', paused: '일시정지', closed: '폐장' };
  const EVENT_STATE = { draft: '준비 중', open: '진행 중', paused: '일시정지', closed: '종료' };
  const INSTRUMENT = { open: '거래 가능', halted: '거래 정지', closed: '거래 종료' };
  const AUDIT = { MARKET_SET: '시장 상태 변경', INSTRUMENT_SET: '종목 거래 상태 변경', CREATE_EVENT: '호재·악재 등록', CREATE_NEWS: '뉴스·공지 등록' };
  const VIEWS = [['control', '시장·종목'], ['event', '호재·악재'], ['news', '뉴스·공지'], ['audit', '감사 기록']];
  const MESSAGES = {
    FORBIDDEN: '관리자 권한이 필요해요.', ADMIN_REQUIRED: '관리자 권한이 필요해요.', UNREGISTERED_USER: '관리자 권한이 필요해요.',
    AUTH_REQUIRED: '다시 로그인해 주세요.', GOOGLE_AUTH_REQUIRED: '다시 로그인해 주세요.', UNAUTHENTICATED: '다시 로그인해 주세요.',
    PROFILE_REQUIRED: '가입 단계를 먼저 마쳐 주세요.',
    MARKET_NOT_CONFIGURED: '주식시장 행사와 종목 설정을 먼저 확인해 주세요.', STOCK_SCOPE_PENDING: '주식시장 행사와 종목 설정을 먼저 확인해 주세요.',
    STOCK_MAPPING_PENDING: '부스와 연결되지 않은 종목이 있어요.', EMPTY_MARKET: '등록된 종목이 없어요.',
    STOCK_SECURITY_PENDING: '주식 권한 봉인이 아직 끝나지 않았어요.', PRICE_CONFIG_PENDING: '가격 설정이 승인되지 않았어요.',
    MARKET_CLOSED: '행사가 열려 있지 않거나 행사 시간이 아니에요.', PRICE_STALE: '종목 가격이 오래됐어요. 가격을 새로 발행한 뒤 다시 시도해 주세요.',
    INVALID_STOCK_PRICE: '가격이 허용 범위를 벗어났어요.', STOCK_NOT_FOUND: '종목을 찾지 못했어요. 새로고침해 주세요.',
    IDEMPOTENCY_CONFLICT: '같은 요청 번호로 다른 내용이 처리됐어요. 새로고침해 주세요.', INVALID_INPUT: '입력 내용을 확인해 주세요.',
    SERVER_NOT_READY: '서버 기능을 준비하고 있어요. 잠시 후 다시 시도해 주세요.',
    NETWORK_ERROR: '연결이 불안정해 결과를 확인하지 못했어요.',
  };
  const message = code => MESSAGES[code] || `처리하지 못했어요. (${code || '알 수 없음'})`;

  function reset() {
    owner = state.user?.id || null; section = 'stock'; stockTab = 'control';
    dash = null; logs = null; blackjack = null; failure = ''; busy = false; note = null; pending = null;
  }
  const slot = at => spotMarkup(note, at);
  function say(at, text, tone = 'success', redraw = tone !== 'error') {
    note = text ? { at, text, tone } : null;
    if (redraw || !showSpot(at, text, tone)) { render(); showSpot(at, text, tone); }
  }

  async function load() {
    if (loading) return;
    loading = true; failure = '';
    const actor = state.user?.id, which = section;
    const response = which === 'blackjack' ? await call('festival_blackjack_admin', { p_action: 'status', p_payload: {} })
      : stockTab === 'audit' ? await call('orbit_admin_stock_audit_log') : await call('orbit_admin_stock_dashboard');
    loading = false;
    if (state.user?.id !== actor) return;
    if (!response.ok) failure = message(response.code);
    else if (which === 'blackjack') blackjack = response.data;
    else if (stockTab === 'audit') logs = Array.isArray(response.data) ? response.data : [];
    else dash = response.data;
    render();
  }
  const needsLoad = () => section === 'blackjack' ? !blackjack : stockTab === 'audit' ? !logs : !dash;

  // Stock writes carry a fresh request key; a lost answer is asked again with the same key.
  async function send(request, at) {
    if (busy) return false;
    busy = true; note = null;
    const buttons = [...document.querySelectorAll('[data-games-admin] button, [data-games-admin] select')].filter(b => !b.disabled);
    buttons.forEach(b => { b.disabled = true; });
    showSpot(at, '처리 중...', 'info');
    const actor = state.user?.id;
    const response = await call(request.name, request.args);
    busy = false;
    buttons.forEach(b => { b.disabled = false; });
    if (state.user?.id !== actor) return false;
    if (!response.ok && response.code === 'NETWORK_ERROR' && request.args.p_idempotency_key) {
      pending = { ...request, at };
      say(at, '결과를 확인하지 못했어요. 위의 "이전 요청 결과 확인"을 눌러 주세요.', 'error', true);
      return false;
    }
    pending = null;
    const result = response.data;
    const code = !response.ok ? response.code : request.name === 'orbit_admin_stock_mutate' && !result?.ok ? result?.reason : null;
    if (code) { say(at, message(code), 'error', true); return false; }
    if (section === 'blackjack') blackjack = result; else { dash = null; logs = null; }
    if (section !== 'blackjack') { await load(); }
    say(at, result?.replayed ? '이전 요청이 처리된 것을 확인했어요.' : request.success);
    return true;
  }
  const mutate = (action, payload, success, at) => send({ name: 'orbit_admin_stock_mutate', success,
    args: { p_action: action, p_idempotency_key: crypto.randomUUID(), p_payload: payload } }, at);

  const tile = (label, value) => `<div><span>${h(label)}</span><strong>${h(value)}</strong></div>`;
  const badge = (tone, text) => `<span class="status-badge ${tone}"><i aria-hidden="true"></i>${h(text)}</span>`;

  function stockSummary() {
    const market = dash?.market, items = dash?.instruments || [], now = Date.now();
    return `<div class="games-admin-tiles">
        ${tile('시장 상태', market ? MARKET[market.status] || market.status : '행사 설정 없음')}
        ${tile('거래 가능 종목', `${items.filter(s => s.status === 'open').length} / ${items.length}`)}
        ${tile('진행 중 호재·악재', (dash?.events || []).filter(e => Date.parse(e.startsAt) <= now && Date.parse(e.endsAt) > now).length)}
        ${tile('긴급 뉴스', (dash?.news || []).filter(n => n.priority === 'URGENT').length)}
      </div>
      ${market ? `<p class="games-admin-ready">${badge(market.securityReady ? 'success' : 'warning', `권한 봉인 ${market.securityReady ? '완료' : '필요'}`)}
        ${badge(market.configApproved ? 'success' : 'warning', `가격 설정 ${market.configApproved ? '승인됨' : '승인 필요'}`)}
        <span>행사 ${h(EVENT_STATE[market.eventStatus] || market.eventStatus)} · ${h(time(market.startsAt))} ~ ${h(time(market.endsAt))} · 가격 버전 ${Number(market.priceVersion) || 0}</span></p>`
      : '<p class="games-admin-hint">승인된 행사·가격 설정과 초기 가격 발행이 준비되어야 시장을 열 수 있어요.</p>'}`;
  }

  function controlView() {
    const market = dash?.market, items = dash?.instruments || [], off = busy || !!pending;
    return `<section class="ops-section"><h2>시장 거래 제어</h2>
        <div class="games-admin-actions">
          <button type="button" class="primary-btn" data-market="open" ${off || !market || market.status === 'open' ? 'disabled' : ''}>거래 재개</button>
          <button type="button" class="danger-btn" data-market="paused" ${off || !market || market.status === 'paused' ? 'disabled' : ''}>긴급 일시정지</button>
          <button type="button" class="danger-btn" data-market="closed" ${off || !market || market.status === 'closed' ? 'disabled' : ''}>시장 폐장</button>
        </div>${slot('market')}</section>
      <section class="ops-section"><h2>종목별 거래 상태와 가격 <span>${items.length}개</span></h2>
        ${items.length ? `<ul class="games-admin-list">${items.map(s => `<li>
          <div class="games-admin-row"><div><strong>${h(s.stockName)}</strong><small>${point(s.price)} · ${h(INSTRUMENT[s.status] || s.status)}</small></div>
            <button type="button" class="${s.status === 'open' ? 'danger-btn' : 'ghost-btn'}" data-instrument="${h(s.stockId)}" data-status="${s.status === 'open' ? 'halted' : 'open'}" ${off ? 'disabled' : ''}>${s.status === 'open' ? '거래 정지' : '거래 재개'}</button></div>
          <details class="sun-details" ${note?.at === `price:${s.stockId}` ? 'open' : ''}><summary>가격 변경</summary>
            <form class="ops-form games-admin-inline" data-price="${h(s.stockId)}">
              <label>새 가격 (P)<input class="input" name="price" type="number" inputmode="numeric" required min="1" max="10000000" step="1" value="${Number(s.price) || ''}"></label>
              <button class="ghost-btn" type="submit" ${off ? 'disabled' : ''}>${icon('save')} 가격 발행</button></form>
            <p class="games-admin-hint">모든 종목의 가격 버전이 새로 발행되고, 이 종목만 새 가격으로 바뀌어요.</p>
          </details>${slot(`stock:${s.stockId}`)}${slot(`price:${s.stockId}`)}</li>`).join('')}</ul>` : '<p class="ops-empty">등록된 종목이 없어요.</p>'}
      </section>`;
  }

  // 적용 대상·종목·영향도·시작·종료, shared by 호재·악재 and a 뉴스 with a linked effect.
  function effectFields(hidden = false) {
    const now = new Date();
    return `<div class="games-admin-effect" data-effect ${hidden ? 'hidden' : ''}>
      <label>적용 대상<select class="select" name="targetScope"><option value="GLOBAL">전체 종목</option><option value="STOCK">특정 종목</option></select></label>
      <label data-stock-field hidden>종목<select class="select" name="stockId"><option value="">선택하세요</option>${(dash?.instruments || []).map(s => `<option value="${h(s.stockId)}">${h(s.stockName)}</option>`).join('')}</select></label>
      <label>영향도 (1–100)<input class="input" name="impact" type="number" min="1" max="100" step="1" value="10" required></label>
      <label>시작 시간<input class="input" name="startsAt" type="datetime-local" value="${kstInput(now)}" required></label>
      <label>종료 시간<input class="input" name="endsAt" type="datetime-local" value="${kstInput(new Date(now.getTime() + 3600000))}" required></label>
    </div>`;
  }
  const scopeLine = item => item.targetScope === 'STOCK' ? item.stockName || '특정 종목' : '전체 종목';

  function eventView() {
    const items = dash?.events || [];
    return `<section class="ops-section"><h2>호재·악재 등록</h2><p class="games-admin-hint">호재·악재 정보를 기록해요. 영향도는 기록용이며 주가를 자동으로 바꾸지 않아요.</p>
        <form class="ops-form" data-stock-event>
          <label>이벤트 종류<select class="select" name="eventType"><option value="GOOD">호재</option><option value="BAD">악재</option></select></label>
          ${effectFields()}
          <label>제목<input class="input" name="title" required maxlength="120" autocomplete="off"></label>
          <label>설명<textarea class="input" name="description" required maxlength="2000" rows="3"></textarea></label>
          ${slot('event')}<button class="primary-btn" type="submit" ${busy || pending ? 'disabled' : ''}>${icon('plus')} 이벤트 등록</button>
        </form></section>
      <section class="ops-section"><h2>등록된 이벤트 <span>${items.length}건</span></h2>
        ${items.length ? `<ul class="games-admin-list">${items.map(e => `<li>
          <p class="games-admin-meta">${badge(e.eventType === 'GOOD' ? 'success' : 'warning', `${e.eventType === 'GOOD' ? '호재' : '악재'} · 영향도 ${Number(e.impact)}`)}<small>${h(time(e.createdAt))}</small></p>
          <strong>${h(e.title)}</strong><p>${h(e.description)}</p><small>${h(scopeLine(e))} · ${h(time(e.startsAt))} ~ ${h(time(e.endsAt))}</small></li>`).join('')}</ul>` : '<p class="ops-empty">등록된 이벤트가 없어요.</p>'}
      </section>`;
  }

  function newsView() {
    const items = dash?.news || [];
    return `<section class="ops-section"><h2>뉴스·공지 등록</h2><p class="games-admin-hint">학생의 가상주식 화면 뉴스에 바로 보여요.</p>
        <form class="ops-form" data-stock-news>
          <div class="games-admin-grid">
            <label>유형<select class="select" name="kind"><option value="NEWS">뉴스</option><option value="ANNOUNCEMENT">공지</option></select></label>
            <label>우선순위<select class="select" name="priority"><option value="NORMAL">일반</option><option value="URGENT">긴급</option></select></label>
            <label>연결 이벤트<select class="select" name="effectType"><option value="NONE">없음</option><option value="GOOD">호재</option><option value="BAD">악재</option></select></label>
          </div>
          ${effectFields(true)}
          <label>제목<input class="input" name="title" required maxlength="160" autocomplete="off"></label>
          <label>내용<textarea class="input" name="content" required maxlength="4000" rows="4"></textarea></label>
          ${slot('news')}<button class="primary-btn" type="submit" ${busy || pending ? 'disabled' : ''}>${icon('plus')} 뉴스 등록</button>
        </form></section>
      <section class="ops-section"><h2>누적 뉴스 기록 <span>${items.length}건</span></h2>
        ${items.length ? `<ul class="games-admin-list">${items.map(n => `<li>
          <p class="games-admin-meta">${badge(n.priority === 'URGENT' ? 'danger' : 'muted', n.priority === 'URGENT' ? '긴급' : n.kind === 'ANNOUNCEMENT' ? '공지' : '뉴스')}
            ${n.effectType && n.effectType !== 'NONE' ? badge(n.effectType === 'GOOD' ? 'success' : 'warning', `${n.effectType === 'GOOD' ? '호재' : '악재'} · 영향도 ${Number(n.impact)}`) : ''}<small>${h(time(n.createdAt))}</small></p>
          <strong>${h(n.title)}</strong><p>${h(n.content)}</p>
          ${n.effectType && n.effectType !== 'NONE' ? `<small>${h(scopeLine(n))} · ${h(time(n.startsAt))} ~ ${h(time(n.endsAt))}</small>` : ''}</li>`).join('')}</ul>` : '<p class="ops-empty">등록된 뉴스가 없어요.</p>'}
      </section>`;
  }

  function auditView() {
    return `<section class="ops-section"><h2>주식 운영 감사 기록</h2><p class="games-admin-hint">최근 100건이에요. 거부된 요청도 이유와 함께 남아요.</p>
      ${logs.length ? `<ul class="games-admin-list">${logs.map(l => `<li>
        <p class="games-admin-meta"><strong>${h(AUDIT[l.action] || l.action)}</strong>${badge(l.result === 'SUCCESS' ? 'success' : 'warning', l.result === 'SUCCESS' ? '성공' : '거부됨')}</p>
        <small>대상 ${h(l.target)} · 관리자 번호 ${h(l.actorId)} · ${h(time(l.createdAt))}${l.failureReason ? ` · ${h(message(l.failureReason))}` : ''}</small></li>`).join('')}</ul>` : '<p class="ops-empty">운영 기록이 없어요.</p>'}</section>`;
  }

  function stockView() {
    const body = stockTab === 'audit' ? (logs ? auditView() : '') : !dash ? '' : stockTab === 'event' ? eventView() : stockTab === 'news' ? newsView() : controlView();
    return `${dash ? stockSummary() : ''}
      <nav class="games-admin-views" aria-label="주식 관리 메뉴">${VIEWS.map(([id, label]) => `<button type="button" data-games-view="${id}" aria-pressed="${stockTab === id}">${label}</button>`).join('')}</nav>
      ${pending ? `<div class="games-admin-pending" role="status"><p>결과를 확인하지 못한 이전 요청이 있어요. 새 작업 전에 결과를 확인해 주세요.</p>
        <button type="button" class="primary-btn" data-games-pending ${busy ? 'disabled' : ''}>${icon('refresh')} 이전 요청 결과 확인</button></div>` : ''}
      ${body}`;
  }

  const OUTCOME = { a: '앞 사람 승', b: '뒤 사람 승', draw: '무승부' };
  function gameState(g) {
    if (g.status === 'waiting') return badge('warning', '상대 찾는 중');
    if (g.status === 'playing') return badge('success', '진행 중');
    if (g.status === 'cancelled') return badge('muted', '취소');
    return badge('muted', OUTCOME[g.result] || '끝남');
  }
  function blackjackView() {
    const b = blackjack, s = b.settings || {};
    const per = Number(s.maxPerHit) || 1, draws = Number.isInteger(s.maxDraws) ? s.maxDraws : null;
    const options = (from, to, value) => Array.from({ length: to - from + 1 }, (_, i) => from + i).map(n => `<option value="${n}" ${n === value ? 'selected' : ''}>${n}장</option>`).join('');
    return `<div class="games-admin-tiles">
        ${tile('매칭 대기', `${Number(b.waiting) || 0}명`)}${tile('진행 중', `${Number(b.playing) || 0}판`)}
        ${tile('오늘 끝난 판', `${Number(b.finishedToday) || 0}판`)}${tile('오늘 오간 판돈', point(b.stakedToday))}
      </div>
      <section class="ops-section"><h2>카드 제한</h2>
        <p class="games-admin-hint">진행 중인 판에도 바로 적용돼요. 21이나 버스트여도 자동으로 멈추지 않으니(1.40), 한 판에 받을 수 있는 카드 수로 판이 너무 길어지지 않게 할 수 있어요.</p>
        <form class="ops-form" data-bj-limits>
          <div class="games-admin-grid">
            <label>히트 한 번에 받을 수 있는 카드<select class="select" name="maxPerHit">${options(1, 5, per)}</select></label>
            <label>한 판에 더 받을 수 있는 카드 (처음 2장 제외)<select class="select" name="maxDraws"><option value="" ${draws === null ? 'selected' : ''}>제한 없음</option>${options(1, 20, draws)}</select></label>
          </div>
          <p class="games-admin-hint">지금: 한 번에 ${per}장 · 한 판에 ${draws === null ? '제한 없음' : `${draws}장`}${s.updatedBy ? ` · ${h(s.updatedBy)}, ${h(time(s.updatedAt))}` : ''}</p>
          ${slot('limits')}<button class="primary-btn" type="submit" ${busy ? 'disabled' : ''}>${icon('save')} 저장</button>
        </form></section>
      <section class="ops-section"><h2>최근 판 <span>${(b.recent || []).length}판</span></h2>
        ${(b.recent || []).length ? `<ul class="games-admin-list">${b.recent.map(g => `<li>
          <p class="games-admin-meta">${gameState(g)}<small>${h(time(g.createdAt))} · 판돈 ${point(g.stake)}</small></p>
          <strong>${h(g.playerA || '-')} <span class="games-admin-vs">vs</span> ${h(g.playerB || '상대 없음')}</strong>
          ${g.status === 'waiting' ? '' : `<small>카드 ${Number(g.cardsA) || 0}장${g.totalA !== null && g.totalA !== undefined ? ` · ${Number(g.totalA)}점` : ''} / ${Number(g.cardsB) || 0}장${g.totalB !== null && g.totalB !== undefined ? ` · ${Number(g.totalB)}점` : ''}</small>`}</li>`).join('')}</ul>` : '<p class="ops-empty">아직 판이 없어요.</p>'}
      </section>`;
  }

  function view() {
    if (owner !== (state.user?.id || null)) reset();
    const intro = `<h1>미니게임 관리</h1>
      <div class="games-admin-switch" role="group" aria-label="미니게임">${[['stock', '가상주식'], ['blackjack', '1대1 블랙잭']].map(([id, label]) => `<button type="button" data-games-section="${id}" aria-pressed="${section === id}">${label}</button>`).join('')}
        <button type="button" class="icon-btn" data-games-refresh aria-label="새로고침" title="새로고침">${icon('refresh')}</button></div>`;
    if (!isServerMode()) return `<div class="ops-body" data-games-admin>${intro}<p class="ops-empty">미니게임 관리는 실제 로그인에서 사용할 수 있어요.</p></div>`;
    if (failure) return `<div class="ops-body" data-games-admin>${intro}<p class="ops-alert" role="alert">${h(failure)}</p><button type="button" class="ghost-btn" data-games-retry>${icon('refresh')} 다시 불러오기</button></div>`;
    if (needsLoad()) return `<div class="ops-body" data-games-admin aria-busy="true">${intro}<p role="status">불러오는 중...</p></div>`;
    return `<div class="ops-body" data-games-admin>${intro}${section === 'blackjack' ? blackjackView() : stockView()}</div>`;
  }

  // Shows 종목 only for 특정 종목, and the effect fields only for a news item with a linked event.
  function syncEffect(form) {
    const effect = form.querySelector('[data-effect]');
    if (!effect) return;
    const news = form.elements.effectType;
    effect.hidden = !!news && news.value === 'NONE';
    effect.querySelectorAll('input, select').forEach(input => { input.disabled = effect.hidden; });
    const stock = effect.querySelector('[data-stock-field]');
    stock.hidden = form.elements.targetScope.value !== 'STOCK';
    form.elements.stockId.required = !stock.hidden && !effect.hidden;
  }
  function effectPayload(form) {
    const f = form.elements, scope = f.targetScope.value;
    return { targetScope: scope, stockId: scope === 'STOCK' ? f.stockId.value : null, impact: Number(f.impact.value),
      startsAt: fromKst(f.startsAt.value), endsAt: fromKst(f.endsAt.value) };
  }
  function checkEffect(effect, at) {
    if (effect.targetScope === 'STOCK' && !effect.stockId) { say(at, '대상 종목을 선택해 주세요.', 'error'); return false; }
    if (!effect.startsAt || !effect.endsAt || Date.parse(effect.endsAt) <= Date.parse(effect.startsAt)) { say(at, '종료 시간은 시작 시간 이후여야 해요.', 'error'); return false; }
    return true;
  }
  const clean = value => value.trim();
  const plain = (value, multiline) => !(multiline ? /[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[<>\u0000-\u001f\u007f]/).test(value);

  function bind() {
    const root = document.querySelector('[data-games-admin]');
    if (!root || !isAdminUser() || !isServerMode()) return;
    if (needsLoad() && !failure && !loading) queueMicrotask(load);
    root.querySelectorAll('[data-games-section]').forEach(button => button.addEventListener('click', () => {
      if (busy || section === button.dataset.gamesSection) return;
      section = button.dataset.gamesSection; failure = ''; note = null; render();
    }));
    root.querySelectorAll('[data-games-view]').forEach(button => button.addEventListener('click', () => {
      if (busy || stockTab === button.dataset.gamesView) return;
      stockTab = button.dataset.gamesView; failure = ''; note = null;
      if (stockTab === 'audit') logs = null;
      render();
    }));
    root.querySelector('[data-games-refresh]')?.addEventListener('click', () => {
      if (busy) return;
      failure = ''; note = null;
      if (section === 'blackjack') blackjack = null; else if (stockTab === 'audit') logs = null; else dash = null;
      render();
    });
    root.querySelector('[data-games-retry]')?.addEventListener('click', () => { failure = ''; render(); });
    root.querySelector('[data-games-pending]')?.addEventListener('click', () => { if (pending) send(pending, pending.at); });

    root.querySelectorAll('[data-market]').forEach(button => button.addEventListener('click', () => {
      const status = button.dataset.market;
      const warning = status === 'open' ? '행사 시간, 승인 설정, 권한 봉인과 모든 종목의 가격 상태를 다시 검사해요.' : '모든 종목의 신규 거래가 멈춰요. 이미 끝난 거래는 그대로예요.';
      if (!confirm(`시장을 ${MARKET[status]} 상태로 바꿀까요?\n${warning}`)) return;
      mutate('MARKET_SET', { status }, `시장을 ${MARKET[status]} 상태로 바꿨어요.`, 'market');
    }));
    root.querySelectorAll('[data-instrument]').forEach(button => button.addEventListener('click', () => {
      const stock = dash?.instruments?.find(s => s.stockId === button.dataset.instrument), status = button.dataset.status;
      if (!stock) return;
      if (!confirm(`${stock.stockName} 거래를 ${status === 'open' ? '재개' : '정지'}할까요?${status === 'open' ? '' : '\n이 종목의 신규 매수·매도가 멈춰요.'}`)) return;
      mutate('INSTRUMENT_SET', { stockId: stock.stockId, status }, `${stock.stockName} 거래를 ${status === 'open' ? '재개' : '정지'}했어요.`, `stock:${stock.stockId}`);
    }));
    root.querySelectorAll('[data-price]').forEach(form => form.addEventListener('submit', event => {
      event.preventDefault();
      const stock = dash?.instruments?.find(s => s.stockId === form.dataset.price), at = `price:${form.dataset.price}`;
      const price = Number(form.elements.price.value);
      if (!stock) return;
      if (!Number.isInteger(price) || price < 1 || price > 10000000) { say(at, '가격은 1P부터 10,000,000P까지의 정수예요.', 'error'); return; }
      if (!confirm(`${stock.stockName} 가격을 ${point(stock.price)}에서 ${point(price)}로 바꿀까요?`)) return;
      send({ name: 'orbit_admin_publish_stock_price', success: `${stock.stockName} 가격을 ${point(price)}로 발행했어요.`,
        args: { p_stock_id: Number(stock.stockId), p_price: price, p_idempotency_key: crypto.randomUUID() } }, at);
    }));
    root.querySelectorAll('[data-stock-event], [data-stock-news]').forEach(form => {
      syncEffect(form);
      form.addEventListener('change', event => { if (['targetScope', 'effectType'].includes(event.target.name)) syncEffect(form); });
    });
    root.querySelector('[data-stock-event]')?.addEventListener('submit', event => {
      event.preventDefault();
      const form = event.currentTarget, f = form.elements, effect = effectPayload(form);
      const title = clean(f.title.value), description = clean(f.description.value);
      if (!title || !description || !plain(title) || !plain(description, true)) { say('event', '제목과 설명을 입력해 주세요. <, > 기호는 쓸 수 없어요.', 'error'); return; }
      if (!checkEffect(effect, 'event')) return;
      mutate('CREATE_EVENT', { eventType: f.eventType.value, ...effect, title, description }, '이벤트를 등록했어요.', 'event');
    });
    root.querySelector('[data-stock-news]')?.addEventListener('submit', event => {
      event.preventDefault();
      const form = event.currentTarget, f = form.elements, linked = f.effectType.value !== 'NONE';
      const title = clean(f.title.value), content = clean(f.content.value);
      if (!title || !content || !plain(title) || !plain(content, true)) { say('news', '제목과 내용을 입력해 주세요. <, > 기호는 쓸 수 없어요.', 'error'); return; }
      const effect = linked ? effectPayload(form) : { targetScope: null, stockId: null, impact: null, startsAt: null, endsAt: null };
      if (linked && !checkEffect(effect, 'news')) return;
      mutate('CREATE_NEWS', { kind: f.kind.value, priority: f.priority.value, effectType: f.effectType.value, ...effect, title, content }, '뉴스를 등록했어요.', 'news');
    });
    root.querySelector('[data-bj-limits]')?.addEventListener('submit', event => {
      event.preventDefault();
      const f = event.currentTarget.elements, maxPerHit = Number(f.maxPerHit.value), maxDraws = f.maxDraws.value === '' ? null : Number(f.maxDraws.value);
      if (maxDraws !== null && maxPerHit > maxDraws) { say('limits', '한 번에 받는 카드가 한 판에 받을 수 있는 카드보다 많을 수 없어요.', 'error'); return; }
      send({ name: 'festival_blackjack_admin', success: '카드 제한을 저장했어요.', args: { p_action: 'save', p_payload: { maxPerHit, maxDraws } } }, 'limits');
    });
  }

  return { view, bind };
})();
