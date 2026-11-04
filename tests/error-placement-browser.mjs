// Real browser and operations SQL; all remote requests terminate in local PGlite (storage is mocked).
// Every screen where an action can fail: the failure is forced, then the message must sit next to the
// pressed button and inside the viewport (not at the top of the screen), and typed input must stay.
// Also covers operating hours picked with time inputs.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require('playwright');
const {openOperatorTool}=require('./operator-navigation.cjs');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=path.join(process.env.PGLITE_DIR,'node_modules/@electric-sql/pglite/dist');
const {PGlite}=await import(pathToFileURL(path.join(dir,'index.js')));
const {pgcrypto}=await import(pathToFileURL(path.join(dir,'contrib/pgcrypto.js')));
const {PROJECT_URL}=require('../supabase-catalog.js');
const db=new PGlite({extensions:{pgcrypto}});
for(const file of ['nfc-server/isolated-test/shim.sql','nfc-server/install.sql','nfc-server/admin-issue.sql','nfc-server/updates/20260930-nonexpiring-tags.sql','nfc-server/reviews.sql','operations-server/install.sql']) await db.exec(fs.readFileSync(path.join(root,file),'utf8'));
let queue=Promise.resolve();
function rpc(a,sql,args=[]) {
  const call=queue.then(async()=>{
    await db.exec('begin');
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:a.id,session_id:a.session,role:'authenticated'})]);
      await db.exec('set local role authenticated');
      const r=await db.query(sql,args); await db.exec('commit'); return r.rows[0].value;
    } catch(e) { await db.exec('rollback'); throw e; }
  }); queue=call.catch(()=>{}); return call;
}
async function account(admin,studentNumber,name='격리 학생') {
  const a={id:randomUUID(),session:randomUUID()};
  await db.query(`insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data) values($1,$2,now(),'{"provider":"google"}',$3)`,[a.id,`${a.id}@example.invalid`,{full_name:name,festival_name:name,festival_student_number:studentNumber}]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[a.session,a.id]);
  a.uid=(await rpc(a,'select public.festival_nfc_profile() value')).id;
  if(admin) await db.query('update public.users set admin=true where id=$1',[a.uid]);
  const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
  a.jwt=`${enc({alg:'HS256',typ:'JWT'})}.${enc({sub:a.id,session_id:a.session,exp:4102444800,role:'authenticated'})}.fixture`;
  return a;
}
const admin=await account(true,'29999','격리 운영자');
const write=(a,k,p)=>rpc(a,'select public.festival_ops_write($1,$2,$3) value',[k,p,randomUUID()]);
await write(admin,'event_save',{name:'오류 위치 격리 검증',state:'open',reviewPoints:10,version:0});
for(const file of ['review-identity.draft','reward-visits','reward-fixed-milestones','voucher-unlimited-and-reset','review-identity-self','voucher-short-code','review-distribution-self-redeem','nfc-tag-registry','claim-guard','booth-bulk-and-tag-register','notices','operator-identity-and-scoped-reset','self-identity-and-own-club-stamps','student-number-display','student-number-only','operator-self-actions','sun-nfc','booth-managers','notice-images','booth-profile','manual-voucher-issue'])
  await db.exec(fs.readFileSync(path.join(root,`operations-server/${file}.sql`),'utf8'));
for(const {key} of (await db.query('select key from festival_ops.booths')).rows) await write(admin,'booth_save',{booth:key,name:key,status:'open',floor:1,version:1});
const eventId=(await db.query('select id from festival_ops.events where current')).rows[0].id;
const catalog=(await db.query('select key from festival_ops.booths order by key collate "C"')).rows.map(r=>r.key);
const CLUB='인벨릭스';
await db.query('select festival_ops.import_review_roster($1,$2,$3)',[eventId,{format:1,sourceSha256:'b'.repeat(64),catalogKeys:catalog,
  records:[{studentNumber:'11001',realName:'가상담당',clubs:['인벨릭스'],boothKeys:[CLUB],status:'ready',issues:[],sourceCells:['Synthetic!A1']}]},admin.uid]);
