const {test}=require('node:test');
const assert=require('node:assert/strict');
const router=require('../festival-router.js');
const games=require('../festival-games.js');

test('minigame screens have their own URLs and stock ids cannot inject routes',()=>{
  assert.deepEqual(router.parse('/games'),{route:'games'});
  assert.deepEqual(router.parse('/games/stock/'),{route:'gamesStock'});
  assert.deepEqual(router.parse('/games/blackjack'),{route:'gamesBlackjack'});
  const detail={route:'gamesStockDetail',gameStockId:'12'};
  assert.deepEqual(router.parse(router.pathname(detail)),detail);
  for(const path of ['/games/stock/0','/games/stock/-1','/games/stock/1a','/games/stock/%2Fadmin','/games/stock/1/2','/games/stock/99999999999']) assert.equal(router.parse(path),null);
  assert.equal(router.pathname({route:'gamesStockDetail',gameStockId:'../admin'}),'/games/stock');
  for(const path of ['/games','/games/stock','/games/stock/7','/games/blackjack/']) assert.ok(new RegExp(`^${router.pagePattern}$`).test(path),path);
  assert.deepEqual(router.safeReturn('/games/blackjack'),{route:'gamesBlackjack'});
});

test('blackjack totals match private.blackjack_total (aces drop from 11 to 1 only when needed)',()=>{
  const card=(rank,suit=0)=>suit*13+rank;
  assert.equal(games.handTotal([card(0),card(12)]),21);
  assert.equal(games.handTotal([card(0),card(0,1)]),12);
  assert.equal(games.handTotal([card(0),card(8),card(9)]),20);
  assert.equal(games.handTotal([card(9),card(10),card(11)]),30);
  assert.equal(games.handTotal([]),0);
});

test('the final reveal alternates opponent and player cards',()=>{
  const order=games.revealOrder({myCards:[1,2,3],opponentCards:[null,null]});
  assert.deepEqual(order,[['opponent',0],['me',0],['opponent',1],['me',1],['me',2]]);
});
