// 웨이팅, posters and the removal of operating hours (operations-server/waiting.sql) on synthetic,
// in-memory PostgreSQL only. Never connects to the shared project.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dep=path.join(process.env.PGLITE_DIR,'node_modules/@electric-sql/pglite/dist');
const {PGlite}=await import(pathToFileURL(path.join(dep,'index.js')));
const {pgcrypto}=await import(pathToFileURL(path.join(dep,'contrib/pgcrypto.js')));
const db=new PGlite({extensions:{pgcrypto}}),results=[];
const sql=f=>db.exec(fs.readFileSync(path.join(root,f),'utf8'));
const one=async(q,args=[])=>(await db.query(q,args)).rows[0];
async function rpc(a,q,args=[]) {
  await db.exec('begin');
  try {
    await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:a.id,session_id:a.session,role:'authenticated'})]);
    await db.exec('set local role authenticated');
    const row=await one(q,args); await db.exec('commit'); return row?.value;
  } catch(e) {await db.exec('rollback'); throw e;}
}
const ops=(a,action,payload)=>rpc(a,'select public.festival_ops_write($1,$2,$3) value',[action,payload,randomUUID()]);
const wait=(a,action,payload={})=>rpc(a,'select public.festival_waiting($1,$2) value',[action,payload]);
const manage=(a,action,payload={})=>rpc(a,'select public.festival_waiting_manage($1,$2) value',[action,payload]);
const manager=(a,action,payload={})=>rpc(a,'select public.festival_booth_manager($1,$2,$3) value',[action,payload,null]);
async function account(sid,isAdmin=false,name='Synthetic') {
  const a={id:randomUUID(),session:randomUUID()};
  await db.query(`insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data) values($1,$2,now(),'{"provider":"google"}',$3)`,[a.id,`${a.id}@example.invalid`,{festival_name:name,festival_student_number:sid}]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[a.session,a.id]);
  a.uid=(await rpc(a,'select public.festival_nfc_profile() value')).id;
  if(isAdmin) await db.query('update public.users set admin=true where id=$1',[a.uid]);
  return a;
}
async function test(name,fn) {try {await fn();results.push({name,ok:true});console.log('PASS',name);}catch(e){results.push({name,ok:false,error:e.message});console.log('FAIL',name,e.message);}}

for(const f of ['nfc-server/isolated-test/shim.sql','nfc-server/install.sql','nfc-server/admin-issue.sql','nfc-server/updates/20260930-nonexpiring-tags.sql','nfc-server/reviews.sql','operations-server/install.sql']) await sql(f);
const admin=await account('29999',true,'Synthetic Admin');
const event=(await ops(admin,'event_save',{name:'Synthetic waiting event',state:'open',reviewPoints:10,version:0})).event;
for(const f of ['review-identity.draft','reward-visits','reward-fixed-milestones','voucher-unlimited-and-reset','review-identity-self','voucher-short-code','review-distribution-self-redeem','nfc-tag-registry','claim-guard','booth-bulk-and-tag-register','notices','operator-identity-and-scoped-reset','self-identity-and-own-club-stamps','student-number-display','student-number-only','operator-self-actions','sun-nfc','booth-managers','manual-voucher-issue','voucher-managers','voucher-approval-and-manual-issue','account-delete','notice-images','booth-profile']) await sql(`operations-server/${f}.sql`);
const catalog=(await db.query('select key from festival_ops.booths where event_id=$1 order by key collate "C"',[event.id])).rows.map(r=>r.key);
const [booth,other]=catalog;
for(const k of [booth,other]) await ops(admin,'booth_save',{booth:k,name:k,status:'open',floor:1,version:1});
// Booth info as it was before 1.59: operating hours and a free-text duration.
await db.query(`update festival_ops.booths set program='{"title":"T","hours":"10:00–12:00","duration":"5분 이내"}' where event_id=$1 and key=$2`,[event.id,booth]);
await db.query(`update festival_ops.booths set program='{"duration":"1시간 30분"}' where event_id=$1 and key=$2`,[event.id,other]);
await sql('operations-server/waiting.sql');
const students=[];
for(let i=1;i<=6;i++) students.push(await account(`2100${i}`,false,`학생${i}`));
const [s1,s2,s3,s4,s5,s6]=students;
const outbox=async(a,kind)=>(await db.query('select kind,title,body,url from festival_ops.push_outbox where user_id=$1 and ($2::text is null or kind=$2) order by id',[a.uid,kind??null])).rows;
const settings=async(over={})=>{
  const s=(await manage(admin,'board',{booth})).settings;
  return manage(admin,'settings',{booth,version:s.version,enabled:true,online:true,qr:true,maxParty:4,autoNoshow:false,noshowMinutes:5,
    postponeMode:'count',postponeMaxTeams:3,postponeLimit:null,qrMode:'fixed',qrPeriod:30,durationMinutes:5,...over});
};

