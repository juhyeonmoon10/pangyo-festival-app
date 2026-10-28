const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const operations=require('../festival-operations.js');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const adapter=source.slice(source.indexOf('const NFC_ERROR_TITLES ='),source.indexOf('function dismissNfcFeedback()'));

function setup(code) {
  const saved=[],claims=[],feedback=[];
  const state={user:{id:'fixture-student'},route:'map',searchOpen:false,db:{event:{id:'fixture-event'},booths:[]}};
  const context=vm.createContext({state,document:{activeElement:null},makeId:()=> 'fixture-request',
    isAdminOnlyNfcSource:()=>false,isAdminUser:()=>false,isServerMode:()=>true,
    festivalAccount:{savePending:value=>saved.push(value)},
    stampGateway:{claimNfc:async request=>{claims.push(request);return operations.error({message:code});}},
    refreshVisitIndicators(){},showNfcFeedback:()=>feedback.push(state.scanResult),render(){},
  });
  vm.runInContext(adapter,context);
  return {state,saved,claims,feedback,scan:()=>vm.runInContext("nfcAdapter.scan({nfcToken:'synthetic-tag',source:'url'})",context)};
}

for(const [code,title] of [
  ['BOOTH_CLOSED','부스가 운영 중이 아니에요'],
  ['EVENT_CLOSED','축제가 운영 중이 아니에요'],
  ['OPS_NOT_READY','축제 운영 정보를 확인할 수 없어요'],
  ['NFC_DISABLED','방문 인증이 잠시 중지됐어요'],
]) test(`${code} is an intentional stop, not a generic processing error`,async()=>{
  const app=setup(code); const result=await app.scan();
  assert.equal(result.ok,false); assert.equal(app.claims.length,1);
  assert.equal(app.state.scanResult.type,'blocked'); assert.equal(app.state.scanResult.title,title);
  assert.equal(app.state.scanResult.retryable,false); assert.equal(app.state.pendingNfcClaim,null);
  assert.equal(app.saved.at(-1),null); assert.equal(app.feedback.length,1);
  assert.equal(app.state.route,'map');
});

test('network errors retain the same pending token for explicit retry',async()=>{
  const app=setup('UNRECOGNIZED_FAILURE'); await app.scan();
  assert.equal(app.state.scanResult.type,'error'); assert.equal(app.state.scanResult.retryable,true);
  assert.equal(app.saved.at(-1).nfcToken,'synthetic-tag');
});
