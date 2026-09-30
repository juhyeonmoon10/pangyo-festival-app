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