await test('operating hours are deleted and the old duration text becomes minutes',async()=>{
  const rows=(await db.query('select key,program,duration_minutes from festival_ops.booths where event_id=$1 and key=any($2) order by key collate "C"',[event.id,[booth,other]])).rows;
  assert.deepEqual(rows.map(r=>[r.program,r.duration_minutes]),[[{title:'T'},5],[{},90]]);
  const st=(await manager(admin,'status')).items.find(b=>b.key===booth);
  assert.equal(st.durationMinutes,5); assert.deepEqual(st.posters,[]);
  // A page opened before 1.59 still saves; its hours are dropped.
  const saved=await manager(admin,'save',{booth,version:st.version,status:'open',description:'',program:{title:'T',hours:'09:00–10:00',duration:'3분'}});
  assert.deepEqual(saved.program,{title:'T'}); assert.equal(saved.durationMinutes,5);
  const again=await manager(admin,'save',{booth,version:saved.version,status:'open',description:'',program:{title:'T'},durationMinutes:7});
  assert.equal(again.durationMinutes,7);
  await assert.rejects(manager(admin,'save',{booth,version:again.version,status:'open',description:'',program:{},durationMinutes:500}),/INVALID_INPUT/);
});

await test('waiting is off until the booth turns it on; only managers change it',async()=>{
  assert.equal((await wait(s1,'booth',{booth})).enabled,false);
  await assert.rejects(wait(s1,'join',{booth,party:2}),/WAITING_DISABLED/);
  await assert.rejects(manage(s1,'board',{booth}),/BOOTH_MANAGER_REQUIRED/);
  const r=await settings();
  assert.equal(r.settings.enabled,true); assert.equal(r.durationMinutes,5);
  const info=await wait(s1,'booth',{booth});
  assert.deepEqual([info.enabled,info.online,info.qr,info.accepting,info.maxParty,info.total,info.durationMinutes],[true,true,true,true,4,0,5]);
});

await test('online registration: numbers from 1, party limit, one entry per booth, wait = teams ahead × minutes',async()=>{
  await assert.rejects(wait(s1,'join',{booth,party:5}),/WAITING_PARTY_LIMIT/);
  await assert.rejects(wait(s1,'join',{booth,party:0}),/INVALID_INPUT/);
  const a=await wait(s1,'join',{booth,party:2});
  assert.deepEqual([a.number,a.position,a.ahead,a.total,a.estimateMinutes,a.status,a.source],[1,1,0,1,0,'waiting','online']);
  const again=await wait(s1,'join',{booth,party:3});
  assert.equal(again.already,true); assert.equal(again.id,a.id); assert.equal(again.party,2);
  const b=await wait(s2,'join',{booth,party:1}), c=await wait(s3,'join',{booth,party:4});
  assert.deepEqual([b.number,b.position,b.estimateMinutes],[2,2,5]);
  assert.deepEqual([c.number,c.position,c.total,c.estimateMinutes],[3,3,3,10]);
  // Another booth keeps its own list.
  await manage(admin,'settings',{booth:other,version:0,enabled:true,online:true,qr:false,maxParty:4,autoNoshow:false,noshowMinutes:5,
    postponeMode:'count',postponeMaxTeams:3,postponeLimit:null,qrMode:'fixed',qrPeriod:30,durationMinutes:90});
  const elsewhere=await wait(s1,'join',{booth:other,party:2});
  assert.equal(elsewhere.number,1);
  assert.equal((await wait(s1,'mine')).items.length,2);
  assert.equal((await outbox(s2)).length,0);
});

