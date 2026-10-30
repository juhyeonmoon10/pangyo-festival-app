const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const ops=fs.readFileSync(path.join(__dirname,'../operations-ui.js'),'utf8');
const extract=(source,start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));

function reviewLoader() {
  const pending=[],cache=new Map();
  const context=vm.createContext({state:{user:{id:'student'},db:{booths:[{id:'b',key:'booth'}]}},
    serverReviews:cache,serverMyReviews:null,isServerMode:()=>true,boothKeyFor:b=>b.key,
    updateReviewSection(){},festivalAccount:{reviews:()=>new Promise(resolve=>pending.push(resolve))}});
  vm.runInContext(extract(app,'async function loadBoothReviews(', 'async function loadMyReviews('),context);
  return {load:context.loadBoothReviews,cache,pending};
}

test('a reply from before identity invalidation cannot restore cached review permission',async()=>{
  const a=reviewLoader(),old=a.load('b');
  a.cache.clear();
  const fresh=a.load('b');
  a.pending[1]({ok:true,reviewPolicy:{allowed:false}});await fresh;
  a.pending[0]({ok:true,reviewPolicy:{allowed:true}});await old;
  assert.equal(a.cache.get('booth').reviewPolicy.allowed,false);
});

test('a superseded refresh cannot overwrite a newer review result',async()=>{
  const a=reviewLoader(),old=a.load('b'),fresh=a.load('b',{force:true});
  a.pending[1]({ok:true,reviewPolicy:{allowed:true},count:2});await fresh;
  a.pending[0]({ok:true,reviewPolicy:{allowed:false},count:0});await old;
  assert.equal(a.cache.get('booth').count,2);
});

test('operator confirmation and revocation invalidate permissions on an open detail screen',async()=>{
  const cache=new Map(),loads=[];
  const context=vm.createContext({state:{user:{id:'student'},route:'detail',selectedBoothId:'b'},
    owner:'student',event:{id:'event'},identity:null,serverReviews:cache,
    festivalAccount:{reviewIdentitySelf:async()=>({ok:true,data:{eventId:'event',verified:true}})},
    loadBoothReviews:(...args)=>loads.push(args),document:{activeElement:null},render(){}});
  vm.runInContext(extract(ops,'  async function loadIdentity(', '  function identityRow('),context);
  for(const verified of [true,false]) {
    cache.set('booth',{reviewPolicy:{allowed:!verified}});
    context.festivalAccount.reviewIdentitySelf=async()=>({ok:true,data:{eventId:'event',verified}});
    await context.loadIdentity('student','event');
    assert.equal(cache.size,0);
    assert.equal(loads.at(-1)[0],'b');assert.equal(loads.at(-1)[1].force,true);
  }
  assert.equal(loads.length,2);
});
