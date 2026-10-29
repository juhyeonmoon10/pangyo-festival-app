const {test}=require('node:test');
const assert=require('node:assert/strict');
const {create}=require('../festival-operations.js');
function storage(){const m=new Map();return {getItem:k=>m.get(k),setItem:(k,v)=>m.set(k,v),dump:()=>[...m.values()].join('')};}
test('deduplicates in-flight requests and hides request contents in storage',async()=>{
  let calls=0; const s=storage();
  const api=create({actor:()=> 'a',storage:s,rpc:async()=>{calls++;await new Promise(r=>setTimeout(r,20));return {data:{saved:true}};}});
  const payload={reason:'Private participant information',userId:2,delta:10};
  await Promise.all([api.write('points_adjust',payload),api.write('points_adjust',payload)]);
  assert.equal(calls,1); assert.ok(!s.dump().includes('Private'));
});
test('lost response retains request ID across reload without retaining token',async()=>{
  const s=storage(), calls=[];
  const make=rpc=>create({actor:()=> 'a',storage:s,rpc});
  const first=make(async(n,p)=>{calls.push(p);throw Error('timeout');});
  assert.equal((await first.write('voucher_redeem',{token:'secret'})).retryable,true);
  assert.ok(!s.dump().includes('secret'));
  const next=make(async(n,p)=>{calls.push(p);return {data:{saved:true}};});
  await next.write('voucher_redeem',{token:'secret'});
  assert.equal(calls[0].p_request_id,calls[1].p_request_id);
});
test('account changes discard late responses and use separate request keys',async()=>{
  let actor='a',resolve;const s=storage();
  const api=create({actor:()=>actor,storage:s,rpc:()=>new Promise(r=>{resolve=r;})});
  const result=api.read('me');actor='b';resolve({data:{points:50}});
  assert.equal((await result).code,'AUTH_REQUIRED');
});
test('invalid inputs do not make requests; installed errors are not network errors',async()=>{
  let calls=0;const api=create({actor:()=> 'a',storage:storage(),rpc:async()=>{calls++;return {error:{code:'PGRST202'}};}});
  assert.equal((await api.write('arbitrary',{})).code,'INVALID_INPUT');
  assert.equal((await api.write('points_adjust',[])).code,'INVALID_INPUT');assert.equal(calls,0);
  assert.equal((await api.read('me')).code,'OPS_NOT_READY');
});

test('reward status and choice use guarded reward RPCs, not the generic claim endpoint',async()=>{
  const calls=[],s=storage();
  const api=create({actor:()=> 'a',storage:s,rpc:async(name,args)=>{calls.push({name,args});return {data:{version:2,ready:true}};}});
  await api.read('reward_status');await api.write('reward_choose',{eventId:'fixture',kind:'photo',firstTarget:9});
  assert.equal(calls[0].name,'festival_reward_read');assert.equal(calls[1].name,'festival_reward_write');
  assert.equal(calls[1].args.p_payload.kind,'photo');assert.equal(calls[1].args.p_action,'reward_choose');
  assert.equal(calls[1].args.p_payload.firstTarget,9);
});
test('reward choice timeout retries retain their request ID',async()=>{
  const s=storage(),ids=[];
  const first=create({actor:()=> 'a',storage:s,rpc:async(_n,p)=>{ids.push(p.p_request_id);throw Error('timeout');}});
  assert.equal((await first.write('reward_choose',{eventId:'event',kind:'food',firstTarget:3})).retryable,true);
  const second=create({actor:()=> 'a',storage:s,rpc:async(_n,p)=>{ids.push(p.p_request_id);return{data:{ready:true}};}});
  await second.write('reward_choose',{kind:'food',eventId:'event',firstTarget:3});assert.equal(ids[0],ids[1]);
  await second.write('reward_choose',{kind:'food',eventId:'event',firstTarget:9});assert.notEqual(ids[0],ids[2]);
});
test('participation reset calls its own RPC with payload and request ID only',async()=>{
  const calls=[];
  const api=create({actor:()=> 'a',storage:storage(),rpc:async(name,args)=>{calls.push({name,args});return {data:{reset:true,visits:2}};}});
  const result=await api.write('participation_reset',{eventId:'fixture',confirm:'초기화',identities:true});
  assert.equal(result.ok,true);assert.equal(calls[0].name,'festival_ops_reset');
  assert.deepEqual(Object.keys(calls[0].args).sort(),['p_payload','p_request_id']);
  assert.equal(calls[0].args.p_payload.confirm,'초기화');
  const wrong=await create({actor:()=> 'a',storage:storage(),rpc:async()=>({error:{message:'RESET_CONFIRM_REQUIRED'}})}).write('participation_reset',{confirm:'x'});
  assert.equal(wrong.code,'RESET_CONFIRM_REQUIRED');
});
