const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup({ count = 0, pending = 0, server = false, rewardProgram = null, name = 'Test booth' } = {}) {
  const records = new Map();
  let nextId=0;
  const booths = Array.from({ length: 25 }, (_, i) => ({ id: `booth-${i}`, name: i ? `Booth ${i}` : name, location: '2F' }));
  const visits = booths.slice(0, count + pending).map(b => ({ boothId: b.id, userId: 'fixture' }));
  const reviews = booths.slice(0, count).map(b => ({ boothId: b.id, userId: 'fixture', rating: 5, content: '' }));
  const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const context = vm.createContext({
    state: { user: { id: 'fixture' }, db: { booths, reviews } },
    repo: { stampsForUser: () => visits, hasReview: (_id, boothId) => reviews.some(r => r.boothId === boothId) },
    isServerMode: () => server, festivalOpsUI: { snapshot: () => rewardProgram ? { rewardProgram } : null },
    reviewEligibility: () => ({ allowed: true, authorName: 'Fixture' }),
    readSessionStorage: key => records.get(key), writeSessionStorage: (key, value) => { records.set(key, value); return true; },
    escapeHtml, icon: key => `<svg data-icon="${key}" aria-hidden="true"></svg>`,
    catalogBooth: () => null, clubVisual: () => '', bottomNav: () => '<nav>Navigation</nav>',
    makeId: () => `coupon-${++nextId}`, formatTime: () => '',
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../web-experience.js'), 'utf8'), context);
  return { api: vm.runInContext('festivalWeb', context), visits, reviews, records };
}

test('empty scrollable board has one next stamp, numbered slots and zero progress', () => {
  const { api } = setup();
  const html = api.stamps();
  assert.equal((html.match(/class="stamp-path-step /g) || []).length, 15);
  assert.equal((html.match(/aria-current="step"/g) || []).length, 1);
  assert.match(html, /class="stamp-path-node" data-route="map"/);
  assert.match(html, /max="3" value="0"/);
  assert.match(html, /<h1>스탬프<\/h1>/);
  assert.match(html, /<b>1<\/b>/);
  assert.doesNotMatch(html, /web-stamp-grid|web-stamp-cell/);
});

test('rated visits alone become completed nodes; the next action opens a pending review', () => {
  const { api, visits, reviews } = setup({ count: 3, pending: 2 });
  const html = api.stamps();
  assert.equal((html.match(/stamp-path-step is-earned/g) || []).length, 3);
  assert.match(html, /class="stamp-path-node" data-review-booth="booth-3"/);
  assert.match(html, /max="3" value="3"/);
  assert.equal(visits.length, 5);
  assert.equal(reviews.length, 3);
});

test('completed nodes retain booth navigation and escape long or HTML-like names', () => {
  const { api } = setup({ count: 1, name: '<script>Test & long booth name</script>' });
  const html = api.stamps();
  assert.match(html, /data-list-select="booth-0"/);
  assert.match(html, /&lt;script&gt;Test &amp; long booth name&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('five stamps do not auto-pick a reward; a confirmed choice grants only one', async () => {
  const { api } = setup({ count: 5 });
  const html = api.stamps();
  assert.match(html, /max="3" value="2"/);
  assert.equal((html.match(/class="stamp-reward-marker"/g) || []).length, 5);
  assert.doesNotMatch(html, /stamp-path-chapter|stamp-path-milestone/);
  assert.equal(api.coupons().length, 0);
  assert.equal((await api.chooseReward('photo')).ok,true);
  assert.equal(api.coupons().length, 1);
  assert.equal(api.coupons()[0].title,'포토부스 이용권');
  api.stamps();
  assert.equal(api.coupons().length, 1);
});

test('ten and thirteen stamps retain visits and unlock the next choice after the first pair', async () => {
  for (const count of [10, 13]) {
    const { api } = setup({ count });
    const html = api.stamps();
    assert.equal((html.match(/class="stamp-path-step /g) || []).length, Math.max(15,Math.ceil((count+1)/3)*3));
    assert.equal((html.match(/stamp-path-step is-earned/g) || []).length, count);
    assert.equal((html.match(/aria-current="step"/g) || []).length, 1);
    assert.equal(api.coupons().length, 0);
    await api.chooseReward('food');
    api.syncRewards();
    assert.equal(api.coupons().length, 2);
    assert.equal(api.rewardState().firstTarget,9);
    await api.chooseReward('photo',9);
    assert.equal(api.coupons().length,count>=12?4:3);
    await api.chooseReward('photo',9);
    assert.equal(api.coupons().length,count>=12?4:3);
  }
});

test('three stamps choose one, then the sixth grants the opposite even after use', async () => {
  for(const kind of ['photo','food']) {
    const {api,visits,reviews,records}=setup({count:3});
    assert.equal((await api.chooseReward(kind)).ok,true);
    assert.equal((await api.chooseReward(kind)).ok,true);
    assert.equal((await api.chooseReward(kind==='photo'?'food':'photo')).ok,false);
    assert.equal(api.coupons().length,1);
    const value=JSON.parse(records.get('festival-web-demo:fixture'));
    value.coupons[0].redeemedAt='2026-10-28T01:00:00Z';
    records.set('festival-web-demo:fixture',JSON.stringify(value));
    for(let i=3;i<6;i++){visits.push({boothId:`booth-${i}`,userId:'fixture'});reviews.push({boothId:`booth-${i}`,userId:'fixture',rating:5,content:''});}
    api.syncRewards();api.syncRewards();
    assert.equal(api.coupons().length,2);
    assert.equal(new Set(api.coupons().map(c=>c.kind)).size,2);
    assert.equal(new Set(api.coupons().map(c=>c.id)).size,2);
    assert.equal(api.rewardState().firstChoice,null);
    assert.equal(api.rewardState().firstTarget,9);
    assert.equal(api.rewardState().issuedCount,2);
    assert.equal((await api.chooseReward(kind,3)).ok,true);
    assert.equal(api.coupons().length,2);
  }
});
test('late choice at six grants both, but below three never grants anything',async()=>{
  for(const count of [0,1,2]) {const {api}=setup({count});assert.equal((await api.chooseReward('photo')).ok,false);assert.equal(api.coupons().length,0);}
  const {api}=setup({count:6});await api.chooseReward('photo');assert.equal(api.coupons().length,2);
  assert.equal((await api.chooseReward('cash')).ok,false);
});
test('legacy demo coupons are preserved, never counted as the new selection',async()=>{
  const {api,records}=setup({count:3});
  records.set('festival-web-demo:fixture',JSON.stringify({points:{},coupons:[{id:'old',target:5,title:'Historical'}]}));
  api.syncRewards();assert.equal(api.rewardState().firstChoice,null);
  await api.chooseReward('food');assert.equal(api.coupons().length,2);
  assert.ok(api.coupons().some(c=>c.id==='old'));
});

test('server path keeps every third milestone visible without fabricating issuance or writes', () => {
  const { api, records } = setup({ count: 5, server: true });
  const html = api.stamps();
  assert.equal((html.match(/class="stamp-reward-marker"/g)||[]).length,5);
  assert.match(html,/3개마다 1장/);
  assert.match(html,/3번째 스탬프, 확인 대기/);
  assert.doesNotMatch(html, /is-issued|is-claimable|받기 가능|지급 완료|체험 바우처|작은 선물/);
  assert.match(html, /data-route="vouchers"/);
  assert.equal(records.size, 0);
});

test('missing, failed and unconfigured reward snapshots never erase milestone markers',()=>{
  for(const rewardProgram of [null,{ready:false},{ready:false,supported:false},{ready:false,firstTarget:9,firstChoice:'photo',secondIssued:true}]) {
    for(const count of [0,3,6,9,12]) {
      const {api,records}=setup({count,server:true,rewardProgram});
      const html=api.stamps();
      assert.equal((html.match(/class="stamp-reward-marker"/g)||[]).length,5);
      assert.match(html,/max="3" value="[0-3]"/);
      assert.doesNotMatch(html,/is-issued|is-claimable|받기 가능|지급 완료/);
      assert.match(api.rewardPanel(),/3개마다 1장/);
      assert.match(api.rewardPanel(),/data-ops-refresh/);
      assert.doesNotMatch(api.rewardPanel(),/rewardChoiceForm|data-reward-retry/);
      assert.equal(records.size,0);
    }
  }
});

test('stamp board has a serpentine grid and benefits stay inside vouchers', () => {
  for(const count of [0,3,6,10]) {
    const {api}=setup({count});
    const html=api.stamps(),nodes=Math.max(15,Math.ceil((count+1)/3)*3);
    assert.equal((html.match(/<ol class="stamp-path-list"/g)||[]).length,1);
    assert.equal((html.match(/class="stamp-path-link(?: is-turn)?"/g)||[]).length,nodes-1);
    assert.equal((html.match(/class="stamp-reward-marker"/g)||[]).length,Math.floor(nodes/3));
    assert.equal((html.match(/data-route="vouchers"/g)||[]).length,1+Math.floor(count/3));
    assert.match(html,/grid-row:2;grid-column:3/);
    assert.match(html,/grid-row:2;grid-column:1/);
    assert.doesNotMatch(html,/스탬프 \d+~\d+|설레는 첫 발걸음|축제를 더 가까이/);
    assert.doesNotMatch(html,/reward-choice-section|rewardChoiceForm|스탬프 혜택|stamp-chapter|첫 번째 바우처 선택|나머지 바우처 지급/);
    assert.match(api.vouchers(),/rewardChoiceForm/);
  }
});

test('every three stamps repeats with per-stage idempotency and no skipped choices',async()=>{
  const {api}=setup({count:18});
  assert.equal((await api.chooseReward('food',9)).ok,false);
  for(const target of [3,9,15]) {
    assert.equal((await api.chooseReward('photo',target)).ok,true);
    assert.equal((await api.chooseReward('photo',target)).ok,true);
    assert.equal((await api.chooseReward('food',target)).ok,false);
  }
  assert.equal(api.coupons().length,6);
  assert.equal(new Set(api.coupons().map(c=>c.target)).size,6);
  assert.deepEqual(Array.from(api.coupons().map(c=>c.target)).sort((a,b)=>a-b),[3,6,9,12,15,18]);
  assert.equal(api.rewardState().firstTarget,21);
});

test('upcoming slots are not fake buttons and layout styles honor reduced motion', () => {
  const html = setup().api.stamps();
  assert.equal((html.match(/<button[^>]+class="stamp-path-node"/g) || []).length, 1);
  const css = fs.readFileSync(path.join(__dirname, '../web-redesign.css'), 'utf8');
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /stamp-path-node:focus-visible/);
});

test('ink stamps distinguish claimable, issued and future reward milestones', async () => {
  const { api, records } = setup({ count: 9 });
  let html = api.stamps();
  assert.equal((html.match(/is-claimable/g) || []).length, 1);
  assert.equal((html.match(/is-issued/g) || []).length, 0);
  assert.match(html, /3번째 스탬프, 받기 가능/);
  assert.match(html, /<b>3<\/b><svg data-icon="ticket"/);
  assert.match(html, /9번째 스탬프, 바우처 확인/);
  await api.chooseReward('photo', 3);
  html = api.stamps();
  assert.equal((html.match(/is-issued/g) || []).length, 2);
  assert.match(html, /9번째 스탬프, 받기 가능/);
  await api.chooseReward('food', 9);
  const value = JSON.parse(records.get('festival-web-demo:fixture'));
  value.coupons[0].state = 'void';
  value.coupons[1].redeemedAt = '2026-10-28T01:00:00Z';
  value.coupons[2].expiresAt = '2020-01-01T00:00:00Z';
  records.set('festival-web-demo:fixture', JSON.stringify(value));
  html = api.stamps();
  assert.equal((html.match(/is-issued/g) || []).length, 3);
  assert.equal((html.match(/is-claimable/g) || []).length, 0);
  assert.match(html, /max="3" value="0"/);
  assert.match(html, /다음 바우처까지 3개/);
});

test('server snapshot drives received indicators without fabricating local rewards', () => {
  const { api, records } = setup({ count: 9, server: true, rewardProgram: {
    ready:true, count:9, firstTarget:9, secondTarget:12, firstChoice:null, secondIssued:false,
  } });
  const html = api.stamps();
  assert.equal((html.match(/is-issued/g) || []).length, 2);
  assert.equal((html.match(/is-claimable/g) || []).length, 1);
  assert.match(html, /9번째 스탬프, 받기 가능/);
  assert.equal(records.size, 0);
});

test('completed visit history is collapsed but its detail and review actions remain', () => {
  const html = setup({ count: 4 }).api.stamps();
  assert.match(html, /<details class="stamp-visit-history"><summary>/);
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
  assert.match(html, /data-route="reviews"/);
  assert.match(html, /data-review-booth="booth-3"/);
});

test('operator preview reuses the ink board without live navigation or reward actions', () => {
  const { api, records, visits } = setup({ count: 3 });
  const html = api.previewStamps(visits, {ready:true,count:3,firstTarget:3,secondTarget:6,firstChoice:null,secondIssued:false});
  assert.match(html, /모의 스탬프판/);
  assert.equal((html.match(/stamp-path-step is-earned/g) || []).length, 3);
  assert.doesNotMatch(html, /<button|data-route|data-list-select|data-review-booth/);
  assert.equal(records.size, 0);
});