await test('each time a team ahead leaves, the students behind get their new place in a push',async()=>{
  const board=await manage(admin,'board',{booth});
  assert.deepEqual(board.active.map(x=>[x.number,x.name,x.studentNumber,x.party]),[[1,'학생1','21001',2],[2,'학생2','21002',1],[3,'학생3','21003',4]]);
  await manage(admin,'enter',{id:board.active[0].id});
  const p2=await outbox(s2,'ahead'), p3=await outbox(s3,'ahead');
  assert.equal(p2.length,1); assert.equal(p3.length,1);
  assert.match(p2[0].body,/대기번호 2번 · 현재 대기순번 1번째 · 현재 대기 2팀 · 예상 대기시간 곧 입장/);
  assert.match(p3[0].body,/대기번호 3번 · 현재 대기순번 2번째 · 현재 대기 2팀 · 예상 대기시간 약 5분/);
  assert.match(p3[0].url,/^\/waiting\/[0-9a-f-]{36}$/);
  assert.equal((await outbox(s1)).length,0);
});

await test('a call is pushed; automatic no-show after the set minutes; cancel by the booth carries the reason',async()=>{
  let board=await manage(admin,'board',{booth});
  await manage(admin,'call',{id:board.active[0].id});
  assert.match((await outbox(s2,'called'))[0].body,/대기번호 2번 · 지금 부스로 와 주세요\./);
  await assert.rejects(manage(admin,'call',{id:board.active[0].id}),/WAITING_FINISHED/);
  await settings({autoNoshow:true,noshowMinutes:3});
  await db.query(`update festival_ops.waiting_entries set called_at=now()-interval '4 minutes' where id=$1`,[board.active[0].id]);
  board=await manage(admin,'board',{booth});
  assert.equal(board.active.length,1);
  assert.deepEqual([board.done[0].status,board.done[0].endedBy],['noshow','auto']);
  assert.equal((await outbox(s2,'noshow')).length,1);
  assert.match((await outbox(s3,'ahead')).at(-1).body,/현재 대기순번 1번째/);
  await assert.rejects(manage(admin,'cancel',{id:board.active[0].id,reason:''}),/INVALID_INPUT/);
  await manage(admin,'cancel',{id:board.active[0].id,reason:'재료가 모두 떨어져 오늘 운영을 마쳐요'});
  assert.equal((await outbox(s3,'cancelled'))[0].body,'취소 사유: 재료가 모두 떨어져 오늘 운영을 마쳐요');
  const mine=(await wait(s3,'mine')).items.find(x=>x.booth===booth);
  assert.deepEqual([mine.status,mine.endedBy,mine.cancelReason],['cancelled','manager','재료가 모두 떨어져 오늘 운영을 마쳐요']);
  assert.equal(await wait(s3,'entry',{id:mine.id}).then(x=>x.cancelReason),'재료가 모두 떨어져 오늘 운영을 마쳐요');
  await assert.rejects(wait(s4,'entry',{id:mine.id}),/WAITING_NOT_FOUND/);
});

await test('postpone: only within 3 teams of the front, by the chosen teams, within the limit',async()=>{
  await settings({postponeMode:'count',postponeMaxTeams:2,postponeLimit:1});
  const joined=[];
  for(const a of [s1,s2,s3,s4,s5,s6]) joined.push(await wait(a,'join',{booth,party:1}));
  assert.deepEqual(joined.map(x=>x.position),[1,2,3,4,5,6]);
  assert.equal(joined[4].postpone.allowed,false);
  await assert.rejects(wait(s5,'postpone',{id:joined[4].id,teams:1}),/WAITING_POSTPONE_NOT_YET/);
  await assert.rejects(wait(s2,'postpone',{id:joined[1].id,teams:3}),/INVALID_INPUT/);
  const moved=await wait(s2,'postpone',{id:joined[1].id,teams:2});
  assert.deepEqual([moved.from,moved.to,moved.entry.position,moved.entry.postponed],[2,4,4,1]);
  const order=(await manage(admin,'board',{booth})).active.map(x=>x.name);
  assert.deepEqual(order,['학생1','학생3','학생4','학생2','학생5','학생6']);
  // The two passed over moved up one place each and were told so.
  assert.match((await outbox(s3,'ahead')).at(-1).body,/현재 대기순번 2번째 · 현재 대기 6팀/);
  assert.match((await outbox(s4,'ahead')).at(-1).body,/현재 대기순번 3번째/);
  await assert.rejects(wait(s2,'postpone',{id:joined[1].id,teams:1}),/WAITING_POSTPONE_LIMIT/);
  await settings({postponeMode:'last',postponeLimit:null});
  const last=await wait(s1,'postpone',{id:joined[0].id});
  assert.deepEqual([last.from,last.to],[1,6]);
  await assert.rejects(wait(s1,'postpone',{id:joined[0].id}),/WAITING_POSTPONE/);
  const called=(await manage(admin,'board',{booth})).active[0];
  await manage(admin,'call',{id:called.id});
  await assert.rejects(wait(s3,'postpone',{id:called.id}),/WAITING_POSTPONE_NOT_YET/);
  await wait(s1,'cancel',{id:joined[0].id});
  await assert.rejects(wait(s1,'cancel',{id:joined[0].id}),/WAITING_FINISHED/);
});

