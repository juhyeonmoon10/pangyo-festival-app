const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const block=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
function setup() {
  const readers=[],calls=[];
  class Reader { constructor(){readers.push(this);} async scan(options){this.signal=options.signal;} }
  const state={user:{id:'operator',role:'admin'},route:'admin',loginBusy:false};
  const context=vm.createContext({state,serverAdmin:{tagReading:false},AbortController,TextDecoder,URLSearchParams,
    isServerMode:()=>true,isAdminUser:()=>state.user?.role==='admin',render(){},loadServerTags:async()=>{},
    tagBoothName:()=> 'Synthetic booth',document:{querySelector:()=>null},
    NDEFReader:Reader,window:{isSecureContext:true,NDEFReader:Reader,FestivalAccount:{TOKEN_PATTERN:/^nf1\.fixture\.[a-f0-9]{64}$/}},
    festivalAccount:{nfcTags:async(...args)=>{calls.push(args);return {ok:true,added:true,boothKey:'fixture'};},signOut:async()=>({}),savePending(){}},
    nfcManagement:{hasDrafts:()=>false,clear(){}},serverCompletedBooths:[],serverMyReviews:null,serverReviews:new Map(),
    dismissNfcFeedback(){},signInStartedAt:0,consumePendingNfc(){},loadMyReviews(){},
  });
  vm.runInContext(block('function extractTagToken(', 'function issuedTagsSection('),context);
  vm.runInContext(block('async function resetLogin()', '// Set when the sign-in tab'),context);
  vm.runInContext(block('function applyServerProfile(', 'async function initializeAccount('),context);
  const api=vm.runInContext('({toggleServerTagReading,stopServerTagReading,registerServerTag,resetLogin,applyServerProfile})',context);
  return {context,state,readers,calls,...api};
}
const token='nf1.fixture.'+'a'.repeat(64);
const tap=reader=>reader.onreading({message:{records:[{recordType:'url',data:new TextEncoder().encode(`https://fixture.invalid/nfc#t=${token}`)}]}});
test('logout aborts the hardware reader and ignores late card callbacks',async()=>{
  const a=setup();await a.toggleServerTagReading();assert.equal(a.readers.length,1);
  await a.resetLogin();assert.equal(a.readers[0].signal.aborted,true);
  tap(a.readers[0]);a.readers[0].onreadingerror();await Promise.resolve();
  assert.equal(a.calls.length,0);assert.equal(a.state.user,null);
});
test('account changes and removed administrator rights stop NFC reading',async()=>{
  for(const profile of [null,{authUserId:'operator',id:1,isAdmin:false},{authUserId:'different',id:2,isAdmin:true}]) {
    const a=setup();await a.toggleServerTagReading();a.applyServerProfile(profile);
    assert.equal(a.readers[0].signal.aborted,true);
  }
});
test('students and signed-out callers cannot start a reader or register a card',async()=>{
  for(const user of [null,{id:'student',role:'user'}]) {
    const a=setup();a.state.user=user;await a.toggleServerTagReading();
    assert.equal(await a.registerServerTag(token),false);
    assert.equal(a.readers.length,0);assert.equal(a.calls.length,0);
  }
});
test('stopping invalidates an in-flight registration even for the same account',async()=>{
  const a=setup();let resolve;
  a.context.festivalAccount.nfcTags=()=>new Promise(r=>{resolve=r;});
  const pending=a.registerServerTag(token);a.stopServerTagReading();
  resolve({ok:true,added:true,boothKey:'fixture'});
  assert.equal(await pending,false);assert.notEqual(a.context.serverAdmin.registerTone,'success');
});
test('a rejected registration is handled without an unhandled promise rejection',async()=>{
  const a=setup();a.context.festivalAccount.nfcTags=async()=>{throw Error('offline');};
  assert.equal(await a.registerServerTag(token),false);assert.equal(a.context.serverAdmin.registerTone,'error');
});
