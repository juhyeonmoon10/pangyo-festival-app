const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const feedback = source.slice(source.indexOf('function dismissNfcFeedback()'), source.indexOf('function refreshVisitIndicators()'));
function setup({ reviewed = false, type = 'success' } = {}) {
  const nodes = [], calls = [];
  const state = { user: { id: 'student' }, db: { booths: [{ id: 'booth', name: '<부스>' }] },
    scanResult: { type, boothId: 'booth', title: reviewed ? '스탬프가 완성됐어요' : '방문 인증 완료', body: '기존 방문 기록을 그대로 유지했어요.' } };
  const document = {
    querySelector: () => nodes.find(n => !n.removed) || null,
    body: { append: node => nodes.push(node) },
    createElement(tag) {
      const listeners = {}, buttons = {};
      return { tag, attrs: {}, open: false, removed: false, listeners, buttons,
        setAttribute(key, value) { this.attrs[key] = value; },
        querySelector(selector) { return buttons[selector] ||= { addEventListener: (event, fn) => { buttons[selector][event] = fn; } }; },
        addEventListener(event, fn) { listeners[event] = fn; },
        showModal() { this.open = true; },
        close() { this.open = false; calls.push('close'); listeners.close?.(); },
        remove() { this.removed = true; },
      };
    },
  };
  const ctx = vm.createContext({ state, document, repo: { hasReview: () => reviewed },
    icon: () => '<svg></svg>', escapeHtml: value => String(value).replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    openBoothReview: id => calls.push(['review', id]),
    runActionOnce: (key, fn) => { calls.push(key); fn(); }, nfcAdapter: { scan: claim => calls.push(claim) },
    setTimeout: () => { throw Error('Completion must not auto-dismiss'); },
  });
  vm.runInContext(feedback, ctx);
  return { state, document, nodes, calls, show: () => vm.runInContext('showNfcFeedback()', ctx), dismiss: () => vm.runInContext('dismissNfcFeedback()', ctx) };
}

test('visit completion is an accessible modal with rating CTA and escaped booth name', () => {
  const api = setup(); api.show(); const node = api.nodes[0];
  assert.equal(node.tag, 'dialog'); assert.equal(node.open, true);
  assert.equal(node.attrs['aria-labelledby'], 'nfcFeedbackTitle');
  assert.equal(node.attrs['aria-describedby'], 'nfcFeedbackDescription');
  assert.match(node.innerHTML, /&lt;부스&gt;/); assert.match(node.innerHTML, /별점 남기기/);
  assert.match(node.innerHTML, /나중에/);
});
test('rated visit has explicit confirmation instead of an automatic timeout', () => {
  const api = setup({ reviewed: true }); api.show();
  assert.match(api.nodes[0].innerHTML, /스탬프가 완성됐어요/);
  assert.match(api.nodes[0].innerHTML, />확인</); assert.doesNotMatch(api.nodes[0].innerHTML, /별점 남기기/);
});
test('repeated scans replace, never stack, the modal', () => {
  const api = setup(); api.show(); api.show();
  assert.equal(api.nodes.filter(n => !n.removed).length, 1); assert.equal(api.nodes[0].open, false);
});
test('close and native cancel clean up the modal', () => {
  const api = setup(); api.show(); let prevented = false;
  api.nodes[0].listeners.cancel({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(api.nodes[0].removed, true);
  api.show(); api.nodes[1].buttons['.feedback-close'].onclick(); assert.equal(api.nodes[1].removed, true);
});
test('rating action closes feedback before opening the existing review form', () => {
  const api = setup(); api.show(); api.nodes[0].buttons['.feedback-action'].click();
  assert.deepEqual(api.calls, ['close', ['review', 'booth']]);
});
test('duplicate visit remains a single result and explains pending rating', () => {
  const api = setup({ type: 'duplicate' }); api.show();
  assert.match(api.nodes[0].innerHTML, /이미 인증한 부스/); assert.equal(api.nodes[0].tag, 'dialog');
});
test('retryable failures retain the existing nonmodal retry action', () => {
  const api = setup({ type: 'error' }); api.state.scanResult.retryable = true;
  api.state.pendingNfcClaim = { nfcToken: 'fixture' }; api.show();
  assert.equal(api.nodes[0].tag, 'aside'); assert.match(api.nodes[0].innerHTML, /다시 시도/);
  api.nodes[0].buttons['.feedback-action'].click(); assert.deepEqual(api.calls, ['nfc-claim', api.state.pendingNfcClaim]);
});
test('signed-out users do not see stale completion feedback', () => {
  const api = setup(); api.show(); api.state.user = null; api.show();
  assert.equal(api.nodes.filter(n => !n.removed).length, 0);
});
test('closing restores the same input and its original selection without scrolling', () => {
  const api = setup(); const restored = [];
  api.document.activeElement = { isConnected: true, selectionStart: 2, selectionEnd: 4, selectionDirection: 'forward',
    focus: options => restored.push(options.preventScroll), setSelectionRange: (...args) => restored.push(args) };
  api.show(); api.dismiss(); assert.deepEqual(restored, [true, [2, 4, 'forward']]);
});
