// Synthetic, in-memory PostgreSQL only. Never connects to the shared project.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto, {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const FestivalSun=createRequire(import.meta.url)(path.join(root,'sun-nfc.js'));
const dep=path.join(process.env.PGLITE_DIR,'node_modules/@electric-sql/pglite/dist');
const {PGlite}=await import(pathToFileURL(path.join(dep,'index.js')));
const {pgcrypto}=await import(pathToFileURL(path.join(dep,'contrib/pgcrypto.js')));
const db=new PGlite({extensions:{pgcrypto}}),results=[];
const sql=f=>db.exec(fs.readFileSync(path.join(root,f),'utf8'));
const one=async(q,args=[])=>(await db.query(q,args)).rows[0];
async function rpc(a,q,args=[],role='authenticated') {
  await db.exec('begin');
  try {
    await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:a.id,session_id:a.session,role})]);
    await db.exec(`set local role ${role}`);
    const row=await one(q,args); await db.exec('commit'); return row?.value;
  } catch(e) {await db.exec('rollback'); throw e;}
}
const ops=(a,action,payload)=>rpc(a,'select public.festival_ops_write($1,$2,$3) value',[action,payload,randomUUID()]);
const sunAdmin=(action,payload={},a=admin)=>rpc(a,'select public.festival_sun_admin($1,$2) value',[action,payload]);
const sunClaim=(a,payload,request=randomUUID())=>rpc(a,'select public.festival_sun_claim($1,$2) value',[payload,request]);
const visits=async(a,booth)=>Number((await one('select count(*) n from festival_ops.visits where user_id=$1 and booth_key=$2',[a.uid,booth])).n);
async function account(sid,isAdmin=false) {
  const a={id:randomUUID(),session:randomUUID()};
  await db.query(`insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data) values($1,$2,now(),'{"provider":"google"}',$3)`,[a.id,`${a.id}@example.invalid`,{festival_name:'Synthetic',festival_student_number:sid}]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[a.session,a.id]);
  a.uid=(await rpc(a,'select public.festival_nfc_profile() value')).id;
  if(isAdmin) await db.query('update public.users set admin=true where id=$1',[a.uid]);
  return a;
}
async function test(name,fn) {try {await fn();results.push({name,ok:true});console.log('PASS',name);}catch(e){results.push({name,ok:false,error:e.message});console.log('FAIL',name,e.message);}}

// Independent AES-CMAC (RFC 4493) and SUN card model in Node, used to make synthetic card reads.
const aes=(k,b)=>{const c=crypto.createCipheriv('aes-128-ecb',k,null);c.setAutoPadding(false);return Buffer.concat([c.update(b),c.final()]);};
const xor=(a,b)=>Buffer.from(a.map((v,i)=>v^b[i]));
const shl=b=>{const r=Buffer.alloc(16);let carry=0;for(let i=15;i>=0;i--){r[i]=((b[i]<<1)&255)|carry;carry=b[i]>>7;}return r;};
function cmac(k,m) {
  const z=Buffer.alloc(16),l=aes(k,z),k1=shl(l); if(l[0]&128) k1[15]^=0x87;
  const k2=shl(k1); if(k1[0]&128) k2[15]^=0x87;
  const n=Math.max(1,Math.ceil(m.length/16)); let x=z;
  for(let i=0;i<n-1;i++) x=aes(k,xor(x,m.subarray(i*16,i*16+16)));
  let last=m.subarray((n-1)*16);
  if(last.length===16) last=xor(last,k1); else {const p=Buffer.alloc(16);last.copy(p);p[last.length]=0x80;last=xor(p,k2);}
  return aes(k,xor(x,last));
}
function cardRead(uid,counter,keys,mode='empty') {
  const ctr=Buffer.from([counter&255,(counter>>8)&255,(counter>>16)&255]);
  const plain=Buffer.concat([Buffer.from([0xC7]),Buffer.from(uid,'hex'),ctr,crypto.randomBytes(5)]);
  const c=crypto.createCipheriv('aes-128-cbc',Buffer.from(keys.metaKey,'hex'),Buffer.alloc(16));c.setAutoPadding(false);
  const picc=Buffer.concat([c.update(plain),c.final()]).toString('hex').toUpperCase();
  const ses=cmac(Buffer.from(keys.fileKey,'hex'),Buffer.concat([Buffer.from('3cc300010080','hex'),Buffer.from(uid,'hex'),ctr]));
  const input=mode==='input'?`${picc}&cmac=`:'';
  const full=cmac(ses,Buffer.from(input,'ascii'));
  const mac=Buffer.from([1,3,5,7,9,11,13,15].map(i=>full[i])).toString('hex').toUpperCase();
  return mode==='input'?{picc,cmac:mac,macInput:input}:{picc,cmac:mac};
}
// The link a card produces, read back the way the app reads it.
const viaUrl=read=>FestivalSun.payload(FestivalSun.parse(`https://festival.example/#picc_data=${read.picc}&cmac=${read.cmac}`));

