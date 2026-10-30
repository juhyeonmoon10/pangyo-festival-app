const {test}=require('node:test');
const assert=require('node:assert/strict');
const {validateIdentityState}=require('../festival-account.js');
const base={version:1,eventId:'e',result:null,studentNumber:'11001',eligible:true,verified:false,locked:false,selfRegistered:false,realName:null,clubs:[],boothKeys:[]};

test('accepts unconfirmed and confirmed identity states',()=>{
  assert.equal(validateIdentityState(base).verified,false);
  const ok=validateIdentityState({...base,result:'CONFIRMED',verified:true,selfRegistered:false,realName:'김하나',clubs:['인벨릭스'],boothKeys:['인벨릭스']});
  assert.deepEqual([ok.realName,ok.clubs,ok.boothKeys],['김하나',['인벨릭스'],['인벨릭스']]);
});
test('a student self-confirmation against the roster is a verified identity',()=>{
  const self=validateIdentityState({...base,result:'CONFIRMED',verified:true,selfRegistered:true,realName:'김하나',clubs:['인벨릭스'],boothKeys:['인벨릭스']});
  assert.deepEqual([self.verified,self.selfRegistered,self.boothKeys],[true,true,['인벨릭스']]);
  assert.equal(validateIdentityState({...base,selfRegistered:true,locked:false}).verified,false);
});
test('an unverified state never carries roster details',()=>{
  assert.throws(()=>validateIdentityState({...base,realName:'김하나'}),/REVIEW_POLICY_REQUIRED/);
  assert.throws(()=>validateIdentityState({...base,clubs:['인벨릭스']}),/REVIEW_POLICY_REQUIRED/);
});
test('unknown results and malformed shapes are rejected',()=>{
  assert.throws(()=>validateIdentityState({...base,result:'APPROVED_BY_CLIENT'}),/REVIEW_POLICY_REQUIRED/);
  assert.throws(()=>validateIdentityState({...base,verified:true,realName:''}),/REVIEW_POLICY_REQUIRED/);
  assert.throws(()=>validateIdentityState({...base,version:2}),/REVIEW_POLICY_REQUIRED/);
  assert.throws(()=>validateIdentityState(null),/REVIEW_POLICY_REQUIRED/);
});