await test('on-site QR: fixed until reissued, rotating per window, and the switches are respected',async()=>{
  for(const a of [s1,s2,s3,s4,s5,s6]) for(const x of (await wait(a,'mine')).items.filter(x=>['waiting','called'].includes(x.status) && x.booth===booth)) await wait(a,'cancel',{id:x.id});
  await settings({online:false,qrMode:'fixed'});
  await assert.rejects(wait(s1,'join',{booth,party:1}),/WAITING_ONLINE_DISABLED/);
  const q=await manage(admin,'qr',{booth});
  assert.match(q.token,/^f1\.[0-9a-f]{24}$/);
  await assert.rejects(wait(s1,'join',{booth,party:1,qr:'f1.'+'0'.repeat(24)}),/WAITING_QR_INVALID/);
  const viaQr=await wait(s1,'join',{booth,party:1,qr:q.token});
  assert.equal(viaQr.source,'qr');
  const re=await manage(admin,'qr_reissue',{booth});
  assert.notEqual(re.token,q.token);
  await assert.rejects(wait(s2,'join',{booth,party:1,qr:q.token}),/WAITING_QR_INVALID/);
  await settings({online:false,qrMode:'rotating',qrPeriod:15});
  const r=await manage(admin,'qr',{booth});
  assert.match(r.token,/^r[0-9]+\.[0-9a-f]{24}$/); assert.ok(r.expiresAt);
  assert.equal((await wait(s2,'join',{booth,party:1,qr:r.token})).source,'qr');
  const stale='r'+(Number(r.token.slice(1).split('.')[0])-600)+'.'+r.token.split('.')[1];
  await assert.rejects(wait(s3,'join',{booth,party:1,qr:stale}),/WAITING_QR_INVALID/);
  await settings({online:true,qr:false});
  await assert.rejects(wait(s3,'join',{booth,party:1,qr:r.token}),/WAITING_QR_DISABLED/);
  await manage(admin,'pause',{booth,paused:true});
  assert.equal((await wait(s3,'booth',{booth})).accepting,false);
  await assert.rejects(wait(s3,'join',{booth,party:1}),/WAITING_PAUSED/);
  await manage(admin,'pause',{booth,paused:false});
  assert.equal((await wait(s3,'join',{booth,party:1})).source,'online');
});

await test('walk-ins join the same list without an account; turning waiting off keeps the list',async()=>{
  const w=await manage(admin,'walkin',{booth,name:'현장 손님',party:3});
  const board=await manage(admin,'board',{booth});
  const row=board.active.find(x=>x.id===w.id);
  assert.deepEqual([row.name,row.studentNumber,row.source,row.party],['현장 손님',null,'walkin',3]);
  await settings({enabled:false});
  await assert.rejects(wait(s4,'join',{booth,party:1}),/WAITING_DISABLED/);
  assert.equal((await manage(admin,'board',{booth})).active.length,board.active.length);
  await manage(admin,'enter',{id:w.id});
});

await test('push subscriptions follow the last account on the device',async()=>{
  const sub={endpoint:'https://push.example.invalid/'+randomUUID(),p256dh:'B'+'A'.repeat(86),auth:'A'.repeat(22)};
  await wait(s1,'push_subscribe',sub);
  await wait(s2,'push_subscribe',sub);
  assert.equal((await one('select user_id from festival_ops.push_subscriptions where endpoint=$1',[sub.endpoint])).user_id,s2.uid);
  await wait(s1,'push_unsubscribe',{endpoint:sub.endpoint});
  assert.equal((await one('select count(*)::int n from festival_ops.push_subscriptions where endpoint=$1',[sub.endpoint])).n,1);
  await assert.rejects(wait(s1,'push_subscribe',{...sub,endpoint:'http://insecure.invalid/x'}),/check constraint|INVALID_INPUT/);
});

