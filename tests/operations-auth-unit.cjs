const {test}=require('node:test');
const assert=require('node:assert/strict');
globalThis.FestivalOperations=require('../festival-operations.js');
const {createAccount}=require('../festival-account.js');
const config=require('../supabase-catalog.js');
const profile={id:1,authUserId:'admin-fixture',name:'Admin',email:'admin@example.invalid',studentNumber:'21001',needsProfile:false,isAdmin:true,completedBooths:[]};

function setup() {
  let callback, pendingProfile, calls=0;
  const sdk={createClient:()=>({
    auth:{onAuthStateChange:cb=>{callback=cb;}},
    rpc:async name=>{
      if(name==='festival_nfc_profile') return pendingProfile ? pendingProfile : {data:profile};
      calls++; return {data:{ready:true}};
    },
  })};
  const account=createAccount({sdk,config,storage:{getItem:()=>null,setItem(){},removeItem(){}},location:new URL('https://fixture.invalid/')});
  return {account,event:(event,id)=>callback(event,id?{user:{id}}:null),calls:()=>calls,delayProfile:promise=>{pendingProfile=promise;}};
}

test('same-user SIGNED_IN recovery preserves the verified operations actor',async()=>{
  const s=setup(); await s.account.profile();
  assert.equal((await s.account.operations.read('dashboard')).ok,true);
  s.event('SIGNED_IN',profile.authUserId);
  assert.equal((await s.account.operations.read('dashboard')).ok,true);
  assert.equal((await s.account.operations.write('voucher_issue',{userId:2,ruleId:'fixture',reason:'test'})).ok,true);
  assert.equal(s.calls(),3);
});

test('token refresh keeps the actor, while signout and account switches clear it',async()=>{
  for(const [event,id] of [['SIGNED_OUT',null],['SIGNED_IN','other'],['SIGNED_IN',null],['INITIAL_SESSION','other'],['TOKEN_REFRESHED','other'],['USER_UPDATED','other']]) {
    const s=setup(); await s.account.profile();
    s.event('TOKEN_REFRESHED',profile.authUserId);
    assert.equal((await s.account.operations.read('dashboard')).ok,true);
    s.event(event,id);
    assert.equal((await s.account.operations.read('dashboard')).code,'AUTH_REQUIRED');
    assert.equal((await s.account.operations.write('voucher_issue',{})).code,'AUTH_REQUIRED');
    assert.equal(s.calls(),1);
  }
});

test('a late profile cannot revive a signed-out or switched account',async()=>{
  for(const [event,id] of [['SIGNED_OUT',null],['SIGNED_IN','other']]) {
    const s=setup(); await s.account.profile();
    let release; s.delayProfile(new Promise(resolve=>{release=resolve;}));
    const pending=s.account.profile(); s.event(event,id); release({data:profile});
    await assert.rejects(pending,/AUTH_REQUIRED/);
    assert.equal((await s.account.operations.read('dashboard')).code,'AUTH_REQUIRED');
    assert.equal(s.calls(),0);
  }
});

test('same-user session recovery does not invalidate an in-flight profile',async()=>{
  const s=setup(); await s.account.profile();
  let release; s.delayProfile(new Promise(resolve=>{release=resolve;}));
  const pending=s.account.profile(); s.event('SIGNED_IN',profile.authUserId); release({data:profile});
  assert.equal((await pending).id,profile.id);
  assert.equal((await s.account.operations.read('dashboard')).ok,true);
});

test('operations errors use exact codes instead of matching AUTH_REQUIRED inside another code',()=>{
  for(const code of ['GOOGLE_AUTH_REQUIRED','AUTH_REQUIRED','ADMIN_REQUIRED']) {
    assert.equal(globalThis.FestivalOperations.error({message:code}).code,code);
  }
  assert.equal(globalThis.FestivalOperations.error({message:'prefix_NOT_FOUND_suffix'}).code,'NETWORK_ERROR');
});
