// Real browser and operations SQL; all remote requests terminate in local PGlite (storage is mocked).
// Covers 부스 담당자 (grant, edit, manual stamp), notice pages with photos, and the map card X.
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
for(const file of ['nfc-server/isolated-test/shim.sql','nfc-server/install.sql','nfc-server/admin-issue.sql','nfc-server/reviews.sql','operations-server/install.sql']) await db.exec(fs.readFileSync(path.join(root,file),'utf8'));
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
await write(admin,'event_save',{name:'부스 담당자 격리 검증',state:'open',reviewPoints:10,version:0});
for(const file of ['review-identity.draft','reward-visits','reward-fixed-milestones','voucher-unlimited-and-reset','review-identity-self','voucher-short-code','review-distribution-self-redeem','nfc-tag-registry','claim-guard','booth-bulk-and-tag-register','notices','operator-identity-and-scoped-reset','self-identity-and-own-club-stamps','student-number-display','student-number-only','operator-self-actions','sun-nfc','booth-managers','notice-images','booth-profile'])
  await db.exec(fs.readFileSync(path.join(root,`operations-server/${file}.sql`),'utf8'));
for(const {key} of (await db.query('select key from festival_ops.booths')).rows) await write(admin,'booth_save',{booth:key,name:key,status:'open',floor:1,version:1});
const eventId=(await db.query('select id from festival_ops.events where current')).rows[0].id;
const catalog=(await db.query('select key from festival_ops.booths order by key collate "C"')).rows.map(r=>r.key);
const CLUB='인벨릭스';
await db.query('select festival_ops.import_review_roster($1,$2,$3)',[eventId,{format:1,sourceSha256:'a'.repeat(64),catalogKeys:catalog,
  records:[{studentNumber:'11001',realName:'가상담당',clubs:['인벨릭스'],boothKeys:[CLUB],status:'ready',issues:[],sourceCells:['Synthetic!A1']}]},admin.uid]);
const lead=await account(false,'11001','가상담당'), visitor=await account(false,'21001','가상방문');
await rpc(lead,'select public.festival_review_identity_self($1,$2) value',['confirm',{eventId,realName:'가상담당'}]);

