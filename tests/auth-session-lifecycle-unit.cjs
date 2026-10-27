const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const operations = require('../festival-operations.js');

const profileFor = id => ({ id:1, authUserId:id, name:'Fixture', email:'fixture@example.invalid',
  studentNumber:'21001', needsProfile:false, isAdmin:true, completedBooths:[] });
function fixture() {
  const calls=[], values=new Map();
  let callback, current='account-a', handler;
  const auth={onAuthStateChange:fn=>{callback=fn;}, getSession:async()=>({data:{session:{user:{id:current}}}})};
  const rpc=async(name,args)=>{
    calls.push({name,args});
    return handler?handler(name,args):{data:name==='festival_nfc_profile'?profileFor(current):{ready:true}};
  };
  const sandbox={module:{exports:{}},FestivalOperations:operations,URL,AbortController,setTimeout,clearTimeout};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../festival-account.js'),'utf8'),sandbox);
  const account=sandbox.module.exports.createAccount({
    sdk:{createClient:()=>({auth,rpc})},config:{PROJECT_URL:'https://fixture.invalid',PUBLISHABLE_KEY:'fixture'},
    storage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)},
    location:new URL('https://fixture.invalid/'),
  });
  return {account,calls,handle:fn=>{handler=fn;},emit:(event,id=current)=>{
    current=id;
    callback(event,id?{user:{id},access_token:'synthetic-token'}:null);
  }};
}

test('same-account refocus and token refresh preserve the verified operations actor',async()=>{
  const {account,emit}=fixture();
  await account.initialize();
  for(const event of ['SIGNED_IN','SIGNED_IN','TOKEN_REFRESHED','INITIAL_SESSION','USER_UPDATED']) {
    emit(event);
    assert.equal((await account.operations.read('dashboard')).ok,true,event);
  }
});

test('same-account SIGNED_IN does not discard a pending operator response',async()=>{
  const {account,emit,handle}=fixture();await account.initialize();
  let resolve;
  handle(()=>new Promise(r=>{resolve=r;}));
  const response=account.operations.read('participants');
  emit('SIGNED_IN');resolve({data:{items:[]}});
  assert.equal((await response).ok,true);
});

test('logout, changed account and absent session invalidate the actor before any next RPC',async()=>{
  for(const [event,id] of [['SIGNED_OUT',null],['SIGNED_IN','account-b'],['SIGNED_IN',null],['TOKEN_REFRESHED','account-b']]) {
    const {account,emit,calls}=fixture();await account.initialize();
    const before=calls.length;emit(event,id);
    assert.equal((await account.operations.read('dashboard')).code,'AUTH_REQUIRED');
    assert.equal((await account.operations.write('event_save',{})).code,'AUTH_REQUIRED');
    assert.equal(calls.length,before);
  }
});

test('a stale profile response cannot restore an actor after logout or account switching',async()=>{
  for(const [event,id] of [['SIGNED_OUT',null],['SIGNED_IN','account-b']]) {
    const {account,emit,handle}=fixture();await account.initialize();
    let resolve;handle(()=>new Promise(r=>{resolve=r;}));
    const pending=account.profile();emit(event,id);resolve({data:profileFor('account-a')});
    await assert.rejects(pending,/AUTH_REQUIRED/);
    assert.equal((await account.operations.read('dashboard')).code,'AUTH_REQUIRED');
  }
});

test('returning to the same subject cannot revive an older profile request',async()=>{
  const {account,emit,handle}=fixture();await account.initialize();
  let resolve;handle(()=>new Promise(r=>{resolve=r;}));
  const pending=account.profile();emit('SIGNED_IN','account-b');emit('SIGNED_IN','account-a');
  resolve({data:profileFor('account-a')});
  await assert.rejects(pending,/AUTH_REQUIRED/);
  assert.equal((await account.operations.read('dashboard')).code,'AUTH_REQUIRED');
});

test('auth session alone never grants operations access; a matching server profile is required',async()=>{
  const {account,emit,handle}=fixture();
  emit('SIGNED_IN','account-b');
  assert.equal((await account.operations.read('dashboard')).code,'AUTH_REQUIRED');
  handle(async()=>({data:profileFor('account-a')}));
  await assert.rejects(account.profile(),/AUTH_REQUIRED/);
  handle(async name=>({data:name==='festival_nfc_profile'?profileFor('account-b'):{ready:true}}));
  await account.profile();
  assert.equal((await account.operations.read('dashboard')).ok,true);
});

test('same-account refocus retains idempotency when retrying a failed operator write',async()=>{
  const {account,emit,handle,calls}=fixture();await account.initialize();
  let fail=true;
  handle(async()=>{if(fail)throw Error('network');return {data:{saved:true}};});
  const first=await account.operations.write('event_save',{version:1});
  assert.equal(first.retryable,true);
  emit('SIGNED_IN');fail=false;
  assert.equal((await account.operations.write('event_save',{version:1})).ok,true);
  const writes=calls.filter(call=>call.name==='festival_ops_write');
  assert.equal(writes.length,2);
  assert.equal(writes[0].args.p_request_id,writes[1].args.p_request_id);
});