await test('posters: up to five, originals kept apart from the public catalog, only operators list them',async()=>{
  const st=(await manager(admin,'status')).items.find(b=>b.key===booth);
  const poster=()=>({image:`booths/${randomBytes(16).toString('hex')}.jpg`,original:`posters/${randomBytes(16).toString('hex')}.png`,name:'포스터 원본.png'});
  const list=[poster(),poster()];
  const saved=await manager(admin,'save',{booth,version:st.version,status:'open',description:'',program:{},posters:list});
  assert.deepEqual(saved.posters.map(p=>[p.image,p.name]),list.map(p=>[p.image,'포스터 원본.png']));
  const cat=(await rpc(s1,'select public.festival_ops_read($1,$2) value',['catalog',{}])).items?.find?.(b=>b.key===booth)
    || (await rpc(s1,'select public.festival_ops_read($1,$2) value',['catalog',{}])).find?.(b=>b.key===booth);
  assert.deepEqual(cat.posters,list.map(p=>p.image));
  assert.ok(!JSON.stringify(cat).includes('posters/'));
  await assert.rejects(rpc(s1,'select public.festival_booth_posters_admin() value'),/ADMIN_REQUIRED/);
  const all=await rpc(admin,'select public.festival_booth_posters_admin() value');
  assert.deepEqual(all.items.find(b=>b.key===booth).posters.map(p=>p.original),list.map(p=>p.original));
  // Keeping the second, dropping the first: the dropped original comes back to be deleted.
  const kept=await manager(admin,'save',{booth,version:saved.version,status:'open',description:'',program:{},posters:[{image:list[1].image}]});
  assert.deepEqual(kept.removedPosters,[list[0].original]);
  await assert.rejects(manager(admin,'save',{booth,version:kept.version,status:'open',description:'',program:{},posters:[poster(),poster(),poster(),poster(),poster(),poster()]}),/INVALID_INPUT/);
  await assert.rejects(manager(admin,'save',{booth,version:kept.version,status:'open',description:'',program:{},posters:[{image:poster().image}]}),/INVALID_INPUT/);
});

await test('deleting an account removes its waiting entries and push subscriptions',async()=>{
  const sub={endpoint:'https://push.example.invalid/'+randomUUID(),p256dh:'B'+'A'.repeat(86),auth:'A'.repeat(22)};
  await wait(s6,'push_subscribe',sub);
  await wait(s6,'join',{booth,party:1}).catch(()=>{});
  await settings({enabled:true,online:true});
  await wait(s6,'join',{booth,party:1});
  await rpc(admin,'select public.festival_account_delete($1,$2) value',[{studentNumber:'21006',confirm:'삭제',reason:'Synthetic duplicate account'},randomUUID()]);
  for(const t of ['waiting_entries','push_subscriptions','push_outbox']) assert.equal((await one(`select count(*)::int n from festival_ops.${t} where user_id=$1`,[s6.uid])).n,0,t);
});

await test('the rollback removes waiting and posters and restores the previous booth save',async()=>{
  await sql('operations-server/waiting-rollback.sql');
  assert.equal(await one("select to_regclass('festival_ops.waiting_entries') r").then(r=>r.r),null);
  assert.equal(await one("select to_regprocedure('public.festival_waiting(text,jsonb)') r").then(r=>r.r),null);
  const st=(await manager(admin,'status')).items.find(b=>b.key===booth);
  assert.ok(!('durationMinutes' in st));
  const saved=await manager(admin,'save',{booth,version:st.version,status:'open',description:'',program:{hours:'10:00–11:00'}});
  assert.equal(saved.program.hours,'10:00–11:00');
  // Account deletion works again without the waiting tables.
  assert.doesNotMatch((await one("select pg_get_functiondef('public.festival_account_delete(jsonb,uuid)'::regprocedure) d")).d,/waiting_entries|push_/);
  assert.equal((await rpc(admin,'select public.festival_account_delete($1,$2) value',[{studentNumber:'21005',confirm:'삭제',reason:'Synthetic duplicate account'},randomUUID()])).deleted,true);
  await sql('operations-server/waiting.sql');
  assert.ok(await one("select to_regprocedure('public.festival_waiting(text,jsonb)') r").then(r=>r.r));
  assert.match((await one("select pg_get_functiondef('public.festival_account_delete(jsonb,uuid)'::regprocedure) d")).d,/delete from festival_ops\.waiting_entries where user_id=target;/);
});

fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
fs.writeFileSync(path.join(root,'test-results/waiting-isolated.json'),JSON.stringify(results,null,2));
const failed=results.filter(r=>!r.ok);
console.log(`${results.length-failed.length}/${results.length} passed`);
process.exit(failed.length?1:0);