const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==','base64');
const output=path.join(root,'artifacts/booth-manager'); fs.mkdirSync(output,{recursive:true});
const browser=await chromium.launch({headless:true,channel:process.env.CHROME_PATH?undefined:'msedge',executablePath:process.env.CHROME_PATH});
const pages=[], uploads=[], boothUploads=[], removed=[];
async function pageFor(a,width=390) {
  const context=await browser.newContext({viewport:{width,height:850},isMobile:true,hasTouch:true});
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
        (bucket==='festival-booths'?boothUploads:uploads).push(url.pathname.slice(`/storage/v1/object/${bucket}/`.length));
        return route.fulfill({json:{Key:url.pathname.slice('/storage/v1/object/'.length)}});
      }
      if(bucket && url.pathname===`/storage/v1/object/${bucket}` && req.method()==='DELETE') { removed.push(...(req.postDataJSON().prefixes||[])); return route.fulfill({json:[]}); }
      let value; const p=req.method()==='POST'?req.postDataJSON():{};
      const call=(name,sql,args)=>rpc(a,`select public.${name}(${sql}) value`,args);
      if(url.pathname==='/rest/v1/booths') value=(await db.query('select id,name,rating,position from public.booths')).rows;
      else if(url.pathname==='/rest/v1/rpc/festival_nfc_profile') value=await call('festival_nfc_profile','',[]);
      else if(url.pathname==='/rest/v1/rpc/festival_ops_read') value=await call('festival_ops_read','$1,$2',[p.p_kind,p.p_query]);
      else if(url.pathname==='/rest/v1/rpc/festival_ops_write') value=await call('festival_ops_write','$1,$2,$3',[p.p_action,p.p_payload,p.p_request_id]);
      else if(url.pathname==='/rest/v1/rpc/festival_notices') value=await call('festival_notices','',[]);
      else if(url.pathname==='/rest/v1/rpc/festival_notice_admin') value=await call('festival_notice_admin','$1,$2',[p.p_action,p.p_payload]);
      else if(url.pathname==='/rest/v1/rpc/festival_booth_manager') value=await call('festival_booth_manager','$1,$2,$3',[p.p_action,p.p_payload,p.p_request_id ?? null]);
      else if(url.pathname==='/rest/v1/rpc/festival_booth_manager_admin') value=await call('festival_booth_manager_admin','$1,$2',[p.p_action,p.p_payload]);
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
async function check(page,name,width=390) {
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`overflow ${name}`);
  await page.screenshot({path:path.join(output,`${width}-${name}.png`),fullPage:true});
}
const flows=[];
try {
  // Operator: a notice with a photo.
  const a=await pageFor(admin);
  await routeTo(a.page,'admin');
  await openOperatorTool(a.page,'notice_admin');
  const nf=a.page.locator('[data-ops-form=notice_save]');
  await nf.waitFor();
  await nf.locator('[name=title]').fill('부스 운영 시간 안내');
  await nf.locator('[name=body]').fill('오늘 부스는 오후 4시까지 운영해요.\n사진을 확인해 주세요.');
  await nf.locator('[name=important]').check();
  await nf.locator('[data-notice-file]').setInputFiles({name:'photo.png',mimeType:'image/png',buffer:PNG});
  await nf.locator('.ops-notice-images li').first().waitFor();
  await check(a.page,'notice-editor');
  await nf.locator('button[type=submit]').click();
  await a.page.getByText('공지를 등록했어요.',{exact:false}).waitFor();
  const saved=(await db.query('select id,images from festival_ops.notices')).rows[0];
  assert.equal(saved.images.length,1); assert.deepEqual(uploads,saved.images);
  flows.push('notice photo upload');

  // Operator: grant 부스 담당자 with manual approval.
  await openOperatorTool(a.page,'booth_managers');
  const find=a.page.locator('[data-bm-find]');
  await find.waitFor();
  await find.locator('[name=studentNumber]').fill('21001');
  await find.locator('button[type=submit]').click();
  await a.page.getByText('소속 확인이 끝나지 않았어요',{exact:false}).waitFor();
  await find.locator('[name=studentNumber]').fill('11001');
  await find.locator('button[type=submit]').click();
  const grant=a.page.locator('[data-bm-grant]');
  await grant.waitFor();
  assert.equal(await grant.locator('[name=booth]').inputValue(),CLUB);
  await grant.locator('[name=canApprove]').check();
  await grant.locator('button[type=submit]').click();
  await a.page.getByText('부스 담당자로 지정했어요',{exact:false}).waitFor();
  await a.page.getByText('스탬프 수동 승인 허용',{exact:false}).first().waitFor();
  await check(a.page,'grant');
  flows.push('grant with approval');

  // Manager: edit the booth and approve a manual stamp.
  const m=await pageFor(lead);
  await routeTo(m.page,'profile');
  const manage=m.page.locator('[data-route=manage]');
  await manage.waitFor();
  assert.match(await manage.innerText(),/부스 관리/);
  await manage.click();
  const form=m.page.locator('[data-manager-save]');
  await form.waitFor();
  await form.locator('[name=description]').fill('코딩 동아리 인벨릭스의 부스예요.');
  await form.locator('[name="program.title"]').fill('미니 해커톤 체험');
  await form.locator('[name="program.hours"]').fill('10:00-15:00');
  // Profile photo, floor and map room; the room list follows the floor.
  await form.locator('[data-manager-photo-file]').setInputFiles({name:'booth.png',mimeType:'image/png',buffer:PNG});
  await form.locator('[data-manager-photo] img[src^="blob:"]').waitFor();
  await form.locator('[name=floor]').selectOption('3');
  assert.ok((await form.locator('[name=room] option').allInnerTexts()).includes('진로상담부'));
  await form.locator('[name=room]').selectOption('다목적강당');
  await check(m.page,'manager-profile');
  await form.locator('button[type=submit]').click();
  await m.page.getByText('부스 정보를 저장했어요.',{exact:false}).waitFor();
  const booth=(await db.query('select description,program,floor,room,location,image from festival_ops.booths where key=$1',[CLUB])).rows[0];
  assert.equal(booth.description,'코딩 동아리 인벨릭스의 부스예요.'); assert.equal(booth.program.title,'미니 해커톤 체험');
  assert.equal(booth.floor,3); assert.equal(booth.room,'다목적강당'); assert.equal(booth.location,'3층 다목적강당');
  assert.deepEqual(boothUploads,[booth.image]); assert.equal(booth.program.hours,'10:00-15:00');
  assert.match(await m.page.locator('[data-manager-photo] img').getAttribute('src'),/festival-booths\/booths\//);
  flows.push('manager photo and location');
  await m.page.locator('[data-manager-lookup] [name=studentNumber]').fill('21001');
  await m.page.locator('[data-manager-lookup] button[type=submit]').click();
  await m.page.locator('[data-manager-approve]').waitFor();
  await m.page.locator('[data-manager-approve] [name=reason]').fill('부스 체험 완료');
  await check(m.page,'manager');
  await m.page.locator('[data-manager-approve] button[type=submit]').click();
  await m.page.getByText('스탬프 1개를 적립했어요',{exact:false}).waitFor();
  const visit=(await db.query('select method,actor_id from festival_ops.visits where user_id=$1 and booth_key=$2',[visitor.uid,CLUB])).rows[0];
  assert.equal(visit.method,'manual'); assert.equal(visit.actor_id,lead.uid);
  flows.push('manager edit','manager approval');

  // Participant: the notice strip opens the notice page with its photo; the bell opens the list.
  const v=await pageFor(visitor);
  await routeTo(v.page,'home');
  await v.page.locator('.festival-notice-strip').click();
  await v.page.locator('.festival-notice-article h2',{hasText:'부스 운영 시간 안내'}).waitFor();
  assert.equal(await v.page.evaluate(()=>state.route),'notice');
  const src=await v.page.locator('.festival-notice-photo').getAttribute('src');
  assert.equal(src,`${PROJECT_URL}/storage/v1/object/public/festival-notices/${saved.images[0]}`);
  await v.page.waitForFunction(()=>document.querySelector('.festival-notice-photo')?.complete);
  await check(v.page,'notice');
  await routeTo(v.page,'home');
  await v.page.locator('[data-route=notices]').first().click();
  await v.page.locator('.festival-notice-row').first().waitFor();
  await v.page.locator('.festival-notice-row').first().click();
  await v.page.locator('.festival-notice-article').waitFor();
  flows.push('notice strip','notice list');

  // Booth page shows the manager's program; 지도에서 위치 보기 then X stays on the map.
  const id=await v.page.evaluate(k=>state.db.booths.find(b=>boothKeyFor(b)===k)?.id,CLUB);
  await v.page.evaluate(id=>goDetail(id),id);
  await v.page.getByText('미니 해커톤 체험',{exact:true}).waitFor();
  // The manager's photo, hours and place on the booth page.
  assert.match(await v.page.locator('.detail-hero .club-visual img').getAttribute('src'),/festival-booths\/booths\/[0-9a-f]{32}\.jpg$/);
  assert.match(await v.page.locator('.detail-status-row').innerText(),/10:00-15:00/);
  assert.match(await v.page.locator('.detail-club-heading .meta').innerText(),/3층 · 다목적강당/);
  assert.doesNotMatch(await v.page.locator('.detail-club-heading .meta').innerText(),/임시 배치/);
  await check(v.page,'booth-detail');
  await v.page.locator('[data-locate-booth]').click();
  await v.page.locator('.map-preview-card').waitFor();
  // 3층, inside 다목적강당.
  assert.equal(await v.page.evaluate(()=>state.floor),3);
  assert.equal(await v.page.locator(`.plan-room[data-map-select="${id}"] span`).innerText(),'다목적강당');
  await v.page.locator('[data-clear-selection]').click();
  await v.page.waitForFunction(()=>!document.querySelector('.map-preview-card'));
  assert.equal(await v.page.evaluate(()=>state.route),'map');
  flows.push('booth program','map card X');
  // The list chips do not scroll sideways and the "방문 후 평가" chip is gone.
  await v.page.evaluate(()=>{setSheetLevel('full');render();});
  assert.equal(await v.page.getByText('방문 후 평가').count(),0);
  assert.equal(await v.page.locator('.booth-stats').first().evaluate(e=>getComputedStyle(e).overflowX),'visible');
  await check(v.page,'map-list');
  flows.push('list chips');

  for(const {errors} of pages) assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,flows}));
} finally { await browser.close(); }