const lead=await account(false,'11001','가상담당'), visitor=await account(false,'21001','가상방문');
await rpc(lead,'select public.festival_review_identity_self($1,$2) value',['confirm',{eventId,realName:'가상담당'}]);
await rpc(admin,'select public.festival_booth_manager_admin($1,$2) value',['grant',{account:{studentNumber:'11001'},booth:CLUB,canApprove:true}]);
// A notice to delete, secure cards and issued tags: long lists, so the last row is far down.
await rpc(admin,'select public.festival_notice_admin($1,$2) value',['save',{id:null,version:0,title:'삭제할 공지',body:'오류 위치 확인용 공지예요.',important:false,published:true}]);
await rpc(admin,'select public.festival_sun_admin($1,$2) value',['keys_create',{metaKey:'00112233445566778899aabbccddeeff',fileKey:'ffeeddccbbaa99887766554433221100'}]);
const cards=[];
for(let i=0;i<6;i++) { const uid=`04A1B2C3D4E5${String(i).padStart(2,'0')}`; cards.push(uid);
  await db.query('insert into festival_nfc_private.sun_cards(uid,booth,label,last_counter) values($1,$2,$3,0)',[uid,catalog[i],`카드 ${i+1}`]); }
const tags=[];
for(let i=0;i<8;i++) tags.push((await rpc(admin,'select public.festival_nfc_tag_admin($1,$2) value',['issue',{booth:catalog[i],label:`태그 ${i+1}`}])).tagId);

