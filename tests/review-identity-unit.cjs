const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const {validateReviewPolicy,validateReviews,createAccount}=require('../festival-account.js');
const goodPolicy={version:1,allowed:true,reason:null,authorName:'김하늘'};
const response={boothKey:'club',count:0,average:null,myRating:null,reviews:[]};

test('missing, malformed, or unnamed server policy fails closed',()=>{
  for(const value of [undefined,{}, {...goodPolicy,version:2},{...goodPolicy,authorName:''},{...goodPolicy,allowed:'true'}]) {
    assert.equal(validateReviewPolicy(value).allowed,false);
  }
  assert.deepEqual(validateReviewPolicy(goodPolicy),goodPolicy);
  assert.equal(validateReviews(response).reviewPolicy.allowed,false);
});
test('denied policies never expose a name',()=>{
  const p=validateReviewPolicy({...goodPolicy,allowed:false,reason:'OWN_CLUB_REVIEW'});
  assert.equal(p.authorName,null);assert.equal(p.allowed,false);
});

function client(policy) {
  const calls=[];
  const rpc=async(name,args)=>{calls.push({name,args});return {data:{...response,reviewPolicy:policy}};};
  const account=createAccount({sdk:{createClient:()=>({rpc,auth:{onAuthStateChange(){}}})},
    config:{},storage:{getItem(){},setItem(){},removeItem(){}},location:new URL('https://fixture.invalid')});
  return {account,calls};
}
test('old server and own-club denial never fall back to an unguarded write',async()=>{
  for(const policy of [undefined,{version:1,allowed:false,reason:'OWN_CLUB_REVIEW',authorName:null}]) {
    const {account,calls}=client(policy),r=await account.submitReview('club',5,'후기');
    assert.equal(r.ok,false);
    assert.ok(calls.every(c=>c.name==='festival_booth_reviews'));
  }
});

test('every write refreshes server membership and never supplies an author or user ID',async()=>{
  const before=globalThis.FestivalOperations,writes=[];
  let policy=goodPolicy;
  globalThis.FestivalOperations={create:()=>({
    read:async()=>({ok:true,data:{...response,reviewPolicy:policy}}),
    write:async(action,payload)=>{writes.push({action,payload});return{ok:true,data:{...response,result:'SAVED',reviewPolicy:policy}};},
  })};
  try {
    const {account}=client();
    assert.equal((await account.submitReview('club',5,'후기')).ok,true);
    assert.deepEqual(writes,[{action:'review_save',payload:{booth:'club',rating:5,content:'후기'}}]);
    policy={version:1,allowed:false,reason:'OWN_CLUB_REVIEW',authorName:null};
    assert.equal((await account.submitReview('club',5,'후기')).code,'OWN_CLUB_REVIEW');
    assert.equal(writes.length,1);
  } finally {globalThis.FestivalOperations=before;}
});

