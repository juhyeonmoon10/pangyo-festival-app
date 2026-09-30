import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(process.env.PGLITE_DIR, 'node_modules/@electric-sql/pglite/dist');
const { PGlite } = await import(pathToFileURL(path.join(dir,'index.js')));
const { pgcrypto } = await import(pathToFileURL(path.join(dir,'contrib/pgcrypto.js')));
const db = new PGlite({ extensions:{pgcrypto} });
const read = file => fs.readFileSync(path.join(root,file),'utf8');
const one = async (sql,args=[]) => (await db.query(sql,args)).rows[0];
const results=[];
async function test(name, run) {
  try { await run(); results.push({name,ok:true}); console.log('PASS',name); }
  catch(e) { results.push({name,ok:false,error:e.message}); console.log('FAIL',name,e.message); }
}
async function rpc(actor,sql,args=[],role='authenticated') {
  await db.exec('begin');
  try {
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({sub:actor.id,session_id:actor.session,role})]);
    await db.exec(`set local role ${role}`);
    const row=await one(sql,args); await db.exec('commit'); return row?.value;
  } catch(e) { await db.exec('rollback'); throw e; }
}
const write=(a,action,payload,id=randomUUID())=>rpc(a,'select public.festival_ops_write($1,$2,$3) value',[action,payload,id]);
const get=(a,kind,query={})=>rpc(a,'select public.festival_ops_read($1,$2) value',[kind,query]);
async function account(admin=false) {
  const a={id:randomUUID(),session:randomUUID()};
  await db.query(`insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data)
    values($1,$2,now(),'{"provider":"google"}','{"festival_name":"Synthetic","festival_student_number":"21001"}')`,[a.id,`${a.id}@example.invalid`]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[a.session,a.id]);
  a.uid=(await rpc(a,'select public.festival_nfc_profile() value')).id;
  if(admin) await db.query('update public.users set admin=true where id=$1',[a.uid]);
  return a;
}
const metadata=async()=> (await db.query(`select n.nspname,p.proname,pg_get_functiondef(p.oid) definition,p.proacl::text acl
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='festival_nfc_private' order by p.proname`)).rows;
await db.exec(read('nfc-server/isolated-test/shim.sql'));
await db.exec(read('nfc-server/install.sql'));
await db.exec(read('nfc-server/admin-issue.sql'));
await db.exec(read('nfc-server/reviews.sql'));
const baseline=await metadata();
await db.exec(read('operations-server/install.sql'));
const admin=await account(true), student=await account(), other=await account();
let custom, rule, event, coupon;
await test('installation preserves NFC definitions and grants',async()=>assert.deepEqual(await metadata(),baseline));
await test('default configuration is not open',async()=>assert.equal((await get(student,'me')).ready,false));
await test('anonymous RPC and private table access denied',async()=>{
  await assert.rejects(rpc(student,"select public.festival_ops_read('me','{}') value",[],'anon'),/permission denied/);
  await assert.rejects(rpc(admin,'select count(*) value from festival_ops.ledger'),/permission denied/);
});
await test('students cannot query admin records or configure an event',async()=>{
  for(const kind of ['participants','ledger','audit','visits','rules','vouchers','dashboard']) await assert.rejects(get(student,kind),/ADMIN_REQUIRED/);
  await assert.rejects(write(student,'event_save',{name:'Test',state:'open',reviewPoints:10}),/ADMIN_REQUIRED/);
});
await test('create event; import existing booth metadata without visits',async()=>{
  event=(await write(admin,'event_save',{name:'Isolated test',state:'open',reviewPoints:10,version:0})).event;
  assert.equal((await get(student,'catalog')).items.length,20);
  assert.equal((await get(student,'me')).visits.length,0);
});
await test('custom booth creation and stale update denial',async()=>{
  custom=(await write(admin,'booth_save',{name:'New booth',location:'2F',floor:2,status:'open',description:'Test'})).booth;
  await assert.rejects(write(admin,'booth_save',{booth:custom,version:0,name:'Wrong',floor:2,status:'open'}),/VERSION_CONFLICT/);
});
await test('manual approval requires admin, reason, another valid participant',async()=>{
  await assert.rejects(write(student,'visit_approve',{booth:custom,userId:other.uid,reason:'Manual check'}),/ADMIN_REQUIRED/);
  await assert.rejects(write(admin,'visit_approve',{booth:custom,userId:admin.uid,reason:'Manual check'}),/SELF_ADJUSTMENT/);
  await assert.rejects(write(admin,'visit_approve',{booth:custom,userId:student.uid,reason:''}),/INVALID_INPUT/);
});
await test('manual approval and duplicate retry are exactly once',async()=>{
  const id=randomUUID(), data={booth:custom,userId:student.uid,reason:'Verified onsite'};
  assert.deepEqual(await write(admin,'visit_approve',data,id),await write(admin,'visit_approve',data,id));
  assert.equal((await write(admin,'visit_approve',data)).result,'ALREADY_EARNED');
  assert.equal((await get(student,'me')).visits.length,1);
  await assert.rejects(write(admin,'visit_approve',{...data,reason:'Different'},id),/REQUEST_CONFLICT/);
});
await test('NFC claim checks booth state and rolls back legacy write on denial',async()=>{
  const tag=await rpc(admin,"select public.festival_nfc_admin_issue('글빛누리',60) value");
  await assert.rejects(write(student,'claim',{token:tag.token}),/BOOTH_CLOSED/);
  assert.equal((await one('select cardinality(completed_booths) n from public.users where id=$1',[student.uid])).n,0);
  await write(admin,'booth_save',{booth:'글빛누리',version:1,name:'글빛누리',floor:1,status:'open'});
  assert.equal((await write(student,'claim',{token:tag.token})).result,'EARNED');
  assert.equal((await write(student,'claim',{token:tag.token})).result,'ALREADY_EARNED');
  await assert.rejects(write(other,'claim',{token:tag.token.slice(0,-1)+(tag.token.endsWith('0')?'1':'0')}),/NFC_TAG_INVALID/);
});
await test('voucher rule stock and deadline validation',async()=>{
  rule=(await write(admin,'rule_save',{title:'Drink',target:1,stock:1,enabled:true,expiresAt:'2099-01-01T00:00:00Z'})).id;
  await assert.rejects(write(admin,'rule_save',{title:'Bad',target:1,stock:-1,enabled:true,expiresAt:'2099-01-01T00:00:00Z'}));
});
await test('unvisited review and unqualified reward denied',async()=>{
  await assert.rejects(write(other,'review_save',{booth:custom,rating:5,content:'Fake'}),/VISIT_REQUIRED/);
  await assert.rejects(write(other,'voucher_claim',{ruleId:rule}),/VISIT_REQUIRED/);
});
await test('rating creates voucher; later written review pays once',async()=>{
  await write(student,'review_save',{booth:custom,rating:5,content:''});
  let me=await get(student,'me'); assert.equal(me.points,0); assert.equal(me.vouchers.length,1); coupon=me.vouchers[0];
  const id=randomUUID(), data={booth:custom,rating:5,content:'Nice program'};
  await write(student,'review_save',data,id); await write(student,'review_save',data,id);
  await assert.rejects(write(student,'review_save',data),/ALREADY_REVIEWED/);
  me=await get(student,'me'); assert.equal(me.points,10); assert.equal(me.vouchers.length,1);
  assert.equal((await get(student,'reviews',{booth:custom})).myRating,5);
});
await test('other participant cannot read voucher secrets or receive exhausted stock',async()=>{
  await assert.rejects(write(other,'voucher_qr',{id:coupon.id}),/NOT_FOUND/);
  await assert.rejects(write(admin,'voucher_issue',{ruleId:rule,userId:other.uid,reason:'Approved reward'}),/OUT_OF_STOCK/);
  assert.equal((await get(other,'me')).vouchers.length,0);
  assert.ok(!JSON.stringify(await get(admin,'vouchers')).includes('token_hash'));
});
await test('point adjustments record actor/reason and prevent negative/self balances',async()=>{
  const id=randomUUID(), body={userId:student.uid,delta:-4,reason:'Correction approved'};
  await write(admin,'points_adjust',body,id); await write(admin,'points_adjust',body,id);
  assert.equal((await get(student,'me')).points,6);
  await assert.rejects(write(admin,'points_adjust',{...body,delta:-7}),/POINTS_INSUFFICIENT/);
  await assert.rejects(write(admin,'points_adjust',{...body,userId:admin.uid}),/SELF_ADJUSTMENT/);
  assert.equal((await one('select money from public.users where id=$1',[student.uid])).money,0);
});
await test('rotated QR, one redemption, retry replay, student denial',async()=>{
  const first=await write(student,'voucher_qr',{id:coupon.id});
  const next=await write(student,'voucher_qr',{id:coupon.id});
  await assert.rejects(write(admin,'voucher_redeem',{token:first.token}),/VOUCHER_INVALID/);
  await assert.rejects(write(student,'voucher_redeem',{token:next.token}),/ADMIN_REQUIRED/);
  const id=randomUUID();
  assert.equal((await write(admin,'voucher_redeem',{token:next.token},id)).result,'REDEEMED');
  assert.equal((await write(admin,'voucher_redeem',{token:next.token},id)).result,'REDEEMED');
  await assert.rejects(write(admin,'voucher_redeem',{token:next.token}),/VOUCHER_USED/);
});
await test('expired QR is refused by server and preview never redeems',async()=>{
  const r=(await write(admin,'rule_save',{title:'Expiry check',target:2,stock:1,enabled:true,expiresAt:'2099-01-01T00:00:00Z'})).id;
  const v=await write(admin,'voucher_issue',{ruleId:r,userId:other.uid,reason:'Approved testing exception'});
  const qr=await write(other,'voucher_qr',{id:v.id});
  assert.equal((await get(admin,'voucher_check',{token:qr.token})).valid,true);
  assert.equal((await get(other,'me')).vouchers.find(x=>x.id===v.id).state,'available');
  await assert.rejects(get(student,'voucher_check',{token:qr.token}),/ADMIN_REQUIRED/);
  await db.query("update festival_ops.vouchers set token_expires_at=now()-interval '1 second' where id=$1",[v.id]);
  assert.equal((await get(admin,'voucher_check',{token:qr.token})).valid,false);
  await assert.rejects(write(admin,'voucher_redeem',{token:qr.token}),/VOUCHER_EXPIRED/);
});
await test('manual voucher cancellation leaves audit record',async()=>{
  const r=(await write(admin,'rule_save',{title:'Manual',target:3,stock:2,enabled:true,expiresAt:'2099-01-01T00:00:00Z'})).id;
  const v=await write(admin,'voucher_issue',{ruleId:r,userId:other.uid,reason:'Approved exception'});
  await write(admin,'voucher_void',{id:v.id,reason:'Cancelled duplicate request'});
  assert.equal((await get(other,'me')).vouchers.find(x=>x.id===v.id).state,'void');
  assert.ok((await get(admin,'audit')).items.some(x=>x.action==='voucher_void'));
});
await test('all paginated admin lists and own profile are shaped',async()=>{
  for(const kind of ['participants','visits','ledger','rules','vouchers','audit']) assert.ok(Array.isArray((await get(admin,kind)).items),kind);
  assert.equal((await get(admin,'dashboard')).used,1);
});
await test('pause stops claims, adjustments, reviews and redemptions',async()=>{
  await write(admin,'event_save',{name:event.name,state:'paused',reviewPoints:10,version:event.version});
  await assert.rejects(write(admin,'points_adjust',{userId:student.uid,delta:1,reason:'Adjustment'}),/EVENT_CLOSED/);
  await assert.rejects(write(student,'review_save',{booth:'글빛누리',rating:5}),/EVENT_CLOSED/);
});
await test('expired session and emergency disable fail closed without deleting data',async()=>{
  await db.query("update auth.sessions set not_after=now()-interval '1 minute' where id=$1",[student.session]);
  await assert.rejects(get(student,'me'),/GOOGLE_AUTH_REQUIRED/);
  await db.exec(read('operations-server/disable.sql'));
  await assert.rejects(get(admin,'dashboard'),/permission denied/);
  assert.equal((await one('select count(*)::int n from festival_ops.vouchers')).n,3);
});
fs.mkdirSync(path.join(root,'artifacts/operations'),{recursive:true});
fs.writeFileSync(path.join(root,'artifacts/operations/isolated.json'),JSON.stringify({environment:'PGlite with synthetic auth/Vault; not real concurrency or real OAuth',at:new Date().toISOString(),results},null,2));
await db.close(); process.exitCode=results.some(x=>!x.ok)?1:0;
console.log(`${results.filter(x=>x.ok).length}/${results.length} checks passed`);