const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==','base64');
const output=path.join(root,'artifacts/error-placement'); fs.mkdirSync(output,{recursive:true});
const browser=await chromium.launch({headless:true,channel:process.env.CHROME_PATH?undefined:'msedge',executablePath:process.env.CHROME_PATH});
// Forced failures: '<rpc>:<action>' answers once with INVALID_INPUT ("입력한 내용을 확인해 주세요.").
const fail=new Set(); let failUpload=false;
const pages=[];
async function pageFor(a,width=390) {
  const context=await browser.newContext({viewport:{width,height:760},isMobile:true,hasTouch:true});
  await context.addInitScript(a=>localStorage.setItem('pangyo-google-session-v1',JSON.stringify({access_token:a.jwt,refresh_token:'fixture',token_type:'bearer',expires_at:4102444800,expires_in:3600,user:{id:a.id}})),a);
  const page=await context.newPage(), errors=[];
  page.on('pageerror',e=>errors.push(e.message)); page.on('dialog',d=>d.accept());
  await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());
    if(url.protocol==='file:') return route.continue();
    if(url.origin!==PROJECT_URL) return route.abort();
    try {
      const bucket=/^\/storage\/v1\/object\/(?:public\/)?(festival-notices|festival-booths)(?:\/|$)/.exec(url.pathname)?.[1];
      if(url.pathname.startsWith(`/storage/v1/object/public/${bucket}/`)) return route.fulfill({status:200,contentType:'image/png',body:PNG});
      if(bucket && url.pathname.startsWith(`/storage/v1/object/${bucket}/`) && req.method()==='POST') {
        if(failUpload) { failUpload=false; return route.fulfill({status:500,json:{statusCode:'500',error:'Internal',message:'upload failed'}}); }
        return route.fulfill({json:{Key:url.pathname.slice('/storage/v1/object/'.length)}});
      }
      if(bucket && req.method()==='DELETE') return route.fulfill({json:[]});
      const p=req.method()==='POST'?req.postDataJSON():{};
      const name=url.pathname.replace('/rest/v1/rpc/','');
      const key=`${name}:${p.p_action ?? p.p_kind ?? ''}`;
      if(process.env.DEBUG_CALLS && name.startsWith('festival_sun')) console.log('CALL',key,JSON.stringify(p.p_payload));
      if(fail.has(key)) { fail.delete(key); return route.fulfill({status:400,json:{code:'P0001',message:'INVALID_INPUT'}}); }
      const call=(sql,args)=>rpc(a,`select public.${name}(${sql}) value`,args);
      let value;
      if(url.pathname==='/rest/v1/booths') value=(await db.query('select id,name,rating,position from public.booths')).rows;
      else if(['festival_nfc_profile','festival_notices','festival_reward_read','festival_booth_stamp_counts'].includes(name)) value=await call('',[]);
      else if(name==='festival_ops_read') value=await call('$1,$2',[p.p_kind,p.p_query]);
      else if(['festival_ops_write','festival_ops_write_student'].includes(name)) value=await call('$1,$2,$3',[p.p_action,p.p_payload,p.p_request_id]);
      else if(['festival_notice_admin','festival_booth_manager_admin','festival_sun_admin','festival_nfc_tag_admin','festival_review_identity_self'].includes(name)) value=await call('$1,$2',[p.p_action,p.p_payload]);
      else if(name==='festival_booth_manager') value=await call('$1,$2,$3',[p.p_action,p.p_payload,p.p_request_id ?? null]);
      else if(name==='festival_student_lookup') value=await call('$1',[p.p_payload]);
      else if(url.pathname==='/auth/v1/logout') return route.fulfill({status:204});
      else return route.fulfill({status:404,json:{code:'PGRST202',message:'Missing optional function'}});
      return route.fulfill({json:value});
    } catch(e) { return route.fulfill({status:400,json:{code:e.code || 'TEST_ERROR',message:e.message}}); }
  });
  await page.goto(pathToFileURL(path.join(root,'index.html')).href);
  await page.waitForFunction(()=>festivalOpsUI.snapshot()?.ready);
  pages.push({page,errors});
  return {page,context,errors};
}
const routeTo=(page,route)=>page.evaluate(r=>{state.route=r;render();},route);
const checks=[];
// The message (CSS selector) shows `text`, lies inside the viewport and within 160px of the button.
async function near(page,name,message,button,text) {
  await page.waitForFunction(([m,t])=>new RegExp(t).test(document.querySelector(m)?.textContent || ''),[message,text.source],{timeout:10000})
    .catch(()=>{});
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const r=await page.evaluate(([m,b])=>{
    const node=document.querySelector(m), btn=document.querySelector(b);
    if(!node) return {missing:'message'};
    const x=node.getBoundingClientRect(), y=btn?.getBoundingClientRect();
    return {text:node.textContent.trim(),top:Math.round(x.top),bottom:Math.round(x.bottom),height:innerHeight,
      gap:y?Math.round(Math.max(0,x.top-y.bottom,y.top-x.bottom)):null};
  },[message,button]);
  const ok=!r.missing && text.test(r.text) && r.top>=0 && r.bottom<=r.height && r.gap!==null && r.gap<=160;
  checks.push({name,ok,...r});
  await page.screenshot({path:path.join(output,`${name}.png`)});
}
const ERR=/입력한 내용을 확인해 주세요/;
try {
  // 부스 관리 (manager): save, photo upload, hours, lookup, approve.
  const m=await pageFor(lead);
  await routeTo(m.page,'profile');
  await m.page.locator('[data-route=manage]').click();
  const form=m.page.locator('[data-manager-save]');
  await form.waitFor();
  await form.locator('[name=description]').fill('저장이 실패해도 남아야 하는 소개');
  fail.add('festival_booth_manager:save');
  await form.locator('button[type=submit]').click();
  await near(m.page,'manager-save','[data-spot="save"]','[data-manager-save] button[type=submit]',ERR);
  assert.equal(await form.locator('[name=description]').inputValue(),'저장이 실패해도 남아야 하는 소개');

  await form.locator('[data-manager-photo-file]').setInputFiles({name:'booth.png',mimeType:'image/png',buffer:PNG});
  await form.locator('[data-manager-photo] img[src^="blob:"]').waitFor();
  failUpload=true;
  await form.locator('button[type=submit]').click();
  await near(m.page,'manager-photo-upload','[data-spot="save"]','[data-manager-save] button[type=submit]',/요청을 완료하지 못했어요|사진을 올리지 못했어요/);
  await form.locator('[data-manager-photo-undo]').click();

  // Operating hours with the clock picker: an end before the start, then two ranges.
  const rows=form.locator('[data-hour-row]');
  await rows.nth(0).locator('[name=hourFrom]').fill('12:00');
  await rows.nth(0).locator('[name=hourTo]').fill('10:00');
  await form.locator('button[type=submit]').click();
  await near(m.page,'manager-hours','[data-spot="hours"]','[data-hours-add]',/끝 시간은 시작 시간보다 늦어야 해요/);
  await rows.nth(0).locator('[name=hourFrom]').fill('10:00');
  await rows.nth(0).locator('[name=hourTo]').fill('12:00');
  await form.locator('[data-hours-add]').click();
  await rows.nth(1).locator('[name=hourFrom]').fill('13:00');
  await rows.nth(1).locator('[name=hourTo]').fill('15:30');
  await m.page.screenshot({path:path.join(output,'manager-hours-picker.png')});
  await form.locator('button[type=submit]').click();
  await near(m.page,'manager-save-success','[data-spot="save"]','[data-manager-save] button[type=submit]',/부스 정보를 저장했어요/);
  const saved=(await db.query('select description,program from festival_ops.booths where key=$1',[CLUB])).rows[0];
  assert.equal(saved.program.hours,'10:00–12:00, 13:00–15:30'); assert.equal(saved.description,'저장이 실패해도 남아야 하는 소개');
  assert.equal(await m.page.locator('[data-hour-row]').count(),2);
  assert.equal(await m.page.locator('[data-hour-row] [name=hourTo]').nth(1).inputValue(),'15:30');

  await m.page.locator('[data-manager-lookup] [name=studentNumber]').fill('19999');
  await m.page.locator('[data-manager-lookup] button[type=submit]').click();
  await near(m.page,'manager-lookup','[data-spot="lookup"]','[data-manager-lookup] button[type=submit]',/이 학번으로 가입한 계정이 없어요/);
  assert.equal(await m.page.locator('[data-manager-lookup] [name=studentNumber]').inputValue(),'19999');
  await m.page.locator('[data-manager-lookup] [name=studentNumber]').fill('21001');
  await m.page.locator('[data-manager-lookup] button[type=submit]').click();
  await m.page.locator('[data-manager-approve]').waitFor();
  await m.page.locator('[data-manager-approve] [name=reason]').fill('부스 체험 완료');
  fail.add('festival_booth_manager:visit_approve');
  await m.page.locator('[data-manager-approve] button[type=submit]').click();
  await near(m.page,'manager-approve','[data-spot="approve"]','[data-manager-approve] button[type=submit]',ERR);
  assert.equal(await m.page.locator('[data-manager-approve] [name=reason]').inputValue(),'부스 체험 완료');

  // 관리 마법사 → 부스 담당자: find, grant, revoke on a list row.
  const a=await pageFor(admin);
  await routeTo(a.page,'admin');
  await openOperatorTool(a.page,'booth_managers');
  const find=a.page.locator('[data-bm-find]');
  await find.waitFor(); await a.page.locator('.manager-list li').first().waitFor();
  await find.locator('[name=studentNumber]').fill('19999');
  await find.locator('button[type=submit]').click();
  await near(a.page,'admin-find','[data-spot="find"]','[data-bm-find] button[type=submit]',/계정이 없어요|찾을 수 없어요|확인해 주세요/);
  assert.equal(await find.locator('[name=studentNumber]').inputValue(),'19999');
  await find.locator('[name=studentNumber]').fill('11001');
  await find.locator('button[type=submit]').click();
  await a.page.locator('[data-bm-grant]').waitFor();
  fail.add('festival_booth_manager_admin:grant');
  await a.page.locator('[data-bm-grant] button[type=submit]').click();
  await near(a.page,'admin-grant','[data-spot="grant"]','[data-bm-grant] button[type=submit]',ERR);
  fail.add('festival_booth_manager_admin:revoke');
  await a.page.locator('[data-bm-revoke="0"]').click();
  await near(a.page,'admin-revoke','.manager-list li:first-child [data-spot]','[data-bm-revoke="0"]',ERR);

  // 공지 관리: a failed delete under its button, the editor stays.
  await openOperatorTool(a.page,'notice_admin');
  await a.page.locator('[data-notice-edit]').first().click();
  await a.page.locator('[data-notice-delete]').waitFor();
  fail.add('festival_notice_admin:delete');
  await a.page.locator('[data-notice-delete]').click();
  await near(a.page,'notice-delete','[data-spot="notice-delete"]','[data-notice-delete]',ERR);
  assert.equal(await a.page.locator('[data-ops-form=notice_save]').count(),1);

  // 부스 상태·프로그램 (an ops form): the form's own status line.
  await openOperatorTool(a.page,'catalog');
  const boothForm=a.page.locator('[data-ops-form=booth_save]');
  await boothForm.waitFor();
  fail.add('festival_ops_write:booth_save');
  await boothForm.locator('button[type=submit]').click();
  await near(a.page,'ops-booth-save','[data-ops-form=booth_save] .ops-form-status','[data-ops-form=booth_save] button[type=submit]',ERR);

  // 보안 NFC 카드: enable switch, and the last card's memo and stop buttons.
  await openOperatorTool(a.page,'sun');
  await a.page.locator('.sun-card-list li').nth(5).waitFor();
  fail.add('festival_sun_admin:enable');
  await a.page.locator('[data-sun-enable]').click();
  await near(a.page,'sun-enable','[data-spot="keys"]','[data-sun-enable]',ERR);
  const row=a.page.locator('.sun-card-list li').last(), last=await row.locator('[data-sun-edit]').getAttribute('data-sun-edit');
  await row.locator('summary').click();
  await row.locator('[name=label]').fill('바꾼 메모');
  fail.add('festival_sun_admin:label');
  await row.locator('button[type=submit]').click();
  await near(a.page,'sun-card-label',`[data-spot="card:${last}"]`,`[data-sun-edit="${last}"] button[type=submit]`,ERR);
  assert.equal(await row.locator('[name=label]').inputValue(),'바꾼 메모');
  fail.add('festival_sun_admin:revoke');
  await row.locator('[data-sun-toggle]').click();
  await near(a.page,'sun-card-revoke',`[data-spot="card:${last}"]`,`[data-sun-toggle="${last}"]`,ERR);

  // NFC 태그 발급: the last issued tag's 사용 중지.
  await openOperatorTool(a.page,'nfc');
  const tagId=tags[7];
  await a.page.locator(`[data-server-tag="revoke"][data-tag="${tagId}"]`).waitFor();
  fail.add('festival_nfc_tag_admin:revoke');
  await a.page.locator(`[data-server-tag="revoke"][data-tag="${tagId}"]`).click();
  await near(a.page,'tag-revoke',`[data-spot="tag:${tagId}"]`,`[data-server-tag="revoke"][data-tag="${tagId}"]`,ERR);

  for(const {errors} of pages) assert.deepEqual(errors,[]);
  const failed=checks.filter(c=>!c.ok);
  console.log(JSON.stringify({passed:!failed.length,checks},null,1));
  assert.deepEqual(failed,[]);
} finally { await browser.close(); }
