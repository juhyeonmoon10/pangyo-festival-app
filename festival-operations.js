(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FestivalOperations = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const messages = {
    AUTH_REQUIRED: '다시 로그인해 주세요.', GOOGLE_AUTH_REQUIRED: 'Google 계정으로 다시 로그인해 주세요.',
    ADMIN_REQUIRED: '운영자만 사용할 수 있어요.', PROFILE_REQUIRED: '학번 등록을 완료해 주세요.',
    OPS_NOT_READY: '운영 기능 설치와 행사 설정이 필요해요.', EVENT_CLOSED: '행사가 종료되었거나 운영을 준비 중이에요.',
    INVALID_INPUT: '입력한 내용을 확인해 주세요.', NOT_FOUND: '대상을 찾을 수 없어요.',
    BOOTH_CLOSED: '현재 방문을 승인할 수 없는 부스예요.', VISIT_REQUIRED: '방문 인증 후 평가할 수 있어요.',
    ALREADY_REVIEWED: '이미 등록한 별점은 변경할 수 없어요.',
    REQUEST_CONFLICT: '이전 요청과 내용이 달라요. 화면을 새로고침해 주세요.',
    POINTS_INSUFFICIENT: '포인트 잔액이 부족해요.', SELF_ADJUSTMENT: '본인 포인트는 직접 조정할 수 없어요.',
    VOUCHER_USED: '이미 사용한 바우처예요.', VOUCHER_EXPIRED: '만료된 바우처예요.', VOUCHER_VOID: '취소된 바우처예요.',
    VOUCHER_INVALID: '유효한 바우처 QR이 아니에요.', SELF_REDEMPTION: '본인 바우처는 다른 운영자에게 확인받아 주세요.',
    OUT_OF_STOCK: '발급 가능한 수량이 모두 소진되었어요.', VERSION_CONFLICT: '다른 운영자가 먼저 변경했어요. 새로고침 후 확인해 주세요.',
    NFC_TAG_INVALID: '유효한 NFC 태그가 아니에요.', NFC_TAG_EXPIRED: '교체되었거나 만료된 태그예요.', NFC_DISABLED: '방문 인증이 중지되었어요.',
  };
  const readKinds = new Set(['catalog', 'me', 'reviews', 'dashboard', 'participants', 'visits', 'ledger', 'rules', 'vouchers', 'audit', 'voucher_check']);
  const writeKinds = new Set(['event_save', 'booth_save', 'claim', 'visit_approve', 'review_save', 'points_adjust', 'rule_save', 'voucher_issue', 'voucher_claim', 'voucher_qr', 'voucher_redeem', 'voucher_void']);
  function error(value) {
    const found = Object.keys(messages).find(key => String(value?.message || '').includes(key));
    const code = found || (value?.code === 'PGRST202' ? 'OPS_NOT_READY' : ['23514','23502','22P02','22007'].includes(value?.code) ? 'INVALID_INPUT' : 'NETWORK_ERROR');
    return { ok: false, code, message: messages[code] || '응답을 확인하지 못했어요. 같은 내용으로 다시 시도해 주세요.', retryable: code === 'NETWORK_ERROR' };
  }
  function validate(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('INVALID_RESPONSE');
    return value;
  }
  function create({ rpc, storage, actor, uuid = () => crypto.randomUUID() }) {
    const inFlight = new Map();
    const pending = new Map();
    const keyFor = id => `festival-ops-pending:${id}`;
    function restore(id) {
      if (pending.has(id)) return pending.get(id);
      let stored = {};
      try { stored = JSON.parse(storage?.getItem(keyFor(id)) || '{}'); } catch { /* Optional session storage. */ }
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) stored = {};
      pending.set(id, stored);
      return stored;
    }
    function persist(id, values) {
      try { storage?.setItem(keyFor(id), JSON.stringify(values)); } catch { /* In-memory retries still retain keys. */ }
    }
    async function read(kind, query = {}) {
      if (!readKinds.has(kind)) return error(Error('INVALID_INPUT'));
      const id = actor();
      if (!id) return error(Error('AUTH_REQUIRED'));
      try {
        const result = await rpc('festival_ops_read', { p_kind: kind, p_query: query });
        if (actor() !== id) return error(Error('AUTH_REQUIRED'));
        if (result.error) return error(result.error);
        return { ok: true, data: validate(result.data) };
      } catch (e) { return error(e); }
    }
    function write(action, payload) {
      if (!writeKinds.has(action) || !payload || typeof payload !== 'object' || Array.isArray(payload)) return Promise.resolve(error(Error('INVALID_INPUT')));
      const id = actor();
      if (!id) return Promise.resolve(error(Error('AUTH_REQUIRED')));
      // Stable ordering makes a retry independent of form object insertion order.
      const body = Object.fromEntries(Object.entries(payload).sort(([a], [b]) => a.localeCompare(b)));
      const fingerprint = JSON.stringify([action, body]);
      const flight = `${id}:${fingerprint}`;
      if (inFlight.has(flight)) return inFlight.get(flight);
      const operation = Promise.resolve().then(async () => {
        // Store only a digest and request ID, never participant details or QR/NFC tokens.
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fingerprint))), n => n.toString(16).padStart(2,'0')).join('');
        const values = restore(id);
        const request = values[hash] || uuid();
        values[hash] = request;
        persist(id, values);
        try {
          const result = await rpc('festival_ops_write', { p_action: action, p_payload: body, p_request_id: request });
          if (actor() !== id) return error(Error('AUTH_REQUIRED'));
          if (result.error) {
            const failure = error(result.error);
            if (!failure.retryable) { delete values[hash]; persist(id, values); }
            return failure;
          }
          const data = validate(result.data);
          delete values[hash]; persist(id, values);
          return { ok: true, data };
        } catch (e) { return error(e); }
        finally { inFlight.delete(flight); }
      }).catch(e => error(e)).finally(() => inFlight.delete(flight));
      inFlight.set(flight, operation);
      return operation;
    }
    return Object.freeze({ read, write });
  }
  return { create, error };
});