for(const f of ['nfc-server/isolated-test/shim.sql','nfc-server/install.sql','nfc-server/admin-issue.sql','nfc-server/updates/20260930-nonexpiring-tags.sql','nfc-server/reviews.sql','operations-server/install.sql']) await sql(f);
const admin=await account('29999',true);
const event=(await ops(admin,'event_save',{name:'Synthetic SUN event',state:'open',reviewPoints:10,version:0})).event;
for(const f of ['operations-server/review-identity.draft.sql','operations-server/reward-visits.sql','operations-server/reward-fixed-milestones.sql','operations-server/voucher-unlimited-and-reset.sql','operations-server/review-identity-self.sql','operations-server/voucher-short-code.sql','operations-server/review-distribution-self-redeem.sql','operations-server/nfc-tag-registry.sql','operations-server/claim-guard.sql','operations-server/booth-bulk-and-tag-register.sql','operations-server/notices.sql','operations-server/operator-identity-and-scoped-reset.sql']) await sql(f);
const catalog=(await db.query('select key from festival_ops.booths where event_id=$1 order by key collate "C"',[event.id])).rows.map(r=>r.key);
const [own,away,third]=catalog;
for(const booth of [own,away,third]) await ops(admin,'booth_save',{booth,name:booth,status:'open',floor:1,version:1});
const record=(studentNumber,realName,boothKeys)=>({studentNumber,realName,clubs:['Synthetic Club'],boothKeys,status:'ready',issues:[],sourceCells:['Synthetic!A1']});
await db.query('select festival_ops.import_review_roster($1,$2,$3)',[event.id,{format:1,sourceSha256:'d'.repeat(64),catalogKeys:catalog,
  records:[record('11001','Synthetic One',[own]),record('29999','Synthetic Admin',[])]},admin.uid]);
for(const f of ['self-identity-and-own-club-stamps','student-number-display','student-number-only','operator-self-actions']) await sql(`operations-server/${f}.sql`);
const student=await account('11001'),other=await account('11002');
await rpc(student,'select public.festival_review_identity_self($1,$2) value',['link',{eventId:event.id,realName:'Synthetic One'}]).catch(()=>null);
const nf1=(await one('select festival_nfc_private.issue_tag($1,null) t',[third])).t;
await sql('operations-server/sun-nfc.sql');

const helper=(q,args)=>one(`select ${q} v`,args).then(r=>r.v);
await test('AES-CMAC matches RFC 4493 vectors',async()=>{
  const k='2b7e151628aed2a6abf7158809cf4f3c';
  const vectors=[['','bb1d6929e95937287fa37d129b756746'],['6bc1bee22e409f96e93d7e117393172a','070a16b46b4d4144f79bdd9dd04a287c'],
    ['6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411','dfa66747de9ae63030ca32611497c827']];
  for(const [m,expected] of vectors) {
    assert.equal(Buffer.from(await helper(`festival_nfc_private.sun_cmac(decode($1,'hex'),decode($2,'hex'))`,[k,m])).toString('hex'),expected);
    assert.equal(cmac(Buffer.from(k,'hex'),Buffer.from(m,'hex')).toString('hex'),expected);
  }
});
await test('the NXP AN12196 example read verifies',async()=>{
  const zero={metaKey:'0'.repeat(32),fileKey:'0'.repeat(32)};
  const v=await helper(`festival_nfc_private.sun_verify('EF963FF7828658A599F3041510671E88','94EED9EE65337086',null,$1)`,[zero]);
  assert.deepEqual(v,{ok:true,uid:'04DE5F1EACC040',counter:61,macMode:'empty'});
  assert.equal((await helper(`festival_nfc_private.sun_verify('EF963FF7828658A599F3041510671E88','94EED9EE65337087',null,$1)`,[zero])).reason,'mac');
});

