// Operator NFC screen in a real browser: issue with a memo, list, stop, restore, re-copy and rename.
// The page is served from a synthetic HTTPS origin; every Supabase request is answered by PGlite.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require('playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=path.join(process.env.PGLITE_DIR,'node_modules/@electric-sql/pglite/dist');
const {PGlite}=await import(pathToFileURL(path.join(dir,'index.js')));
const {pgcrypto}=await import(pathToFileURL(path.join(dir,'contrib/pgcrypto.js')));
const {PROJECT_URL}=require('../supabase-catalog.js');
const SITE='https://festival.test';
const db=new PGlite({extensions:{pgcrypto}});
const sql=file=>db.exec(fs.readFileSync(path.join(root,file),'utf8'));
for(const file of ['nfc-server/isolated-test/shim.sql','nfc-server/install.sql','nfc-server/admin-issue.sql','nfc-server/updates/20260930-nonexpiring-tags.sql','nfc-server/reviews.sql','operations-server/install.sql']) await sql(file);
let queue=Promise.resolve();
function rpc(a,query,args=[]) {
  const call=queue.then(async()=>{
    await db.exec('begin');
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:a.id,session_id:a.session,role:'authenticated'})]);
      await db.exec('set local role authenticated');
      const r=await db.query(query,args); await db.exec('commit'); return r.rows[0].value;
    } catch(e) { await db.exec('rollback'); throw e; }
  }); queue=call.catch(()=>{}); return call;
}
async function account(studentNumber,admin=false) {
  const a={id:randomUUID(),session:randomUUID(),studentNumber};
  await db.query(`insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data) values($1,$2,now(),'{"provider":"google"}',$3)`,[a.id,`${a.id}@example.invalid`,{full_name:'격리 운영자',festival_name:'격리 운영자',festival_student_number:studentNumber}]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[a.session,a.id]);
  a.uid=(await rpc(a,'select public.festival_nfc_profile() value')).id;
  if(admin) await db.query('update public.users set admin=true where id=$1',[a.uid]);
  const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
  a.jwt=`${enc({alg:'HS256',typ:'JWT'})}.${enc({sub:a.id,session_id:a.session,exp:4102444800,role:'authenticated'})}.fixture`;
  return a;
}
const admin=await account('29999',true);
const write=(a,k,p)=>rpc(a,'select public.festival_ops_write($1,$2,$3) value',[k,p,randomUUID()]);
await write(admin,'event_save',{name:'Synthetic NFC event',state:'open',reviewPoints:10,version:0});
for(const file of ['operations-server/review-identity.draft.sql','operations-server/reward-visits.sql','operations-server/reward-fixed-milestones.sql','operations-server/voucher-unlimited-and-reset.sql','operations-server/review-identity-self.sql','operations-server/voucher-short-code.sql','operations-server/review-distribution-self-redeem.sql','operations-server/nfc-tag-registry.sql','operations-server/booth-stamp-counts.sql','operations-server/claim-guard.sql','operations-server/booth-bulk-and-tag-register.sql','operations-server/notices.sql']) await sql(file);
const booth='매커니즘';
await sql('operations-server/operator-identity-and-scoped-reset.sql');
await write(admin,'booth_save',{booth,name:booth,floor:1,status:'open',version:1});
// A card written before the registry: it is listed after its first scan.
const legacyToken=(await db.query(`select festival_nfc_private.issue_tag('${booth}',null) t`)).rows[0].t;
await write(await account('11001'),'claim',{token:legacyToken});
const output=path.join(root,'artifacts/nfc-tag-manager'); fs.mkdirSync(output,{recursive:true});
const browser=await chromium.launch({headless:true,channel:process.env.CHROME_PATH?undefined:'msedge',executablePath:process.env.CHROME_PATH});
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.json':'application/json','.webp':'image/webp','.woff2':'font/woff2'};
async function pageFor(a,width) {
  const context=await browser.newContext({viewport:{width,height:850},isMobile:true,hasTouch:true});
  await context.addInitScript(a=>localStorage.setItem('pangyo-google-session-v1',JSON.stringify({access_token:a.jwt,refresh_token:'fixture',token_type:'bearer',expires_at:4102444800,expires_in:3600,user:{id:a.id}})),a);
  const page=await context.newPage(), errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('dialog',d=>d.accept());
  await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());
    if(url.origin===SITE) {
      const file=path.join(root,decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
      if(!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status:404,body:''});
      return route.fulfill({status:200,contentType:types[path.extname(file)] || 'application/octet-stream',body:fs.readFileSync(file)});
    }
    if(url.origin!==PROJECT_URL) return route.abort();
    try {
      let value; const p=req.method()==='POST'?req.postDataJSON():{};
      const call=(name,args)=>rpc(a,`select public.${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) value`,args);
      if(url.pathname==='/rest/v1/booths') value=(await db.query('select id,name,rating,position from public.booths')).rows;
      else if(url.pathname==='/rest/v1/rpc/festival_nfc_profile') value=await call('festival_nfc_profile',[]);
      else if(url.pathname==='/rest/v1/rpc/festival_reward_read') value=await call('festival_reward_read',[]);
      else if(url.pathname==='/rest/v1/rpc/festival_review_identity_self') value=await call('festival_review_identity_self',[p.p_action,p.p_payload]);
      else if(url.pathname==='/rest/v1/rpc/festival_review_identity_admin') value=await call('festival_review_identity_admin',[p.p_action,p.p_payload]);
      else if(url.pathname==='/rest/v1/rpc/festival_notices') value=await call('festival_notices',[]);
      else if(url.pathname==='/rest/v1/rpc/festival_notice_admin') value=await call('festival_notice_admin',[p.p_action,p.p_payload]);
      else if(url.pathname==='/rest/v1/rpc/festival_booth_status_bulk') value=await call('festival_booth_status_bulk',[p.p_payload,p.p_request_id]);
      else if(url.pathname==='/rest/v1/rpc/festival_claim_guard') value=await call('festival_claim_guard',[p.p_action,p.p_payload]);
      else if(url.pathname==='/rest/v1/rpc/festival_booth_stamp_counts') value=await call('festival_booth_stamp_counts',[]);
      else if(url.pathname==='/rest/v1/rpc/festival_nfc_tag_admin') value=await call('festival_nfc_tag_admin',[p.p_action,p.p_payload]);
      else if(url.pathname==='/rest/v1/rpc/festival_ops_read') value=await call('festival_ops_read',[p.p_kind,p.p_query]);
      else if(url.pathname==='/rest/v1/rpc/festival_ops_write') value=await call('festival_ops_write',[p.p_action,p.p_payload,p.p_request_id]);
      else if(url.pathname==='/auth/v1/logout') return route.fulfill({status:204});
      else return route.fulfill({status:404,json:{code:'PGRST202',message:'Missing optional function'}});
      return route.fulfill({json:value});
    } catch(e) { return route.fulfill({status:400,json:{code:e.code || 'TEST_ERROR',message:e.message}}); }
  });
  await page.goto(`${SITE}/index.html`);
  await page.waitForFunction(()=>festivalOpsUI.snapshot()?.ready);
  return {page,context,errors};
}
async function screenshot(page,width,name) {
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`overflow ${width} ${name}`);
  await page.screenshot({path:path.join(output,`${width}-${name}.png`),fullPage:true});
}
const reports=[];
try {
  for(const width of [320,390,430]) {
    const {page,context,errors}=await pageFor(admin,width);
    await page.evaluate(()=>navigateTo('admin'));
    // Dashboard: per-booth stamp completion, most completed first.
    const stampRow=page.locator(`[data-booth-stamps="${booth}"]`); await stampRow.waitFor();
    const stampCount=await db.query('select count(distinct user_id)::int n from festival_ops.visits where booth_key=$1',[booth]).then(r=>r.rows[0].n);
    assert.match(await stampRow.innerText(),new RegExp(`^${stampCount}\\s*명$[\\s\\S]*NFC ${stampCount} · 수동 0`,'m'));
    assert.equal(await page.locator('.ops-stamp-list li').first().getAttribute('data-booth-stamps'),booth);
    await screenshot(page,width,'dashboard-stamps');
    await page.locator('[data-ops-tab="tools"]').first().click();
    await page.locator('.festival-ops-tools [data-ops-tab="nfc"]').click();
    await page.locator('#serverAdminForm').waitFor();
    await page.locator('.nfc-issued-tag').first().waitFor();
    const before=await page.locator('.nfc-issued-tag').count();
    const legacy=page.locator('.nfc-issued-tag',{hasText:'이전 발급'});
    assert.equal(await legacy.count(),1,'a scanned pre-registry card is listed');
    assert.match(await legacy.innerText(),/인식 1회/);

    // Issue with a memo: the result shows the address and the list gains the new card on top.
    const memo=`정문 카드 ${width}`;
    await page.locator('#serverAdminBooth').selectOption(await page.evaluate(k=>state.db.booths.find(b=>boothKeyFor(b)===k).id,booth));
    await page.locator('#serverAdminLabel').fill(memo);
    await page.locator('#serverAdminIssue').click();
    const url=await page.locator('#serverAdminUrl').inputValue();
    assert.match(url,/^https:\/\/festival\.test\/(index\.html)?#t=nf1\./);
    assert.match(await page.locator('#serverAdminResult').innerText(),new RegExp(`\\(${memo}\\) 태그를 발급했습니다`));
    await page.waitForFunction(n=>document.querySelectorAll('.nfc-issued-tag').length===n,before+1);
    const card=page.locator('.nfc-issued-tag').first();
    assert.match(await card.innerText(),new RegExp(memo));
    assert.match(await card.innerText(),/사용 중/);
    assert.equal(await page.locator('#serverAdminLabel').inputValue(),'','memo clears after issuing');
    await screenshot(page,width,'issued');
    const token=new URLSearchParams(new URL(url).hash.slice(1)).get('t');
    const id=await card.getAttribute('data-tag-id');
    const tag=page.locator(`[data-tag-id="${id}"]`);

    // A student scan shows up after refreshing the list.
    assert.equal((await write(await account(`1${width}0`),'claim',{token})).result,'EARNED');
    await page.locator('[data-server-tags-refresh]').click();
    await tag.getByText('인식 1회').waitFor();

    // Stop: the card no longer earns stamps on the server.
    await tag.locator('[data-server-tag="revoke"]').click();
    // The button is also labelled "사용 중지"; wait for the status badge instead.
    await tag.locator('.nfc-tag-state',{hasText:'사용 중지'}).waitFor();
    assert.equal(await tag.locator('[data-server-tag="url"]').count(),0);
    await assert.rejects(write(await account(`2${width}0`),'claim',{token}),/NFC_TAG_EXPIRED/);
    await page.locator('#serverTagStatus').selectOption('revoked');
    assert.equal(await page.locator('.nfc-issued-tag').count(),1);
    await screenshot(page,width,'revoked-filter');
    await page.locator('#serverTagStatus').selectOption('all');

    // Restore, copy the same address again and rename the card.
    await page.locator(`[data-tag-id="${id}"] [data-server-tag="restore"]`).click();
    await page.locator(`[data-tag-id="${id}"] [data-server-tag="url"]`).waitFor();
    await page.locator('#serverAdminUrl').evaluate(input=>{ input.value=''; });
    await page.locator(`[data-tag-id="${id}"] [data-server-tag="url"]`).click();
    await page.locator('#serverAdminResult').getByText('태그 주소',{exact:false}).waitFor();
    assert.equal(await page.locator('#serverAdminUrl').inputValue(),url,'the same signed address is shown again');
    assert.match(await page.locator('#serverAdminResult').innerText(),/태그 주소/);
    await page.locator(`[data-tag-id="${id}"] [data-server-tag="edit"]`).click();
    await page.locator(`[data-tag-label-form="${id}"] input`).fill(`후문 카드 ${width}`);
    await page.locator(`[data-tag-label-form="${id}"] button[type="submit"]`).click();
    await page.locator(`[data-tag-id="${id}"]`).getByText(`후문 카드 ${width}`).waitFor();
    assert.equal(await page.locator('[data-tag-label-form]').count(),0);
    await screenshot(page,width,'renamed');

    assert.equal(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}).includes('nf1.')),false,'tokens are never stored');
    assert.deepEqual(errors,[]);
    await context.close();
    reports.push({width,passed:true,flows:['legacy card listed after first scan','issue with memo','result address','list refresh with scan count','stop blocks claims','status filter','restore','same address again','rename','no stored tokens']});
  }
  // Rate limit: the operator sets "N in M minutes"; a student over it sees why, and is listed.
  {
    const width=390;
    const {page,context,errors}=await pageFor(admin,width);
    await page.evaluate(()=>navigateTo('admin'));
    await page.locator('[data-ops-tab="tools"]').first().click();
    await page.locator('.festival-ops-tools [data-ops-tab="claim_guard"]').click();
    const form=page.locator('[data-ops-form="claim_guard_save"]'); await form.waitFor();
    assert.equal(await form.locator('[name=windowMinutes]').inputValue(),'10');
    assert.equal(await form.locator('[name=maxClaims]').inputValue(),'5');
    assert.equal(await form.locator('[name=enabled]').isChecked(),true);
    await form.locator('[name=windowMinutes]').fill('30');
    await form.locator('[name=maxClaims]').fill('2');
    assert.equal(await page.locator('[data-guard-summary]').innerText(),'30분 안에 새 부스 2개까지 적립할 수 있어요. 3번째부터 막아요.');
    await form.locator('button[type=submit]').click();
    await page.getByText('저장했어요.',{exact:true}).waitFor();
    assert.equal(await page.locator('[data-ops-form="claim_guard_save"] [name=maxClaims]').inputValue(),'2');
    await screenshot(page,width,'guard-settings');

    // A student who stamps two new booths quickly is refused on the third and told why.
    const keys=(await db.query("select key from festival_ops.booths where key<>$1 order by key collate \"C\" limit 3",[booth])).rows.map(r=>r.key);
    for(const key of keys) await write(admin,'booth_save',{booth:key,name:key,floor:1,status:'open',version:1});
    const fast=await account('11500');
    const tags=[];
    for(const key of keys) tags.push((await db.query('select festival_nfc_private.issue_tag($1::public.booth_enum,null) t',[key])).rows[0].t);
    for(const t of tags.slice(0,2)) assert.equal((await write(fast,'claim',{token:t})).result,'EARNED');
    const s=await pageFor(fast,width);
    await s.page.evaluate(t=>nfcAdapter.scan(createNfcClaim(t,'web-nfc')),tags[2]);
    await s.page.locator('#nfcFeedback').getByText('짧은 시간에 너무 많은 부스를 적립해',{exact:false}).waitFor();
    assert.equal((await db.query('select count(*)::int n from festival_ops.visits where user_id=$1',[fast.uid])).rows[0].n,2);
    await screenshot(s.page,width,'guard-student-blocked');
    assert.deepEqual(s.errors,[]);
    await s.context.close();

    await page.locator('[data-ops-refresh]').first().click();
    const row=page.locator('.ops-guard-list tr',{hasText:`#${fast.uid}`}); await row.waitFor();
    assert.match(await row.innerText(),/2개/);
    await screenshot(page,width,'guard-list');
    assert.deepEqual(errors,[]);
    await context.close();
    reports.push({width,passed:true,flows:['guard defaults','live rule summary','save rule','student refused with reason','listed participant']});
  }
  // Settings shows the rate limit; an old card is registered by address; booths change status in bulk.
  {
    const width=390;
    const {page,context,errors}=await pageFor(admin,width);
    await page.evaluate(()=>navigateTo('admin'));
    await page.locator('[data-ops-tab="tools"]').first().click();
    await page.locator('.festival-ops-tools [data-ops-tab="settings"]').click();
    const guardForm=page.locator('[data-ops-form="claim_guard_save"]'); await guardForm.waitFor();
    assert.equal(await page.getByRole('heading',{name:'부정 적립 제한'}).count(),1);
    assert.equal(await guardForm.locator('[name=maxClaims]').inputValue(),'2','settings shows the saved rule');
    await screenshot(page,width,'settings-guard');

    // A card written before the registry: paste its address (custom scheme) to list it.
    const oldCard=(await db.query("select festival_nfc_private.issue_tag($1::public.booth_enum,null) t",[booth])).rows[0].t;
    await page.locator('[data-ops-tab="tools"]').first().click();
    await page.locator('.festival-ops-tools [data-ops-tab="nfc"]').click();
    const register=page.locator('[data-server-tag-register]'); await register.waitFor();
    await register.locator('[name=address]').fill('not a card');
    await register.locator('button[type=submit]').click();
    await page.locator('#serverTagRegisterStatus.error').getByText('카드 주소를 확인해 주세요',{exact:false}).waitFor();
    const before=await page.locator('.nfc-issued-tag').count();
    await register.locator('[name=address]').fill(`pangyofestival://nfc#t=${oldCard}`);
    await register.locator('[name=label]').fill('옛 카드');
    await register.locator('button[type=submit]').click();
    await page.locator('#serverTagRegisterStatus.success').getByText('목록에 추가했어요',{exact:false}).waitFor();
    await page.waitForFunction(n=>document.querySelectorAll('.nfc-issued-tag').length===n,before+1);
    assert.match(await page.locator('.nfc-issued-tag',{hasText:'옛 카드'}).innerText(),/이전 발급/);
    assert.equal(await register.locator('[name=address]').inputValue(),'','the form clears after registering');
    assert.equal((await db.query('select count(*)::int n from festival_ops.visits where user_id=$1',[admin.uid])).rows[0].n,0,'registering earns no stamp');
    await screenshot(page,width,'tag-register');

    // Bulk status: pick every booth and pause them in one step.
    await page.locator('[data-ops-tab="tools"]').first().click();
    await page.locator('.festival-ops-tools [data-ops-tab="catalog"]').click();
    const bulk=page.locator('[data-ops-form="booth_status_bulk"]'); await bulk.waitFor();
    await bulk.locator('button[type=submit]').click();
    await bulk.locator('.ops-form-status').getByText('상태를 바꿀 부스를 선택해 주세요.').waitFor();
    await bulk.locator('[data-bulk-pick="status-open"]').click();
    const open=(await db.query("select count(*)::int n from festival_ops.booths where status='open'")).rows[0].n;
    assert.equal(await bulk.locator('[data-bulk-count]').innerText(),`${open}개 선택`);
    await bulk.locator('[data-bulk-pick="all"]').click();
    const total=(await db.query('select count(*)::int n from festival_ops.booths')).rows[0].n;
    assert.equal(await bulk.locator('[data-bulk-count]').innerText(),`${total}개 선택`);
    await screenshot(page,width,'bulk-status');
    await bulk.locator('[name=status]').selectOption('paused');
    await bulk.locator('button[type=submit]').click();
    await page.getByText(`부스 ${total}개를 '일시 중지'(으)로 맞췄어요.`,{exact:false}).waitFor();
    assert.equal((await db.query("select count(*)::int n from festival_ops.booths where status<>'paused'")).rows[0].n,0);
    assert.deepEqual(errors,[]);
    await context.close();
    reports.push({width,passed:true,flows:['settings shows rate limit','invalid card address','register old card by address','no stamp on register','bulk empty selection','quick picks','bulk pause']});
  }
  // Notices: an operator posts, edits and deletes; participants see them on the home screen.
  {
    const width=390;
    const {page,context,errors}=await pageFor(admin,width);
    await page.evaluate(()=>navigateTo('admin'));
    await page.locator('[data-ops-tab="tools"]').first().click();
    await page.locator('.festival-ops-tools [data-ops-tab="notice_admin"]').click();
    const form=page.locator('[data-ops-form="notice_save"]'); await form.waitFor();
    assert.equal(await page.getByText('아직 등록된 공지가 없어요.').count(),1);
    await form.locator('[name=title]').fill('우천 시 실내 진행');
    await form.locator('[name=body]').fill('비가 오면 모든 부스가 본관으로 옮겨요.\n위치는 지도에서 확인해 주세요.');
    await form.locator('[name=important]').check();
    await form.locator('button[type=submit]').click();
    await page.getByText('공지를 등록했어요. 학생 홈에 바로 보여요.').waitFor();
    await page.locator('.ops-notice-list li',{hasText:'우천 시 실내 진행'}).waitFor();
    await screenshot(page,width,'notice-admin');

    const reader=await account('11600');
    const s=await pageFor(reader,width);
    await s.page.evaluate(()=>navigateTo('home'));
    const news=s.page.locator('#homeNews .web-news-list li').first(); await news.waitFor();
    assert.match(await news.innerText(),/중요\s*우천 시 실내 진행[\s\S]*본관으로 옮겨요/);
    assert.match(await s.page.locator('.festival-notice-strip').innerText(),/우천 시 실내 진행/);
    await screenshot(s.page,width,'notice-home');

    // Edit: hide it, and it disappears from the participant's home on the next load.
    await page.locator('[data-notice-edit]').first().click();
    const edit=page.locator('[data-ops-form="notice_save"]');
    assert.equal(await edit.locator('[name=title]').inputValue(),'우천 시 실내 진행');
    await edit.locator('[name=title]').fill('우천 시 본관 진행');
    await edit.locator('[name=published]').uncheck();
    await edit.locator('button[type=submit]').click();
    await page.getByText('공지를 수정했어요.').waitFor();
    assert.match(await page.locator('.ops-notice-list li').first().innerText(),/우천 시 본관 진행[\s\S]*숨김/);
    await s.page.evaluate(async()=>{await festivalOpsUI.refresh(false);render();});
    assert.equal(await s.page.locator('#homeNews .web-news-list').count(),0);
    assert.match(await s.page.locator('#homeNews').innerText(),/등록된 공지가 없어요/);

    // Delete after confirming.
    await page.locator('[data-notice-edit]').first().click();
    await page.locator('[data-notice-delete]').click();
    await page.getByText('공지를 삭제했어요.').waitFor();
    assert.equal(await page.getByText('아직 등록된 공지가 없어요.').count(),1);
    assert.deepEqual(errors,[]); assert.deepEqual(s.errors,[]);
    await s.context.close(); await context.close();
    reports.push({width,passed:true,flows:['post important notice','participant home list and strip','edit and hide','hidden not shown','delete']});
  }
} finally { await browser.close(); await db.close(); }
fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({ranAt:new Date().toISOString(),reports},null,2));
console.log(JSON.stringify(reports));