function app() {
  const node={dataset:{},classList:{toggle(){}},querySelector:()=>null,innerHTML:''},inputs=new Map();
  const storage=()=>{const map=new Map();return{getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};};
  const context=vm.createContext({URL,URLSearchParams,TextEncoder,TextDecoder,structuredClone,atob,btoa,crypto:webcrypto,
    location:new URL('https://fixture.invalid/?demo=1'),localStorage:storage(),sessionStorage:storage(),
    history:{state:null,replaceState(){},pushState(){}},
    document:{querySelector:s=>s==='#app'?node:inputs.get(s)||null,querySelectorAll:()=>[],getElementById:()=>null,addEventListener(){},body:{}},
    addEventListener(){},setTimeout:()=>0,clearTimeout(){},clearInterval(){},setInterval:()=>0,queueMicrotask,
    FestivalCatalog:{CLUB_IDS:{},createClient:()=>({getSnapshot:()=>({status:'ready',rows:[]}),forClub:()=>null,subscribe(){},refresh(){}})},
    fetch(){throw Error('No network permitted');}});
  context.window=context;
  for(const f of ['assets/vendor/ui-icons.js','web-experience.js','nfc-manager.js','operations-ui.js','app.js']) vm.runInContext(fs.readFileSync(path.join(__dirname,'..',f),'utf8'),context,{filename:f});
  const api=vm.runInContext('({state,reviewEligibility,reviewForm,reviewView,submitReview,web:festivalWeb})',context);
  api.state.user={...api.state.db.users[0],id:'synthetic',name:'Editable alias'};
  api.state.selectedBoothId=api.state.db.booths[0].id;
  api.state.db.reviews=[];
  api.state.db.stamps=[{id:'visit',userId:'synthetic',boothId:api.state.selectedBoothId,status:'active'}];
  api.state.db.reviewIdentities=[{userId:'synthetic',verified:true,realName:'김하늘',boothIds:[]}];
  inputs.set('#reviewContent',{value:'좋았어요',addEventListener(){}});inputs.set('#reviewFeedback',{textContent:'',dataset:{}});
  return {...api,inputs};
}
test('own-club form locks stars, text and submission even for admins',()=>{
  const a=app();a.state.user.role='admin';a.state.db.reviewIdentities[0].boothIds=[a.state.selectedBoothId];
  const html=a.reviewForm({enabled:true,message:'Available'});
  assert.equal((html.match(/data-rating="\d"[^>]*disabled/g)||[]).length,5);
  assert.match(html,/<textarea[^>]*disabled/);assert.match(html,/id="submitReview"[^>]*disabled/);
  assert.match(html,/본인 동아리/);
});
test('verified roster and published author are independent of editable profile name',async()=>{
  const a=app();a.state.reviewRating=5;
  assert.match(a.reviewForm({enabled:true,message:''}),/김하늘 이름으로 공개/);
  await a.submitReview();assert.equal(a.state.db.reviews[0].authorName,'김하늘');
  a.state.user.name='Changed alias';assert.match(a.reviewView(a.state.db.reviews[0]),/김하늘/);
  assert.doesNotMatch(a.reviewView(a.state.db.reviews[0]),/Changed alias|21001|@/);
});
test('handler rejects forged own-club rating and later text writes',async()=>{
  const a=app();a.state.reviewRating=5;a.state.db.reviewIdentities[0].boothIds=[a.state.selectedBoothId];
  await a.submitReview();assert.equal(a.state.db.reviews.length,0);
  a.state.db.reviews.push({userId:'synthetic',boothId:a.state.selectedBoothId,rating:5,content:''});
  await a.submitReview();assert.equal(a.state.db.reviews[0].content,'');
});
test('unknown membership does not trust account name or editable club',()=>{
  const a=app();a.state.db.reviewIdentities=[];a.state.user.club='Different club';
  assert.equal(a.reviewEligibility(a.state.selectedBoothId).reason,'REVIEW_IDENTITY_REQUIRED');
});
test('own-club visits earn stamps but never become pending reviews',()=>{
  const a=app();a.state.db.reviewIdentities[0].boothIds=[a.state.selectedBoothId];
  assert.equal(a.web.waiting().length,0);assert.equal(a.web.completed().length,1);
  assert.equal(a.web.reviewPending(a.state.db.booths[0]),false);
  assert.match(a.web.stamps(),/소속 동아리 · 리뷰 제외/);
  assert.doesNotThrow(()=>a.web.reviews());
});
test('old anonymous names stay anonymous and new author markup is escaped',()=>{
  const a=app(),r={userId:'synthetic',rating:5,content:'',createdAt:'2026-10-28T01:00:00Z'};
  assert.match(a.reviewView(r),/참여자/);
  assert.match(a.reviewView({...r,authorName:'<script>x</script>'}),/&lt;script&gt;/);
});

function rosterClient(data) {
  return createAccount({sdk:{createClient:()=>({rpc:async()=>({data}),auth:{onAuthStateChange(){}}})},
    config:{},storage:{getItem(){},setItem(){},removeItem(){}},location:new URL('https://fixture.invalid')});
}
// Accounts are named by 학번 and email; an account number in the response fails closed.
const rosterResponse={eventId:'event',account:{studentNumber:'21001',email:'student@example.invalid'},accountName:'가상계정',realName:null,boothKeys:[],verified:false,version:0,
  roster:{studentNumber:'11001',realName:'가상학생',clubs:['동아리'],boothKeys:['club'],version:1,ready:true,linkedElsewhere:false}};
const lookup={eventId:'event',account:{studentNumber:'21001'},studentNumber:'11001'};
test('official roster response validates exact number, version and readiness types',async()=>{
  assert.equal((await rosterClient(rosterResponse).reviewIdentity('lookup',lookup)).ok,true);
  for(const roster of [{...rosterResponse.roster,studentNumber:'11002'},{...rosterResponse.roster,version:0},
    {...rosterResponse.roster,ready:'true'},{...rosterResponse.roster,realName:null},{...rosterResponse.roster,clubs:[]}]) {
    assert.equal((await rosterClient({...rosterResponse,roster}).reviewIdentity('lookup',lookup)).ok,false);
  }
});
test('a response carrying an account number or no account fails closed',async()=>{
  assert.equal((await rosterClient({...rosterResponse,userId:2}).reviewIdentity('lookup',lookup)).ok,false);
  const none={...rosterResponse};delete none.account;
  assert.equal((await rosterClient(none).reviewIdentity('lookup',lookup)).ok,false);
});
test('missing old roster contract fails closed; explicit missing student is valid',async()=>{
  const old={...rosterResponse};delete old.roster;
  assert.equal((await rosterClient(old).reviewIdentity('get',lookup)).ok,false);
  assert.equal((await rosterClient({...rosterResponse,roster:null}).reviewIdentity('lookup',lookup)).ok,true);
});
test('pending official records remain readable to operators without enabling confirmation',async()=>{
  const data={...rosterResponse,roster:{...rosterResponse.roster,realName:null,ready:false}};
  const result=await rosterClient(data).reviewIdentity('lookup',lookup);
  assert.equal(result.ok,true);assert.equal(result.data.roster.ready,false);
});