let keys;
await test('only operators manage keys; keys stay out of reach of the API roles',async()=>{
  assert.deepEqual((await sunAdmin('status')).configured,false);
  await assert.rejects(sunAdmin('status',{},student),/ADMIN_REQUIRED/);
  await assert.rejects(sunAdmin('keys_create',{metaKey:'0'.repeat(32),fileKey:'1'.repeat(32)}),/SUN_KEY_INVALID/);
  await assert.rejects(sunAdmin('keys_create',{metaKey:'a'.repeat(32),fileKey:'a'.repeat(32)}),/SUN_KEY_INVALID/);
  assert.equal((await sunAdmin('keys_create')).configured,true);
  keys=await sunAdmin('keys_reveal');
  assert.match(keys.metaKey,/^[0-9a-f]{32}$/); assert.notEqual(keys.metaKey,keys.fileKey);
  const status=await sunAdmin('status'); assert.equal(status.enabled,true); assert.equal(status.items.length,0);
  await assert.rejects(rpc(student,'select festival_nfc_private.sun_config() value'),/permission denied/);
  await assert.rejects(rpc(student,'select public.festival_sun_admin($1,$2) value',['status',{}],'anon'),/permission denied/);
  assert.equal(Number((await one("select count(*) n from festival_ops.audit where action='sun_keys_reveal'")).n),1);
});

