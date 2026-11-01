/* 미니게임: the point games ported from ORBIT develop (/games). 동아리 가상주식 and 1대1 블랙잭 call ORBIT's own
   functions (orbit_stock_snapshot, orbit_trade_stock, orbit_blackjack_*) through the signed-in festival account.
   They move ORBIT virtual points (가상 포인트), which are separate from festival points, stamps and vouchers.
   The only way in is the bottom navigation tab '미니게임' (route 'games'); no other screen links here.
   Results are shown next to the button that was pressed (spotMarkup/showSpot).
   1.38: the hub shows how many players wait for a blackjack opponent (festival_blackjack_lobby), and the
   result screen shows whether the last opponent waits, accepts or declines a rematch (festival_blackjack_rematch).
   1.39: the blackjack lobby shows the same count above its button, and the final reveal animates only the card
   that was just turned over. */
const festivalGames = (() => {
  const STAKE = 300, TURN_SECONDS = 10, POLL_MS = 1000, LOBBY_MS = 5000, FLIP_MS = 700, CHART_MS = 2 * 60 * 60 * 1000;
  const h = value => escapeHtml(String(value ?? ''));
  const api = () => festivalAccount?.games;
  const point = value => `${Math.round(Number(value) || 0).toLocaleString('ko-KR')}P`;
  const signedPoint = value => `${value > 0 ? '+' : value < 0 ? '−' : ''}${point(Math.abs(value))}`;
  const signedRate = value => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(2)}%`;
  const when = value => new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const clockTime = value => new Date(value).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const MESSAGES = {
    UNREGISTERED_USER: '미니게임 계정을 찾지 못했어요. 로그아웃한 뒤 다시 로그인해 주세요.',
    UNAUTHENTICATED: '로그인이 끝났어요. 다시 로그인해 주세요.',
    ACCOUNT_DISABLED: '지금 계정으로는 가상주식을 이용할 수 없어요. 운영자에게 문의해 주세요.',
    INVALID_TRADE: '거래 수량과 종목을 다시 확인해 주세요.',
    IDEMPOTENCY_CONFLICT: '이미 보낸 거래와 내용이 달라요. 이전 거래 결과를 먼저 확인해 주세요.',
    INSUFFICIENT_HOLDINGS: '보유 주식 수량이 부족해요.',
    STOCK_NOT_FOUND: '거래할 수 있는 종목을 찾지 못했어요.',
    MARKET_CLOSED: '지금은 주식시장이 열려 있지 않아요.',
    STOCK_HALTED: '이 종목은 거래가 중지됐어요.',
    PRICE_STALE: '가격이 오래되어 거래할 수 없어요. 새로고침한 뒤 다시 시도해 주세요.',
    PRICE_CONFIG_PENDING: '주식시장을 준비하고 있어요.',
    STOCK_SECURITY_PENDING: '주식시장을 준비하고 있어요.',
    HOLDING_SCOPE_PENDING: '기존 보유 정보 확인이 필요해요. 운영자에게 문의해 주세요.',
    INVALID_PRICE_CONFIG: '종목 가격 설정을 확인하고 있어요.',
    ASSET_LIMIT: '거래 뒤 자산이 허용 범위를 넘어요.',
    NOT_WAITING: '이미 상대가 들어왔거나 기다리는 게임이 없어요.',
    GAME_NOT_FOUND: '게임을 찾지 못했어요. 화면을 새로고침해 주세요.',
    NOT_YOUR_TURN: '지금은 내 차례가 아니에요.',
    INVALID_ACTION: '지금은 할 수 없는 행동이에요.',
    REMATCH_EXPIRED: '다시 하기 시간이 지났어요. 새 상대를 찾아 주세요.',
    SERVER_NOT_READY: '미니게임을 준비하고 있어요. 잠시 후 다시 시도해 주세요.',
    NETWORK_ERROR: '연결이 불안정해요. 잠시 후 다시 시도해 주세요.',
  };
  const message = (code, context) => code === 'INSUFFICIENT_POINTS'
    ? (context === 'blackjack' ? `판돈 ${point(STAKE)}가 부족해요.` : '보유 포인트가 부족해요.')
    : MESSAGES[code] || MESSAGES.NETWORK_ERROR;
  // A trade the server answered with one of these is settled; anything else may still have run.
  const FINAL_TRADE_ERRORS = new Set(['INVALID_TRADE', 'IDEMPOTENCY_CONFLICT', 'INSUFFICIENT_POINTS', 'INSUFFICIENT_HOLDINGS',
    'STOCK_NOT_FOUND', 'MARKET_CLOSED', 'STOCK_HALTED', 'PRICE_STALE', 'PRICE_CONFIG_PENDING', 'STOCK_SECURITY_PENDING',
    'HOLDING_SCOPE_PENDING', 'INVALID_PRICE_CONFIG', 'ASSET_LIMIT', 'ACCOUNT_DISABLED']);

  let owner = null;
  let market = { status: 'idle', data: null, code: '' };
  let news = { status: 'idle', items: [] };
  let tab = 'market', query = '', sort = 'default', favorites = null, note = null;
  let chart = { key: '', status: 'idle', points: [], opening: null };
  let trade = null, tradeBusy = false;
  let bj = { status: 'idle', game: null, code: '', busy: false, reveal: null, badges: {}, announcement: '', sent: null, settled: null, key: 0 };
  let lobby = { status: 'idle', waiting: null };
  let rematch = { gameId: null, me: null, opponent: null, expired: false, busy: false, loading: false };
  let pollTimer = 0, tickTimer = 0, revealTimer = 0, lobbyTimer = 0;

  function reset() {
    lobby = { status: 'idle', waiting: null };
    rematch = { gameId: null, me: null, opponent: null, expired: false, busy: false, loading: false };
    owner = state.user?.id || null;
    market = { status: 'idle', data: null, code: '' };
    news = { status: 'idle', items: [] };
    tab = 'market'; query = ''; sort = 'default'; favorites = null; note = null;
    chart = { key: '', status: 'idle', points: [], opening: null };
    closeTrade();
    clearTimeout(revealTimer);
    bj = { status: 'idle', game: null, code: '', busy: false, reveal: null, badges: {}, announcement: '', sent: null, settled: null, key: 0 };
  }
  const isGameRoute = route => ['games', 'gamesStock', 'gamesStockDetail', 'gamesBlackjack'].includes(route);
  function report(at, text, tone = 'error', redraw = false) {
    note = text ? { at, text, tone } : null;
    if (redraw || !showSpot(at, text, tone)) { render(); if (text) showSpot(at, text, tone); }
  }
  const slot = at => spotMarkup(note, at);
  function redraw() { if (isGameRoute(state.route)) render(); }

  /* ---------- 가상주식 data (same rules as ORBIT applyStockState) ---------- */
  function marketOpen(now = Date.now()) {
    const m = market.data?.market;
    return Boolean(market.data?.active && m && m.status === 'open' && m.eventStatus === 'open' && m.securityReady
      && m.configApproved && now >= Date.parse(m.startsAt) && now < Date.parse(m.endsAt));
  }
  function stocks() {
    const data = market.data;
    if (!data) return [];
    const m = data.market, now = Date.now(), open = marketOpen(now);
    return (data.stocks || []).map(stock => {
      const holding = (data.holdings || []).find(item => item.stockId === stock.id);
      const updated = Date.parse(stock.updatedAt || '');
      const stale = !stock.updatedAt || !m?.maxPriceAgeSeconds || stock.priceVersion === 0 || stock.priceVersion !== m.priceVersion
        || now - updated > m.maxPriceAgeSeconds * 1000 || updated > now;
      const previous = stock.previousPrice || stock.price;
      return {
        id: String(stock.id), eventId: stock.eventId, name: String(stock.name || ''), price: stock.price, previous,
        change: stock.price - previous, rate: previous ? (stock.price - previous) / previous * 100 : 0,
        updatedAt: stock.updatedAt, stale, tradingStatus: stock.tradingStatus,
        quantity: holding?.quantity || 0, averageBuyPrice: holding ? holding.averageBuyPrice : 0,
        canTrade: Boolean(open && !stale && stock.tradingStatus === 'open' && stock.eventId === m?.eventId
          && (!holding || holding.eventId === m?.eventId) && stock.price >= stock.minPrice && stock.price <= stock.maxPrice),
      };
    });
  }
  const balance = () => market.data?.pointBalance ?? null;
  const userKey = () => market.data?.userId ? String(market.data.userId) : '';

  async function loadMarket({ quiet = false } = {}) {
    if (!api() || market.status === 'loading') return;
    const actor = state.user?.id;
    market.status = 'loading';
    if (!quiet) redraw();
    const response = await api().call('orbit_stock_snapshot');
    if (state.user?.id !== actor) return;
    if (response.ok && response.data && typeof response.data === 'object' && Array.isArray(response.data.stocks)) {
      market = { status: 'ready', data: response.data, code: '' };
      if (favorites === null) favorites = readFavorites();
    } else {
      market = { status: 'error', data: market.data, code: response.ok ? 'UNREGISTERED_USER' : response.code };
    }
    redraw();
  }
  async function loadNews() {
    if (!api() || news.status === 'loading' || news.status === 'ready') return;
    news.status = 'loading';
    const response = await api().news();
    news = response.ok ? { status: 'ready', items: response.data } : { status: 'error', items: [] };
    if (['gamesStock'].includes(state.route)) render();
  }
  async function loadChart(stock) {
    const m = market.data?.market;
    const start = m && Number.isFinite(Date.parse(m.startsAt)) ? Date.parse(m.startsAt) : Date.now() - CHART_MS;
    const key = `${stock.id}:${stock.eventId}:${m?.priceVersion}:${start}`;
    if (chart.key === key && chart.status !== 'error') return;
    chart = { key, status: 'loading', points: [], opening: null, start };
    const from = new Date(start).toISOString(), to = new Date(start + CHART_MS).toISOString();
    const [history, opening] = await Promise.all([
      api().priceHistory(stock.id, stock.eventId, from, to),
      start <= Date.now() && m ? api().priceAt(stock.id, stock.eventId, from) : Promise.resolve({ ok: true, price: null }),
    ]);
    if (chart.key !== key) return;
    const points = history.ok ? history.data.filter(row => Number.isInteger(row.price) && row.price > 0 && Number.isFinite(Date.parse(row.created_at)))
      .map(row => ({ time: Date.parse(row.created_at), price: row.price })).sort((a, b) => a.time - b.time) : [];
    chart = { key, start, status: history.ok ? 'ready' : 'error', points, opening: opening.ok ? opening.price ?? (start <= Date.now() ? points[0]?.price ?? null : null) : null };
    if (state.route === 'gamesStockDetail') render();
  }

  function readFavorites() {
    try {
      const saved = JSON.parse(localStorage.getItem(`pangyo-games-favorites-v1:${userKey()}`) || '[]');
      return Array.isArray(saved) ? saved.filter(id => typeof id === 'string').slice(0, 100) : [];
    } catch { return []; }
  }
  function toggleFavorite(id) {
    const list = favorites || [];
    favorites = list.includes(id) ? list.filter(item => item !== id) : [...list, id].slice(0, 100);
    try { localStorage.setItem(`pangyo-games-favorites-v1:${userKey()}`, JSON.stringify(favorites)); } catch { /* Kept for this visit. */ }
    render();
  }

  // KST countdown line for the market, as in ORBIT describeMarketSchedule.
  function schedule(now = Date.now()) {
    const m = market.data?.market;
    if (!m) return '개장 일정을 준비하고 있어요';
    const start = Date.parse(m.startsAt), end = Date.parse(m.endsAt);
    const clock = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(v => String(v).padStart(2, '0')).join(':'); };
    if (now < start) {
      const day = ms => Math.floor((ms + 9 * 3600000) / 86400000);
      const days = day(start) - day(now);
      return days > 0 ? `${when(start)} 개장 · D-${days}` : `개장까지 ${clock(start - now)}`;
    }
    if (now < end) return `마감까지 ${clock(end - now)}`;
    return '이번 행사 거래가 끝났어요';
  }

  /* ---------- 가상주식 trades: one idempotency key per unresolved trade, saved before sending ---------- */
  const pendingKey = () => `pangyo-games-pending-trade-v1:${userKey()}`;
  function readPending() {
    const raw = localStorage.getItem(pendingKey());
    if (!raw) return null;
    const saved = JSON.parse(raw);
    const input = JSON.parse(saved.fingerprint);
    if (typeof saved.key !== 'string' || saved.key.length < 8 || saved.key.length > 200
      || !/^[1-9][0-9]{0,9}$/.test(input.stockId) || !['buy', 'sell'].includes(input.side)
      || !Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 10000) throw new Error('PENDING_CORRUPT');
    return { input, key: saved.key };
  }
  async function submitTrade(input, at) {
    const fingerprint = JSON.stringify({ stockId: input.stockId, side: input.side, quantity: input.quantity });
    let key = crypto.randomUUID();
    try {
      const previous = readPending();
      if (previous) {
        if (JSON.stringify(previous.input) !== fingerprint) return report(at, '결과를 확인하지 못한 이전 거래가 있어요. 아래 \'이전 거래 결과 확인\'을 먼저 눌러 주세요.');
        key = previous.key;
      }
      localStorage.setItem(pendingKey(), JSON.stringify({ fingerprint, key }));
    } catch {
      return report(at, '이 브라우저에 거래 확인 정보를 저장할 수 없어 거래를 보내지 않았어요. 사이트 저장 설정을 확인해 주세요.');
    }
    tradeBusy = true;
    report(at, '거래를 보내는 중...', 'info');
    const response = await api().call('orbit_trade_stock', { p_stock_id: Number(input.stockId), p_side: input.side, p_quantity: input.quantity, p_idempotency_key: key });
    tradeBusy = false;
    const receipt = response.data;
    if (!response.ok) {
      if (FINAL_TRADE_ERRORS.has(response.code)) { try { localStorage.removeItem(pendingKey()); } catch { /* Retry shows it again. */ } }
      report(at, FINAL_TRADE_ERRORS.has(response.code) ? message(response.code) : `${message(response.code)} 같은 거래로 다시 확인할 수 있어요.`);
      return false;
    }
    if (!receipt || !['buy', 'sell'].includes(receipt.side) || !Number.isInteger(receipt.quantity) || !Number.isInteger(receipt.unitPrice)) {
      report(at, '거래 결과를 확인하지 못했어요. \'이전 거래 결과 확인\'으로 다시 확인해 주세요.');
      return false;
    }
    try { localStorage.removeItem(pendingKey()); } catch { /* The server answers a replay with the same receipt. */ }
    note = { at: 'game-trade', text: `${receipt.quantity}주 ${receipt.side === 'buy' ? '매수' : '매도'}가 ${point(receipt.unitPrice)}에 확정됐어요.`, tone: 'success' };
    closeTrade();
    await loadMarket({ quiet: true });
    if (note) showSpot(note.at, note.text, note.tone);
    return true;
  }
  async function retryTrade() {
    let pending;
    try { pending = readPending(); }
    catch { return report('game-retry', '이전 거래 정보가 손상됐어요. 운영자에게 거래 내역 확인을 요청해 주세요.'); }
    if (!pending) return report('game-retry', '확인할 이전 거래가 없어요.', 'info');
    tradeBusy = true;
    report('game-retry', '이전 거래 결과를 확인하는 중...', 'info');
    const ok = await submitTrade(pending.input, 'game-retry');
    if (ok) report('game-retry', note?.text || '이전 거래가 확정됐어요.', 'success');
  }

  /* ---------- 가상주식 screens ---------- */
  function header(title, back, right = '<span class="icon-btn" aria-hidden="true"></span>') {
    return `<header class="web-header"><button type="button" class="icon-btn" data-history-back="${back}" aria-label="뒤로 가기">${icon('back')}</button><div><h1>${h(title)}</h1></div>${right}</header>`;
  }
  const refreshButton = () => `<button type="button" class="icon-btn" data-game-refresh aria-label="새로고침" title="새로고침">${icon('refresh')}</button>`;
  function boothFor(name) {
    const clean = value => String(value || '').replace(/\s/g, '');
    return state.db?.booths?.find(booth => clean(booth.name) === clean(name)) || { name };
  }
  function changeText(stock) {
    if (!stock.change) return `<small class="game-flat">0.00%</small>`;
    return `<small class="${stock.change > 0 ? 'game-up' : 'game-down'}">${stock.change > 0 ? '▲' : '▼'} ${signedRate(stock.rate)}</small>`;
  }
  function statusBadge() {
    return marketOpen() ? '<span class="status-badge success">거래 중</span>' : '<span class="status-badge neutral">거래 준비·마감</span>';
  }
  function loadState(what) {
    if (market.status === 'error' && !market.data) {
      return `<div class="festival-empty"><span>${icon('notice')}</span><strong>${h(what)}을 불러오지 못했어요</strong><p>${h(message(market.code))}</p><button type="button" class="ghost-btn" data-game-refresh>${icon('refresh')} 다시 불러오기</button></div>`;
    }
    return '<p class="web-muted" role="status">불러오는 중...</p>';
  }
  function demoOnly(title) {
    return `<div class="festival-empty"><span>${icon('game')}</span><strong>${h(title)}은 실제 로그인에서 이용할 수 있어요</strong><p>체험 모드에는 가상 포인트가 없어요.</p></div>`;
  }

  // "n명 매칭중" next to 1대1 블랙잭 and above the blackjack lobby button. Refreshed every 5 s while the box is on
  // screen by changing only this box (no re-render).
  const lobbyRoute = () => state.route === 'games' || state.route === 'gamesBlackjack';
  const matchingBadge =() => `<span class="status-badge game-matching${lobby.waiting ? ' success' : ' muted'}" data-game-matching ${lobby.waiting === null ? 'hidden' : ''}><i aria-hidden="true"></i><span><b>${lobby.waiting ?? 0}</b>명 매칭중</span></span>`;
  function paintLobby() {
    const badge = document.querySelector('[data-game-matching]');
    if (!badge) return;
    badge.hidden = lobby.waiting === null;
    badge.classList.toggle('success', lobby.waiting > 0);
    badge.classList.toggle('muted', !(lobby.waiting > 0));
    badge.querySelector('b').textContent = lobby.waiting ?? 0;
  }
  async function loadLobby() {
    if (!api() || lobby.status === 'loading') return;
    const actor = state.user?.id;
    lobby.status = 'loading';
    const response = await api().call('festival_blackjack_lobby');
    if (state.user?.id !== actor) return;
    lobby.status = 'ready';
    if (response.ok && Number.isInteger(response.data?.waiting) && response.data.waiting >= 0) lobby.waiting = response.data.waiting;
    paintLobby();
    scheduleLobby();
  }
  function scheduleLobby() {
    clearTimeout(lobbyTimer);
    if (!lobbyRoute() || !isServerMode()) return;
    lobbyTimer = setTimeout(() => {
      if (!lobbyRoute()) return;
      if (document.visibilityState === 'visible' && document.querySelector('[data-game-matching]')) loadLobby(); else scheduleLobby();
    }, LOBBY_MS);
  }

  function hubView() {
    const list = stocks(), held = list.filter(stock => stock.quantity > 0).length;
    const stockLine = market.data ? `${marketOpen() ? '거래 중' : '거래 준비·마감'} · 종목 ${list.length}개${held ? ` · 보유 ${held}개` : ''}` : market.status === 'error' ? '정보를 불러오지 못했어요' : '불러오는 중...';
    return `<main class="screen p0-page web-page festival-games">
      ${festivalWeb.header('미니게임', '', true)}
      ${isServerMode() ? `<section class="profile-list game-wallet" aria-label="내 가상 포인트">
        <div><span>가상 포인트</span><strong>${balance() === null ? '—' : point(balance())}</strong></div>
      </section>
      <p class="web-muted game-wallet-note">미니게임에서만 쓰는 포인트예요. 부스 스탬프·바우처와는 따로 계산돼요.</p>
      ${market.status === 'error' && !market.data ? `<p class="ops-alert" role="alert">${h(message(market.code))}</p>` : ''}
      <nav class="profile-shortcuts game-list" aria-label="미니게임 목록">
        <button type="button" data-route="gamesStock"><span class="shortcut-symbol map">${icon('trend')}</span><span class="game-row-copy"><strong>동아리 가상주식</strong><small>${h(stockLine)}</small></span>${icon('arrow')}</button>
        <button type="button" data-route="gamesBlackjack"><span class="shortcut-symbol reviews">${icon('spade')}</span><span class="game-row-copy"><span class="game-row-title"><strong>1대1 블랙잭</strong>${matchingBadge()}</span><small>판돈 ${point(STAKE)} · 이기면 ${point(STAKE * 2)}</small></span>${icon('arrow')}</button>
      </nav>
      <p class="web-muted game-coming">새 미니게임이 열리면 이곳에 추가돼요.</p>` : demoOnly('미니게임')}
      ${bottomNav('games')}</main>`;
  }

  function stockRow(stock) {
    const favorite = (favorites || []).includes(stock.id);
    return `<li data-game-name="${h(stock.name.replace(/\s/g, '').toLocaleLowerCase('ko-KR'))}">
      <button type="button" class="icon-btn game-favorite" data-game-favorite="${h(stock.id)}" aria-pressed="${favorite}" aria-label="${h(stock.name)} ${favorite ? '관심 종목에서 빼기' : '관심 종목에 추가'}" title="${favorite ? '관심 종목에서 빼기' : '관심 종목에 추가'}">${icon('star')}</button>
      <button type="button" class="game-stock-row" data-game-stock="${h(stock.id)}" aria-label="${h(stock.name)} 종목 정보 보기">
        ${clubVisual(boothFor(stock.name))}
        <span class="game-stock-name"><strong>${h(stock.name)}</strong><small>STOCK-${h(stock.id)}${stock.quantity ? ` · ${stock.quantity.toLocaleString('ko-KR')}주 보유` : ''}</small></span>
        <span class="game-stock-price"><strong>${point(stock.price)}</strong>${changeText(stock)}</span>
      </button></li>`;
  }

  function stockListView() {
    if (!isServerMode()) return `<main class="screen p0-page web-page festival-games">${header('가상주식', 'games')}${demoOnly('가상주식')}${bottomNav('games')}</main>`;
    const all = stocks(), user = market.data;
    const held = all.filter(stock => stock.quantity > 0);
    const liked = all.filter(stock => (favorites || []).includes(stock.id));
    const trades = Array.isArray(user?.trades) ? user.trades : [];
    const value = held.reduce((sum, stock) => sum + stock.quantity * stock.price, 0);
    const cost = (user?.holdings || []).reduce((sum, item) => sum + (item.averageBuyPrice ?? 0) * item.quantity, 0);
    const unknownCost = (user?.holdings || []).some(item => item.quantity > 0 && item.averageBuyPrice === null);
    const pnl = value - cost;
    const tabs = [['market', '종목', all.length], ['favorites', '관심', liked.length], ['portfolio', '보유', held.length], ['history', '거래 내역', trades.length]];
    const shown = (tab === 'favorites' ? liked : tab === 'portfolio' ? held : all).slice().sort((a, b) => sort === 'gain' ? b.rate - a.rate
      : sort === 'loss' ? a.rate - b.rate : sort === 'name' ? a.name.localeCompare(b.name, 'ko') : 0);
    const nameOf = id => all.find(stock => stock.id === String(id))?.name || `STOCK-${id}`;
    const body = !user ? loadState('가상주식') : tab === 'history'
      ? (trades.length ? `<ul class="game-trade-list">${trades.map(item => `<li>
          <span class="status-badge ${item.side === 'buy' ? 'success' : 'neutral'}">${item.side === 'buy' ? '매수' : '매도'}</span>
          <span class="game-stock-name"><strong>${h(nameOf(item.stockId))}</strong><small>${h(when(item.createdAt))} · ${Number(item.quantity).toLocaleString('ko-KR')}주 × ${point(item.unitPrice)}</small></span>
          <strong>${point(item.totalPoints)}</strong></li>`).join('')}</ul>`
        : `<div class="festival-empty"><span>${icon('list')}</span><strong>아직 거래 내역이 없어요</strong><p>매수·매도가 확정되면 여기에 보여요.</p></div>`)
      : `<div class="game-controls">
          <label class="game-search"><span class="sr-only">종목 이름 검색</span>${icon('search')}<input class="input" type="search" data-game-search value="${h(query)}" maxlength="40" placeholder="종목 검색" autocomplete="off"></label>
          <label class="game-sort"><span class="sr-only">정렬</span><select class="select" data-game-sort>${[['default', '기본 순'], ['gain', '상승률 순'], ['loss', '하락률 순'], ['name', '이름 순']].map(([v, t]) => `<option value="${v}" ${sort === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        </div>
        ${shown.length ? `<ul class="game-stock-list">${shown.map(stockRow).join('')}</ul><p class="web-muted game-no-match" data-game-no-match hidden>검색 결과가 없어요. 다른 이름으로 찾아보세요.</p>`
          : `<div class="festival-empty"><span>${icon(tab === 'favorites' ? 'star' : 'trend')}</span><strong>${tab === 'favorites' ? '관심 종목이 없어요' : tab === 'portfolio' ? '아직 보유한 종목이 없어요' : '아직 등록된 종목이 없어요'}</strong><p>${tab === 'favorites' ? '종목 옆 별을 누르면 여기에 모여요.' : tab === 'portfolio' ? '종목을 매수하면 여기에 보여요.' : '종목이 등록되면 이곳에서 볼 수 있어요.'}</p></div>`}`;
    return `<main class="screen p0-page web-page festival-games game-stock">
      ${header('가상주식', 'games', refreshButton())}
      <p class="game-market">${statusBadge()}<span data-game-schedule>${h(schedule())}</span></p>
      ${market.status === 'error' && market.data ? `<p class="ops-alert" role="alert">최신 정보를 불러오지 못했어요. ${h(message(market.code))}</p>` : ''}
      ${user ? `<section class="profile-list game-summary" aria-label="내 주식 자산 요약">
        <div><span>총 가상 자산</span><strong>${point(user.pointBalance + value)}</strong></div>
        <div><span>투자할 수 있는 포인트</span><strong>${point(user.pointBalance)}</strong></div>
        <div><span>주식 평가 손익 <small>평가액 ${point(value)}</small></span><strong class="${unknownCost || !pnl ? '' : pnl > 0 ? 'game-up' : 'game-down'}">${unknownCost ? '원가 미확인' : signedPoint(pnl)}</strong></div>
      </section>` : ''}
      <div class="festival-view-tabs" role="group" aria-label="가상주식 메뉴">${tabs.map(([id, label, count]) => `<button type="button" data-game-tab="${id}" aria-pressed="${tab === id}">${label} <span>${count}</span></button>`).join('')}</div>
      ${body}
      <section class="ops-section game-news" aria-labelledby="gameNewsTitle"><h2 id="gameNewsTitle">소식</h2>
        ${news.items.length ? `<ul class="game-news-list">${news.items.map(item => `<li><strong>${h(item.title)}</strong>${item.content ? `<small>${h(item.content)}</small>` : ''}<time>${h(when(item.created_at))}</time></li>`).join('')}</ul>`
          : `<p class="web-muted">${news.status === 'loading' || news.status === 'idle' ? '불러오는 중...' : news.status === 'error' ? '소식을 불러오지 못했어요.' : '아직 등록된 소식이 없어요.'}</p>`}
      </section>
      <section class="game-retry">${slot('game-retry')}<button type="button" class="ghost-btn full-action" data-game-retry ${tradeBusy ? 'disabled' : ''}>${icon('refresh')} 이전 거래 결과 확인</button>
        <p class="web-muted">거래 중 연결이 끊겼다면 이 버튼으로 같은 거래가 확정됐는지 확인해요. 두 번 거래되지 않아요.</p></section>
      ${bottomNav('games')}</main>`;
  }

  function chartMarkup(stock) {
    const width = 320, height = 168, padX = 8, padY = 12;
    const start = chart.start ?? Date.now() - CHART_MS;
    const data = chart.points.filter(p => p.time >= start && p.time <= start + CHART_MS);
    const min = data.length ? Math.min(...data.map(p => p.price)) : stock.price;
    const max = data.length ? Math.max(...data.map(p => p.price)) : stock.price;
    const pad = Math.max((max - min) * 0.22, max * 0.005, 1);
    const lower = Math.max(0, min - pad), upper = max + pad;
    const x = time => padX + (width - padX * 2) * (time - start) / CHART_MS;
    const y = price => padY + (height - padY * 2) * (upper - price) / (upper - lower);
    const up = chart.opening === null ? stock.change >= 0 : stock.price >= chart.opening;
    const line = data.map((p, i) => `${i ? 'L' : 'M'}${x(p.time).toFixed(1)},${y(p.price).toFixed(1)}`).join(' ');
    const ticks = [0, 1, 2, 3, 4];
    const empty = chart.status === 'loading' ? '가격 기록을 불러오는 중이에요.' : chart.status === 'error' ? '가격 기록을 불러오지 못했어요.' : '가격이 기록되면 그래프가 그려져요.';
    return `<figure class="game-chart ${up ? 'is-up' : 'is-down'}" data-game-chart data-start="${start}" data-points="${h(JSON.stringify(data.map(p => [p.time, p.price])))}">
      <p class="game-chart-tip" data-game-chart-tip hidden></p>
      <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${data.length ? `2시간 가격 그래프: 최저 ${point(min)}, 최고 ${point(max)}` : '아직 가격 기록이 없어요.'}">
        ${ticks.map(i => `<line class="grid" x1="${padX}" x2="${width - padX}" y1="${padY + i * (height - padY * 2) / 4}" y2="${padY + i * (height - padY * 2) / 4}"/>`).join('')}
        ${data.length ? `<path class="area" d="${line} L${x(data[data.length - 1].time).toFixed(1)},${height - padY} L${x(data[0].time).toFixed(1)},${height - padY} Z"/><path class="line" d="${line}"/>${data.length === 1 ? `<circle class="dot" cx="${x(data[0].time).toFixed(1)}" cy="${y(data[0].price).toFixed(1)}" r="3.5"/>` : ''}` : ''}
        <line class="cursor" data-game-chart-cursor x1="0" x2="0" y1="${padY}" y2="${height - padY}" visibility="hidden"/>
      </svg>
      <div class="game-chart-axis" aria-hidden="true">${ticks.map(i => `<span>${clockTime(start + i * CHART_MS / 4)}</span>`).join('')}</div>
      ${data.length ? '' : `<figcaption role="status">${empty}</figcaption>`}
    </figure>`;
  }

  function stockDetailView() {
    if (!isServerMode()) return `<main class="screen p0-page web-page festival-games">${header('가상주식', 'gamesStock')}${demoOnly('가상주식')}${bottomNav('games')}</main>`;
    const stock = stocks().find(item => item.id === String(state.gameStockId));
    const favorite = stock && (favorites || []).includes(stock.id);
    const right = stock ? `<button type="button" class="icon-btn game-favorite" data-game-favorite="${h(stock.id)}" aria-pressed="${favorite}" aria-label="${favorite ? '관심 종목에서 빼기' : '관심 종목에 추가'}" title="${favorite ? '관심 종목에서 빼기' : '관심 종목에 추가'}">${icon('star')}</button>` : undefined;
    if (!stock) {
      const body = market.data ? `<div class="festival-empty"><span>${icon('search')}</span><strong>종목을 찾을 수 없어요</strong><p>목록에서 다시 골라 주세요.</p><button type="button" class="ghost-btn" data-route="gamesStock">종목 목록 보기</button></div>` : loadState('종목 정보');
      return `<main class="screen p0-page web-page festival-games">${header('종목 정보', 'gamesStock', right)}${body}${bottomNav('games')}</main>`;
    }
    if (chart.key.split(':')[0] !== stock.id || chart.status === 'idle') setTimeout(() => loadChart(stock), 0);
    const open = marketOpen();
    const status = stock.canTrade && open ? '<span class="status-badge success">거래 가능</span>'
      : stock.tradingStatus === 'halted' ? '<span class="status-badge warning">거래 중지</span>'
      : stock.stale && open ? '<span class="status-badge warning">가격 갱신 대기</span>' : '<span class="status-badge neutral">거래 대기</span>';
    const opening = chart.opening;
    const vsOpen = opening ? stock.price - opening : null;
    const userBalance = balance() ?? 0;
    return `<main class="screen p0-page web-page festival-games game-stock-detail">
      ${header(stock.name, 'gamesStock', right)}
      <section class="game-quote">
        <div class="game-quote-head">${clubVisual(boothFor(stock.name), 'detail')}<div><p class="web-muted">가상주식 · STOCK-${h(stock.id)}</p><h2>${h(stock.name)}</h2></div></div>
        <p class="game-quote-status">${status}<span data-game-schedule>${h(schedule())}</span></p>
        <p class="game-price">${stock.price.toLocaleString('ko-KR')}<small>P</small></p>
        <p class="game-change">${vsOpen === null ? '<span class="web-muted">시작가 미확인</span>' : `<span class="${vsOpen > 0 ? 'game-up' : vsOpen < 0 ? 'game-down' : 'game-flat'}">${vsOpen > 0 ? '▲' : vsOpen < 0 ? '▼' : ''} ${signedPoint(vsOpen)} (${signedRate(vsOpen / opening * 100)})</span><span class="web-muted">시작가 대비</span>`}</p>
      </section>
      <section class="game-chart-section" aria-labelledby="gameChartTitle"><h2 id="gameChartTitle">${market.data?.market ? '행사 2시간 시세' : '최근 2시간 시세'}</h2>${chartMarkup(stock)}
        <p class="web-muted game-time">${stock.updatedAt ? `${h(when(stock.updatedAt))} 가격 기준` : '가격 갱신 시각 미확인'}</p></section>
      <section class="profile-list game-holding" aria-label="내 보유 정보">
        <div><span>시작가</span><strong>${opening ? point(opening) : '미확인'}</strong></div>
        <div><span>내 보유 수량</span><strong>${stock.quantity.toLocaleString('ko-KR')}주</strong></div>
        <div><span>보유 평가액</span><strong>${point(stock.quantity * stock.price)}</strong></div>
      </section>
      ${slot('game-trade')}
      <div class="game-trade-actions">
        <button type="button" class="primary-btn" data-game-trade="buy" ${!stock.canTrade || !open || userBalance < stock.price || tradeBusy ? 'disabled' : ''}>${icon('plus')} 매수하기</button>
        <button type="button" class="ghost-btn" data-game-trade="sell" ${!stock.canTrade || !open || stock.quantity < 1 || tradeBusy ? 'disabled' : ''}>${icon('minus')} 매도하기</button>
      </div>
      ${open ? '' : '<p class="web-muted game-trade-hint">주식시장이 열리면 매수·매도할 수 있어요.</p>'}
      ${bottomNav('games')}</main>`;
  }

  /* ---------- trade dialog (.ops-dialog) ---------- */
  function closeTrade() {
    trade = null;
    document.querySelector('.game-trade-dialog')?.remove();
  }
  function maxQuantity(stock, side) {
    return Math.min(10000, side === 'buy' ? Math.floor((balance() ?? 0) / stock.price) : stock.quantity);
  }
  function openTrade(side) {
    const stock = stocks().find(item => item.id === String(state.gameStockId));
    if (!stock) return;
    note = null;
    trade = { side, stockId: stock.id, quantity: 1 };
    document.querySelector('.ops-dialog')?.remove();
    const d = document.createElement('dialog');
    d.className = 'ops-dialog game-trade-dialog';
    d.setAttribute('aria-labelledby', 'gameTradeTitle');
    document.body.append(d);
    drawTrade();
    d.addEventListener('cancel', event => { event.preventDefault(); if (!tradeBusy) closeTrade(); });
    d.showModal();
    d.querySelector('[data-trade-confirm]')?.focus();
  }
  function drawTrade() {
    const d = document.querySelector('.game-trade-dialog');
    const stock = trade && stocks().find(item => item.id === trade.stockId);
    if (!d || !stock) return;
    const verb = trade.side === 'buy' ? '매수' : '매도';
    const most = maxQuantity(stock, trade.side);
    trade.quantity = Math.max(1, Math.min(trade.quantity, Math.max(1, most)));
    d.innerHTML = `<header><h2 id="gameTradeTitle">${h(stock.name)} ${verb}</h2><button type="button" class="icon-btn" data-trade-close aria-label="닫기" ${tradeBusy ? 'disabled' : ''}>${icon('close')}</button></header>
      <div class="ops-dialog-content">
        <dl class="game-trade-sheet"><div><dt>현재 확정 가격</dt><dd>${point(stock.price)}</dd></div><div><dt>주문 가능</dt><dd>${most.toLocaleString('ko-KR')}주</dd></div></dl>
        <div class="game-stepper" role="group" aria-label="주문 수량">
          <button type="button" class="icon-btn" data-trade-step="-1" aria-label="한 주 빼기" ${trade.quantity <= 1 || tradeBusy ? 'disabled' : ''}>${icon('minus')}</button>
          <output aria-live="polite">${trade.quantity.toLocaleString('ko-KR')}주</output>
          <button type="button" class="icon-btn" data-trade-step="1" aria-label="한 주 더하기" ${trade.quantity >= most || tradeBusy ? 'disabled' : ''}>${icon('plus')}</button>
        </div>
        ${most < 1 ? `<p class="ops-alert" role="alert">${trade.side === 'buy' ? '가상 포인트가 부족해 살 수 없어요.' : '보유한 주식이 없어요.'}</p>` : ''}
        ${slot('game-trade-dialog')}
        <button type="button" class="primary-btn full-action" data-trade-confirm ${most < 1 || tradeBusy ? 'disabled' : ''}>${verb} 확정 · ${point(stock.price * trade.quantity)}</button>
        <button type="button" class="ghost-btn full-action" data-trade-close ${tradeBusy ? 'disabled' : ''}>취소</button>
      </div>`;
    d.querySelectorAll('[data-trade-close]').forEach(button => { button.onclick = () => { if (!tradeBusy) closeTrade(); }; });
    d.querySelectorAll('[data-trade-step]').forEach(button => { button.onclick = () => { trade.quantity += Number(button.dataset.tradeStep); drawTrade(); d.querySelector(`[data-trade-step="${button.dataset.tradeStep}"]:not(:disabled)`)?.focus(); }; });
    d.querySelector('[data-trade-confirm]').onclick = async () => {
      const current = stocks().find(item => item.id === trade.stockId);
      if (!current?.canTrade || !marketOpen()) return report('game-trade-dialog', '지금은 거래할 수 없어요. 창을 닫고 새로고침해 주세요.');
      if (trade.quantity > maxQuantity(current, trade.side)) return report('game-trade-dialog', '거래 가능 수량이 바뀌었어요. 수량을 줄여 주세요.');
      const input = { stockId: trade.stockId, side: trade.side, quantity: trade.quantity };
      tradeBusy = true; drawTrade();
      const ok = await submitTrade(input, 'game-trade-dialog');
      tradeBusy = false;
      if (!ok && trade) drawTrade();
      if (!ok && note) showSpot(note.at, note.text, note.tone);
      if (ok) { render(); if (note) showSpot(note.at, note.text, note.tone); document.querySelector('[data-game-trade="buy"]')?.focus(); }
    };
  }

  /* ---------- 블랙잭 (server decides every card and turn; this only shows it) ---------- */
  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const SUITS = [['♠', false], ['♥', true], ['♦', true], ['♣', false]];
  // Same scoring as private.blackjack_total: aces count 11 until the hand would go over 21.
  function handTotal(cards) {
    let total = 0, aces = 0;
    for (const card of cards) {
      const rank = card % 13;
      if (rank === 0) { total += 11; aces += 1; } else total += rank >= 10 ? 10 : rank + 1;
    }
    while (total > 21 && aces > 0) { total -= 10; aces -= 1; }
    return total;
  }
  const validCard = card => card === null || (Number.isInteger(card) && card >= 0 && card <= 51);
  function validGame(game) {
    return game && typeof game.id === 'string' && ['waiting', 'playing', 'finished', 'cancelled'].includes(game.status)
      && Number.isInteger(game.version) && Array.isArray(game.myCards) && game.myCards.every(c => c !== null && validCard(c))
      && Array.isArray(game.opponentCards) && game.opponentCards.every(validCard) && Number.isInteger(game.stake);
  }
  function tableEvents(previous, next) {
    if (previous.id !== next.id || previous.status !== 'playing') return [];
    const events = [];
    const myHits = next.myCards.length - previous.myCards.length;
    for (let i = 0; i < myHits; i++) events.push({ side: 'me', kind: 'hit', total: handTotal(next.myCards.slice(0, previous.myCards.length + i + 1)) });
    if (!previous.myDone && next.myDone) {
      const kind = next.myTotal > 21 ? 'bust' : myHits > 0 && next.myTotal === 21 ? 'twentyOne' : myHits > 0 ? 'done' : bj.sent === 'stand' ? 'stand' : 'timeout';
      events.push({ side: 'me', kind, total: next.myTotal });
    }
    const theirHits = next.opponentCards.length - previous.opponentCards.length;
    for (let i = 0; i < theirHits; i++) events.push({ side: 'opponent', kind: 'hit', total: null });
    if (!previous.opponentDone && next.opponentDone) events.push({ side: 'opponent', kind: theirHits > 0 ? 'done' : 'stand', total: null });
    return events;
  }
  const BADGE = { hit: '히트!', stand: '스탠드', timeout: '시간 초과', bust: '버스트!', twentyOne: '21!', done: '멈춤' };
  function describe(event) {
    const who = event.side === 'me' ? '나' : '상대';
    return ({ hit: event.side === 'me' ? `내가 히트했어요 · ${event.total}점` : '상대가 히트했어요',
      stand: event.side === 'me' ? `내가 스탠드했어요 · ${event.total}점` : '상대가 스탠드했어요',
      timeout: `시간 초과로 스탠드됐어요 · ${event.total}점`, bust: `버스트! ${event.total}점`,
      twentyOne: '21점! 자동으로 멈췄어요', done: `${who}의 차례가 끝났어요` })[event.kind];
  }
  // Final reveal flips one card per side in turn: opponent's first card, mine, opponent's second, ...
  function revealOrder(game) {
    const order = [];
    for (let i = 0; i < Math.max(game.myCards.length, game.opponentCards.length); i++) {
      if (i < game.opponentCards.length) order.push(['opponent', i]);
      if (i < game.myCards.length) order.push(['me', i]);
    }
    return order;
  }
  const active = () => ['waiting', 'playing'].includes(bj.game?.status);

  function applyGame(next) {
    const prior = bj.game;
    if (prior && next) {
      const events = tableEvents(prior, next);
      if (events.length) {
        bj.announcement = events.map(describe).join('. ');
        for (const event of events) bj.badges[event.side] = { kind: event.kind, key: ++bj.key };
        if (events.some(event => event.side === 'me')) bj.sent = null;
      }
      if (prior.id === next.id && prior.status === 'playing' && next.status === 'finished') startReveal(next);
    }
    if (next?.status === 'playing' && prior?.id !== next.id) { bj.announcement = ''; bj.badges = {}; }
    const changed = JSON.stringify(prior) !== JSON.stringify(next);
    bj.game = next;
    if (next?.status === 'finished' && rematch.gameId !== next.id) {
      rematch = { gameId: next.id, me: null, opponent: null, expired: false, busy: false, loading: false };
    }
    if (next && ['finished', 'cancelled'].includes(next.status) && bj.settled !== next.id) {
      bj.settled = next.id;
      loadMarket({ quiet: true });
    }
    return changed;
  }
  function startReveal(game) {
    clearTimeout(revealTimer);
    bj.reveal = { game, flipped: 0, total: revealOrder(game).length };
    const step = () => {
      if (!bj.reveal || bj.reveal.flipped >= bj.reveal.total) return;
      revealTimer = setTimeout(() => {
        if (!bj.reveal) return;
        bj.reveal.flipped += 1;
        // Only this render animates the new card; later renders (polls) show every turned card still.
        bj.reveal.fresh = true;
        if (state.route === 'gamesBlackjack') render();
        bj.reveal.fresh = false;
        step();
      }, bj.reveal.flipped === 0 ? 400 : FLIP_MS);
    };
    step();
  }

  async function loadBlackjack() {
    if (!api() || bj.loading) return;
    const actor = state.user?.id;
    bj.loading = true;
    const response = await api().call('orbit_blackjack_state');
    bj.loading = false;
    if (state.user?.id !== actor) return;
    if (!response.ok) {
      bj.code = response.code;
      if (bj.status !== 'ready') bj.status = 'error';
      if (state.route === 'gamesBlackjack') render();
      return;
    }
    const game = validGame(response.data) ? response.data : null;
    // A game that already ended before this screen opened is not settled again.
    if (bj.status !== 'ready' && game && ['finished', 'cancelled'].includes(game.status)) bj.settled = game.id;
    const first = bj.status !== 'ready';
    bj.status = 'ready'; bj.code = '';
    if ((applyGame(game) || first) && state.route === 'gamesBlackjack') renderKeepingFocus();
    schedulePoll();
  }
  // Rematch with the same opponent. 'watch' is the 1 s heartbeat while the finished game is on screen,
  // 'accept' is "한 판 더 하기", 'decline' is sent once when the player leaves the blackjack screen.
  const REMATCH_STATES = ['waiting', 'accept', 'decline'];
  const rematchOpen = () => bj.game?.status === 'finished' && rematch.gameId === bj.game.id && !rematch.expired;
  async function loadRematch(choice) {
    const game = bj.game, r = rematch;
    if (!api() || !rematchOpen() || (choice === 'watch' && r.loading) || (choice === 'accept' && r.busy)) { schedulePoll(); return; }
    const actor = state.user?.id;
    r.loading = true;
    if (choice === 'accept') { r.busy = true; report('bj', '다시 하기를 보내는 중...', 'info', true); }
    const response = await api().call('festival_blackjack_rematch', { p_game_id: game.id, p_choice: choice });
    r.loading = false;
    if (choice === 'accept') r.busy = false;
    if (state.user?.id !== actor || rematch !== r) return;
    if (!response.ok) {
      if (['REMATCH_EXPIRED', 'GAME_NOT_FOUND'].includes(response.code)) { r.expired = true; r.opponent = null; }
      if (choice === 'accept') report('bj', message(response.code, 'blackjack'), 'error', true);
      else if (r.expired && state.route === 'gamesBlackjack') renderKeepingFocus();
      schedulePoll();
      return;
    }
    const next = validGame(response.data?.game) ? response.data.game : null;
    if (next && next.id !== game.id) {
      // Both accepted: the new game with the same opponent starts here.
      note = null;
      applyGame(next);
      loadMarket({ quiet: true });
      if (state.route === 'gamesBlackjack') renderKeepingFocus();
      schedulePoll();
      return;
    }
    const me = REMATCH_STATES.includes(response.data?.me) ? response.data.me : null;
    const opponent = REMATCH_STATES.includes(response.data?.opponent) ? response.data.opponent : null;
    const changed = r.me !== me || r.opponent !== opponent;
    r.me = me; r.opponent = opponent;
    if (choice === 'accept') note = null;
    if ((changed || choice === 'accept') && state.route === 'gamesBlackjack') renderKeepingFocus();
    schedulePoll();
  }
  function leaveRematch() {
    if (!rematchOpen() || rematch.me === null || rematch.me === 'decline') return;
    rematch.me = 'decline';
    api()?.call('festival_blackjack_rematch', { p_game_id: rematch.gameId, p_choice: 'decline' });
  }

  async function sendBlackjack(action) {
    if (action === 'rematch') { loadRematch('accept'); return; }
    if (bj.busy) return;
    const game = bj.game;
    bj.busy = true;
    if (['hit', 'stand'].includes(action)) bj.sent = action;
    report('bj', action === 'join' ? '상대를 찾는 중...' : action === 'cancel' ? '대기를 취소하는 중...' : '보내는 중...', 'info');
    const response = action === 'join' ? await api().call('orbit_blackjack_join')
      : action === 'cancel' ? await api().call('orbit_blackjack_cancel')
      : await api().call('orbit_blackjack_action', { p_game_id: game?.id, p_action: action, p_version: game?.version });
    bj.busy = false;
    if (!response.ok) {
      bj.sent = null;
      report('bj', message(response.code, 'blackjack'), 'error', true);
      loadBlackjack();
      return;
    }
    note = null;
    applyGame(validGame(response.data) ? response.data : null);
    if (action === 'join') loadMarket({ quiet: true });
    renderKeepingFocus();
    schedulePoll();
  }
  function renderKeepingFocus() {
    const focused = document.activeElement?.dataset?.bj;
    render();
    if (focused) document.querySelector(`[data-bj="${focused}"]:not(:disabled)`)?.focus();
  }
  function schedulePoll() {
    clearTimeout(pollTimer);
    // A game in progress reloads its state; a finished game keeps the rematch heartbeat going.
    if (state.route !== 'gamesBlackjack' || (!active() && !rematchOpen())) return;
    pollTimer = setTimeout(() => {
      if (state.route !== 'gamesBlackjack') return;
      if (document.visibilityState !== 'visible') schedulePoll();
      else if (active()) loadBlackjack();
      else loadRematch('watch');
    }, POLL_MS);
  }
  function tick() {
    clearInterval(tickTimer);
    if (state.route !== 'gamesBlackjack' && state.route !== 'gamesStock' && state.route !== 'gamesStockDetail') return;
    tickTimer = setInterval(() => {
      if (!isGameRoute(state.route)) { clearInterval(tickTimer); return; }
      const now = Date.now();
      const timer = document.querySelector('[data-bj-timer]');
      if (timer && bj.game?.turnDeadline) {
        const left = Math.max(0, Date.parse(bj.game.turnDeadline) - now);
        timer.querySelector('i').style.width = `${Math.min(100, left / (TURN_SECONDS * 10))}%`;
        timer.querySelector('b').textContent = `${Math.ceil(left / 1000)}초`;
        timer.setAttribute('aria-label', `남은 시간 ${Math.ceil(left / 1000)}초`);
      }
      const waited = document.querySelector('[data-bj-waited]');
      if (waited && bj.game?.createdAt) {
        const s = Math.max(0, Math.floor((now - Date.parse(bj.game.createdAt)) / 1000));
        waited.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      }
      const countdown = document.querySelector('[data-game-schedule]');
      if (countdown && market.data) countdown.textContent = schedule(now);
    }, 200);
  }

  function card(value, flip = false) {
    if (value === null) return '<span class="game-card back" role="img" aria-label="뒤집힌 카드"></span>';
    const [suit, red] = SUITS[Math.floor(value / 13)];
    return `<span class="game-card${red ? ' red' : ''}${flip ? ' flip' : ''}" role="img" aria-label="${suit} ${RANKS[value % 13]}"><b>${RANKS[value % 13]}</b><i aria-hidden="true">${suit}</i></span>`;
  }
  function hand(cards, shownCount = null, side = null, small = false) {
    const order = bj.reveal ? revealOrder(bj.reveal.game) : [];
    return `<div class="game-hand${small ? ' small' : ''}">${cards.map((value, index) => {
      if (shownCount === null) return card(value);
      const position = order.findIndex(([s, i]) => s === side && i === index);
      return position < shownCount ? card(value, !!bj.reveal?.fresh && position === shownCount - 1) : card(null);
    }).join('')}</div>`;
  }
  const outcomeText = result => result === 'win' ? '승리!' : result === 'lose' ? '패배' : '무승부';
  const outcomeLine = (result, stake) => result === 'win' ? `+${point(stake)}` : result === 'lose' ? `−${point(stake)}` : '판돈을 돌려받았어요';

  function tableView() {
    const reveal = bj.reveal, shown = reveal?.game || bj.game;
    const flipped = reveal?.flipped ?? null, done = reveal && reveal.flipped >= reveal.total;
    const visibleTotal = side => {
      const cards = shown[side === 'me' ? 'myCards' : 'opponentCards'];
      const order = revealOrder(shown);
      return handTotal(cards.filter((c, i) => c !== null && order.findIndex(([s, j]) => s === side && j === i) < flipped));
    };
    const myTurn = shown.status === 'playing' && shown.turn === 'me' && !shown.myDone;
    const myTotal = reveal ? visibleTotal('me') : shown.myTotal;
    const theirTotal = reveal ? visibleTotal('opponent') : null;
    const left = shown.turnDeadline ? Math.max(0, Date.parse(shown.turnDeadline) - Date.now()) : null;
    const badge = side => !reveal && bj.badges[side] ? `<span class="game-bj-badge" data-kind="${bj.badges[side].kind}">${BADGE[bj.badges[side].kind]}</span>` : '';
    return `<section class="game-bj-table" aria-label="블랙잭 테이블">
      <div class="game-bj-seat${!reveal && shown.turn === 'opponent' ? ' is-turn' : ''}">
        <div class="game-bj-seat-head"><span><strong>${h(shown.opponentName || '상대')}</strong> <small>카드 ${shown.opponentCards.length}장</small></span>
          ${reveal ? `<strong class="game-bj-total${theirTotal > 21 ? ' bust' : ''}">${theirTotal}</strong>` : `<small>${shown.opponentDone ? '멈춤' : shown.turn === 'opponent' ? '고르는 중...' : '기다리는 중'}</small>`}</div>
        ${hand(shown.opponentCards, flipped, 'opponent')}${badge('opponent')}
      </div>
      <div class="game-bj-center">
        ${done ? `<div class="game-bj-outcome ${h(shown.result || 'draw')}" role="alert"><strong>${outcomeText(shown.result)}</strong><span>${outcomeLine(shown.result, shown.stake)}</span>
            <button type="button" class="primary-btn full-action" data-bj-ok>확인</button></div>`
          : reveal ? '<p class="game-bj-turn" role="status">카드를 한 장씩 공개해요...</p>'
          : `<p class="game-bj-turn${myTurn ? ' mine' : ''}" role="status">${myTurn ? '내 차례예요. 히트나 스탠드를 골라 주세요.' : shown.myDone ? '나는 멈췄어요. 상대를 기다려요.' : '상대가 고르는 중이에요.'}</p>
            ${left !== null ? `<span class="game-bj-timer" data-bj-timer role="timer" aria-label="남은 시간 ${Math.ceil(left / 1000)}초"><i style="width:${Math.min(100, left / (TURN_SECONDS * 10))}%"></i><b>${Math.ceil(left / 1000)}초</b></span>` : ''}`}
      </div>
      <div class="game-bj-seat${myTurn ? ' is-turn' : ''}">
        <div class="game-bj-seat-head"><span><strong>나</strong> <small>카드 ${shown.myCards.length}장</small></span>
          <strong class="game-bj-total${myTotal > 21 ? ' bust' : ''}">${myTotal}${!reveal ? (myTotal > 21 ? ' · 버스트' : shown.myDone ? ' · 스탠드' : '') : ''}</strong></div>
        ${hand(shown.myCards, flipped, 'me')}${badge('me')}
      </div>
      ${reveal ? '' : `${slot('bj')}<div class="game-trade-actions">
        <button type="button" class="primary-btn" data-bj="hit" ${!myTurn || bj.busy ? 'disabled' : ''}>${icon('plus')} 히트</button>
        <button type="button" class="ghost-btn" data-bj="stand" ${!myTurn || bj.busy ? 'disabled' : ''}>${icon('hand')} 스탠드</button>
      </div>`}
    </section>`;
  }

  const REMATCH_LABEL = { waiting: '대기중', accept: '수락', decline: '거부' };
  const REMATCH_TONE = { waiting: 'warning', accept: 'success', decline: 'muted' };
  function lobbyView() {
    const game = bj.game, money = balance();
    const enough = money !== null && money >= STAKE;
    // "한 판 더 하기" asks the same opponent unless they declined; then it looks for a new random opponent.
    const r = rematchOpen() ? rematch : null;
    const sameOpponent = !!r && r.opponent !== 'decline';
    const waitingForThem = sameOpponent && r.me === 'accept';
    if (game?.status === 'waiting') {
      const waited = Math.max(0, Math.floor((Date.now() - Date.parse(game.createdAt)) / 1000));
      return `<section class="game-bj-waiting" aria-live="polite"><span>${icon('spade')}</span><h2>상대를 찾고 있어요</h2>
        <p><span data-bj-waited>${Math.floor(waited / 60)}:${String(waited % 60).padStart(2, '0')}</span> · 3분 안에 상대가 없으면 판돈을 돌려받아요.</p>
        ${slot('bj')}<button type="button" class="ghost-btn full-action" data-bj="cancel" ${bj.busy ? 'disabled' : ''}>${icon('close')} 취소하고 ${point(STAKE)} 돌려받기</button></section>`;
    }
    return `${game?.status === 'finished' ? `<section class="game-bj-result ${h(game.result || 'draw')}" aria-live="polite"><strong>${outcomeText(game.result)}</strong><span>${outcomeLine(game.result, game.stake)}</span>
        <div class="game-bj-result-hands"><div><small>나 · ${game.myTotal}${game.myTotal > 21 ? ' · 버스트' : ''}</small>${hand(game.myCards, null, null, true)}</div>
        <div><small>${h(game.opponentName || '상대')} · ${game.opponentTotal ?? '—'}${(game.opponentTotal ?? 0) > 21 ? ' · 버스트' : ''}</small>${hand(game.opponentCards, null, null, true)}</div></div></section>` : ''}
      ${game?.status === 'cancelled' ? `<p class="ops-form-status" data-tone="success" role="status">대기를 취소하고 ${point(game.stake)}를 돌려받았어요.</p>` : ''}
      ${r?.opponent ? `<p class="game-bj-rematch" role="status"><span class="status-badge ${REMATCH_TONE[r.opponent]}" data-bj-rematch="${r.opponent}"><i aria-hidden="true"></i>상대 : ${REMATCH_LABEL[r.opponent]}</span></p>` : ''}
      ${sameOpponent ? '' : `<p class="game-bj-rematch">${matchingBadge()}</p>`}
      ${slot('bj')}
      <button type="button" class="primary-btn full-action" data-bj="${sameOpponent ? 'rematch' : 'join'}" ${bj.busy || r?.busy || waitingForThem || !enough ? 'disabled' : ''}>${icon('spade')} ${game?.status === 'finished' ? '한 판 더 하기' : `${point(STAKE)} 걸고 상대 찾기`}</button>
      ${waitingForThem && r.opponent !== 'accept' ? '<p class="web-muted game-trade-hint">상대도 수락하면 같은 상대와 바로 시작해요.</p>' : ''}
      ${money !== null && !enough ? `<p class="web-muted game-trade-hint">가상 포인트가 ${point(STAKE)} 이상이어야 참가할 수 있어요.</p>` : ''}
      <section class="ops-section game-rules" aria-labelledby="gameRulesTitle"><h2 id="gameRulesTitle">규칙</h2>
        <ul>
          <li>둘 다 카드 2장으로 시작해 번갈아 히트(한 장 더)나 스탠드를 골라요.</li>
          <li>먼저 스탠드한 사람은 그대로 멈추고, 남은 사람만 계속 골라요.</li>
          <li>둘 다 멈추거나 버스트되면 모든 카드를 공개하고 승부를 가려요.</li>
          <li>상대 카드는 첫 장만 보여요. 21에 더 가까운 사람이 판돈 ${point(STAKE * 2)}를 가져가요.</li>
          <li>둘 다 버스트이거나 점수가 같으면 판돈을 돌려받아요.</li>
          <li>${TURN_SECONDS}초 안에 고르지 않으면 스탠드로 처리돼요.</li>
        </ul>
        <h3>카드 점수</h3>
        <dl class="game-terms"><div><dt>2~10</dt><dd>적힌 숫자 그대로</dd></div><div><dt>J · Q · K</dt><dd>10점</dd></div><div><dt>A</dt><dd>1점이나 11점. 21을 넘지 않는 쪽으로 자동으로 계산돼요.</dd></div></dl>
        <h3>용어</h3>
        <dl class="game-terms"><div><dt>히트</dt><dd>카드를 한 장 더 받아요.</dd></div><div><dt>스탠드</dt><dd>카드를 더 받지 않고 지금 점수로 멈춰요. 이번 판에서는 다시 받을 수 없어요.</dd></div><div><dt>버스트</dt><dd>카드 점수 합이 21을 넘은 상태예요. 버스트되면 져요.</dd></div></dl>
      </section>`;
  }

  function blackjackView() {
    if (!isServerMode()) return `<main class="screen p0-page web-page festival-games">${header('블랙잭', 'games')}${demoOnly('블랙잭')}${bottomNav('games')}</main>`;
    const atTable = bj.game?.status === 'playing' || bj.reveal;
    const body = bj.status === 'ready' ? (atTable ? tableView() : lobbyView())
      : bj.status === 'error' ? `<div class="festival-empty"><span>${icon('notice')}</span><strong>게임 상태를 불러오지 못했어요</strong><p>${h(message(bj.code, 'blackjack'))}</p><button type="button" class="ghost-btn" data-bj-reload>${icon('refresh')} 다시 불러오기</button></div>`
      : '<p class="web-muted" role="status">게임 상태를 불러오는 중...</p>';
    return `<main class="screen p0-page web-page festival-games game-blackjack${atTable ? ' at-table' : ''}">
      ${header('블랙잭', 'games')}
      ${atTable ? '' : `<section class="profile-list game-wallet" aria-label="내 가상 포인트"><div><span>가상 포인트</span><strong>${balance() === null ? '—' : point(balance())}</strong></div></section>
      <p class="web-muted game-wallet-note">무작위로 만난 상대와 ${point(STAKE)}를 걸고, 21에 더 가까운 쪽이 판돈 ${point(STAKE * 2)}를 가져가요.</p>`}
      ${body}
      <p class="sr-only" aria-live="polite">${h(bj.announcement)}</p>
      ${bottomNav('games')}</main>`;
  }

  function view() {
    if (owner !== (state.user?.id || null)) reset();
    if (isServerMode() && market.status === 'idle') setTimeout(() => loadMarket({ quiet: true }), 0);
    if (state.route === 'gamesStock') { if (isServerMode() && news.status === 'idle') setTimeout(loadNews, 0); return stockListView(); }
    if (state.route === 'gamesStockDetail') return stockDetailView();
    if (isServerMode() && lobby.status === 'idle') setTimeout(loadLobby, 0);
    if (state.route === 'gamesBlackjack') { if (isServerMode() && bj.status === 'idle') setTimeout(loadBlackjack, 0); return blackjackView(); }
    return hubView();
  }

  // Called when the route changes to a games screen (fresh data each visit) or away from one.
  function load() {
    if (state.route !== 'gamesBlackjack') leaveRematch();
    if (!lobbyRoute()) clearTimeout(lobbyTimer);
    if (!isGameRoute(state.route)) { clearTimeout(pollTimer); clearInterval(tickTimer); closeTrade(); return; }
    if (!isServerMode()) return;
    if (owner !== (state.user?.id || null)) reset();
    loadMarket({ quiet: market.status === 'ready' });
    if (lobbyRoute()) loadLobby();
    if (state.route === 'gamesBlackjack') loadBlackjack();
  }

  function filterRows(value) {
    const needle = value.replace(/\s/g, '').toLocaleLowerCase('ko-KR');
    let visible = 0;
    document.querySelectorAll('.game-stock-list li').forEach(row => {
      const match = !needle || row.dataset.gameName.includes(needle);
      row.hidden = !match;
      if (match) visible++;
    });
    const none = document.querySelector('[data-game-no-match]');
    if (none) none.hidden = visible > 0;
  }

  function bindChart() {
    const figure = document.querySelector('[data-game-chart]');
    if (!figure) return;
    const points = JSON.parse(figure.dataset.points || '[]'), start = Number(figure.dataset.start);
    const svg = figure.querySelector('svg'), tip = figure.querySelector('[data-game-chart-tip]'), cursor = figure.querySelector('[data-game-chart-cursor]');
    if (!points.length) return;
    svg.addEventListener('pointermove', event => {
      const rect = svg.getBoundingClientRect();
      const target = start + (event.clientX - rect.left) / rect.width * CHART_MS;
      const nearest = points.reduce((best, p) => Math.abs(p[0] - target) < Math.abs(best[0] - target) ? p : best, points[0]);
      const x = 8 + (320 - 16) * (nearest[0] - start) / CHART_MS;
      cursor.setAttribute('x1', x); cursor.setAttribute('x2', x); cursor.setAttribute('visibility', 'visible');
      tip.hidden = false; tip.textContent = `${clockTime(nearest[0])} · ${point(nearest[1])}`;
    });
    svg.addEventListener('pointerleave', () => { tip.hidden = true; cursor.setAttribute('visibility', 'hidden'); });
  }

  function bind() {
    if (!isGameRoute(state.route)) return;
    document.querySelectorAll('[data-game-refresh]').forEach(button => button.addEventListener('click', () => {
      news.status = news.status === 'loading' ? 'loading' : 'idle';
      chart.key = '';
      loadMarket();
      if (state.route === 'gamesStock') loadNews();
    }));
    document.querySelectorAll('[data-game-tab]').forEach(button => button.addEventListener('click', () => {
      tab = button.dataset.gameTab; render();
      document.querySelector(`[data-game-tab="${tab}"]`)?.focus();
    }));
    const search = document.querySelector('[data-game-search]');
    if (search) {
      search.addEventListener('input', () => { query = search.value; filterRows(query); });
      if (query) filterRows(query);
    }
    document.querySelector('[data-game-sort]')?.addEventListener('change', event => { sort = event.target.value; render(); document.querySelector('[data-game-sort]')?.focus(); });
    document.querySelectorAll('[data-game-favorite]').forEach(button => button.addEventListener('click', () => {
      toggleFavorite(button.dataset.gameFavorite);
      document.querySelector(`[data-game-favorite="${button.dataset.gameFavorite}"]`)?.focus();
    }));
    document.querySelectorAll('[data-game-stock]').forEach(button => button.addEventListener('click', () => {
      state.gameStockId = button.dataset.gameStock;
      note = null;
      navigateTo('gamesStockDetail');
      window.scrollTo(0, 0);
    }));
    document.querySelectorAll('[data-game-trade]').forEach(button => button.addEventListener('click', () => openTrade(button.dataset.gameTrade)));
    document.querySelector('[data-game-retry]')?.addEventListener('click', () => { if (!tradeBusy) retryTrade(); });
    document.querySelectorAll('[data-bj]').forEach(button => button.addEventListener('click', () => sendBlackjack(button.dataset.bj)));
    document.querySelector('[data-bj-reload]')?.addEventListener('click', () => { bj.status = 'idle'; render(); });
    document.querySelector('[data-bj-ok]')?.addEventListener('click', () => {
      clearTimeout(revealTimer); bj.reveal = null; render();
      document.querySelector('[data-bj="join"], [data-bj="rematch"]')?.focus();
    });
    bindChart();
    if (state.route === 'gamesBlackjack') schedulePoll();
    tick();
  }

  return { view, bind, load, isGameRoute, handTotal, revealOrder };
})();
if (typeof module === 'object' && module.exports) module.exports = festivalGames;