const UID='04A1B2C3D4E5F6';
await test('inspect reports the card without using the read; register links it to a booth',async()=>{
  const read=cardRead(UID,5,keys);
  const seen=await sunAdmin('inspect',viaUrl(read));
  assert.equal(seen.ok,true); assert.equal(seen.uid,UID); assert.equal(seen.counter,5); assert.equal(seen.card,null); assert.equal(seen.fresh,true);
  const card=await sunAdmin('register',{...viaUrl(read),booth:away,label:'정문'});
  assert.deepEqual(card,{uid:UID,boothKey:away,label:'정문',lastCounter:5});
  await assert.rejects(sunAdmin('register',{...viaUrl(cardRead(UID,6,keys)),booth:away}),/SUN_CARD_EXISTS/);
  assert.equal((await sunAdmin('inspect',viaUrl(read))).fresh,false);
});
await test('a fresh read stamps once; the same or an older link never stamps again',async()=>{
  const read=viaUrl(cardRead(UID,7,keys));
  const result=await sunClaim(student,read);
  assert.equal(result.result,'EARNED'); assert.equal(result.boothKey,away); assert.ok(result.completedBooths.includes(away));
  assert.equal(await visits(student,away),1);
  assert.equal((await one('select method from festival_ops.visits where user_id=$1 and booth_key=$2',[student.uid,away])).method,'nfc');
  await assert.rejects(sunClaim(other,read),/SUN_CARD_REPLAYED/);
  await assert.rejects(sunClaim(other,viaUrl(cardRead(UID,6,keys))),/SUN_CARD_REPLAYED/);
  assert.equal((await sunClaim(student,viaUrl(cardRead(UID,8,keys)))).result,'ALREADY_EARNED');
  await assert.rejects(sunClaim(other,viaUrl(cardRead(UID,8,keys))),/SUN_CARD_REPLAYED/);
  const card=(await sunAdmin('status')).items[0]; assert.equal(card.lastCounter,8); assert.equal(card.useCount,2);
});
await test('a retried request returns the stored result',async()=>{
  const request=randomUUID(), read=viaUrl(cardRead(UID,9,keys));
  const first=await sunClaim(other,read,request), again=await sunClaim(other,read,request);
  assert.equal(first.result,'EARNED'); assert.deepEqual(again,first);
});
await test('forged or wrongly written cards are rejected with a reason for operators',async()=>{
  const forged={...viaUrl(cardRead(UID,20,keys)),cmac:'0000000000000000'};
  await assert.rejects(sunClaim(student,forged),/SUN_CARD_INVALID/);
  assert.equal((await sunAdmin('inspect',viaUrl(cardRead(UID,20,{...keys,metaKey:'f'.repeat(32)})))).reason,'meta');
  assert.equal((await sunAdmin('inspect',viaUrl(cardRead(UID,20,{...keys,fileKey:'f'.repeat(32)})))).reason,'mac');
  assert.equal((await sunAdmin('inspect',{picc:'xyz',cmac:'1'})).reason,'format');
  await assert.rejects(sunClaim(student,viaUrl(cardRead('04000000000001',1,keys))),/SUN_CARD_UNKNOWN/);
});
await test('a card that MACs the link text verifies with the text the app sends',async()=>{
  const read=cardRead(UID,30,keys,'input');
  const parsed=FestivalSun.payload(FestivalSun.parse(`https://festival.example/#picc_data=${read.picc}&cmac=${read.cmac}`));
  assert.equal(parsed.macInput,read.macInput);
  assert.equal((await sunAdmin('inspect',parsed)).macMode,'input');
  assert.equal((await sunAdmin('inspect',{picc:read.picc,cmac:read.cmac})).reason,'mac');
});
await test('own-club, stopped and disabled cards do not stamp and do not use up the read',async()=>{
  await sunAdmin('register',{...viaUrl(cardRead('04111111111111',1,keys)),booth:own});
  const mine=viaUrl(cardRead('04111111111111',2,keys));
  await assert.rejects(sunClaim(student,mine),/OWN_CLUB_STAMP/);
  assert.equal((await sunClaim(other,mine)).result,'EARNED');
  await sunAdmin('revoke',{uid:UID});
  await assert.rejects(sunClaim(student,viaUrl(cardRead(UID,40,keys))),/SUN_CARD_STOPPED/);
  await sunAdmin('restore',{uid:UID});
  await sunAdmin('enable',{enabled:false});
  await assert.rejects(sunClaim(student,viaUrl(cardRead(UID,40,keys))),/SUN_DISABLED/);
  // Signed tags are managed separately and keep working.
  assert.equal((await ops(student,'claim',{token:nf1})).result,'EARNED');
  await sunAdmin('enable',{enabled:true});
  assert.equal((await sunClaim(student,viaUrl(cardRead(UID,40,keys)))).result,'ALREADY_EARNED');
});
await test('move and label update the card; replacing keys needs confirmation',async()=>{
  await sunAdmin('move',{uid:UID,booth:third}); await sunAdmin('label',{uid:UID,label:'후문'});
  const card=(await sunAdmin('status')).items.find(c=>c.uid===UID); assert.equal(card.boothKey,third); assert.equal(card.label,'후문');
  await assert.rejects(sunAdmin('keys_create'),/SUN_KEYS_CONFIRM_REQUIRED/);
  await sunAdmin('keys_create',{confirm:'키 교체'});
  assert.equal((await sunAdmin('inspect',viaUrl(cardRead(UID,50,keys)))).ok,false);
  const actions=(await db.query("select action from festival_ops.audit where action like 'sun_%' order by id")).rows.map(r=>r.action);
  for(const a of ['sun_keys_create','sun_card_register','sun_card_revoke','sun_card_restore','sun_enable','sun_card_move']) assert.ok(actions.includes(a),a);
});
await test('rollback removes the secure-card functions and keeps signed tags',async()=>{
  await sql('operations-server/sun-nfc-rollback.sql');
  assert.equal(Number((await one("select count(*) n from pg_proc where proname like 'festival_sun_%' or proname like 'sun\\_%'")).n),0);
  assert.equal((await ops(other,'claim',{token:nf1})).result,'EARNED');
  await sql('operations-server/sun-nfc.sql');
  assert.equal((await sunAdmin('status')).items.length,2);
});

const failed=results.filter(r=>!r.ok);
console.log(`${results.length-failed.length}/${results.length} passed`);
if(failed.length) process.exit(1);
