// Real browser and operations SQL; all remote requests terminate in local PGlite.
// Covers the secure-card (NTAG 424 DNA) screen and a student stamp through a card link.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto, {randomUUID} from 'node:crypto';
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
async function account(admin,studentNumber) {
  const a={id:randomUUID(),session:randomUUID()};
  await db.query(`insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data) values($1,$2,now(),'{"provider":"google"}',$3)`,[a.id,`${a.id}@example.invalid`,{full_name:'격리 학생',festival_name:'격리 학생',festival_student_number:studentNumber}]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[a.session,a.id]);
  a.uid=(await rpc(a,'select public.festival_nfc_profile() value')).id;
  if(admin) await db.query('update public.users set admin=true where id=$1',[a.uid]);
  const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
  a.jwt=`${enc({alg:'HS256',typ:'JWT'})}.${enc({sub:a.id,session_id:a.session,exp:4102444800,role:'authenticated'})}.fixture`;
  return a;
}
const admin=await account(true,'29999');
const write=(a,k,p)=>rpc(a,'select public.festival_ops_write($1,$2,$3) value',[k,p,randomUUID()]);
await write(admin,'event_save',{name:'보안 카드 격리 검증',state:'open',reviewPoints:10,version:0});
for(const file of ['review-identity.draft','reward-visits','reward-fixed-milestones','voucher-unlimited-and-reset','review-identity-self','voucher-short-code','review-distribution-self-redeem','nfc-tag-registry','claim-guard','booth-bulk-and-tag-register','notices','operator-identity-and-scoped-reset','self-identity-and-own-club-stamps','student-number-display','student-number-only','operator-self-actions','sun-nfc'])
  await db.exec(fs.readFileSync(path.join(root,`operations-server/${file}.sql`),'utf8'));
for(const {key} of (await db.query('select key from festival_ops.booths')).rows) await write(admin,'booth_save',{booth:key,name:key,status:'open',floor:1,version:1});

// Node model of an NTAG 424 DNA read (AES-128 PICC data + AES-CMAC, NXP AN12196).
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
function cardHash(uid,counter,keys) {
  const ctr=Buffer.from([counter&255,(counter>>8)&255,(counter>>16)&255]);
  const c=crypto.createCipheriv('aes-128-cbc',Buffer.from(keys.metaKey,'hex'),Buffer.alloc(16));c.setAutoPadding(false);
  const picc=Buffer.concat([c.update(Buffer.concat([Buffer.from([0xC7]),Buffer.from(uid,'hex'),ctr,crypto.randomBytes(5)])),c.final()]).toString('hex').toUpperCase();
  const full=cmac(cmac(Buffer.from(keys.fileKey,'hex'),Buffer.concat([Buffer.from('3cc300010080','hex'),Buffer.from(uid,'hex'),ctr])),Buffer.alloc(0));
  return `#picc_data=${picc}&cmac=${Buffer.from([1,3,5,7,9,11,13,15].map(i=>full[i])).toString('hex').toUpperCase()}`;
}

const output=path.join(root,'artifacts/sun-nfc'); fs.mkdirSync(output,{recursive:true});
const browser=await chromium.launch({headless:true,channel:process.env.CHROME_PATH?undefined:'msedge',executablePath:process.env.CHROME_PATH});
const pages=[];
async function pageFor(a,width,hash='') {
  const context=await browser.newContext({viewport:{width,height:850},isMobile:true,hasTouch:true});
  await context.addInitScript(a=>localStorage.setItem('pangyo-google-session-v1',JSON.stringify({access_token:a.jwt,refresh_token:'fixture',token_type:'bearer',expires_at:4102444800,expires_in:3600,user:{id:a.id}})),a);
  await context.grantPermissions(['clipboard-read','clipboard-write']).catch(()=>{});
  const page=await context.newPage(), errors=[], calls=[];
  page.on('pageerror',e=>errors.push(e.message)); page.on('dialog',d=>d.accept());
  await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());
    if(url.protocol==='file:') return route.continue();
    if(url.origin!==PROJECT_URL) return route.abort();
    try {
      let value; const p=req.method()==='POST'?req.postDataJSON():{};
      if(url.pathname==='/rest/v1/booths') value=(await db.query('select id,name,rating,position from public.booths')).rows;
      else if(url.pathname==='/rest/v1/rpc/festival_nfc_profile') value=await rpc(a,'select public.festival_nfc_profile() value');
      else if(url.pathname==='/rest/v1/rpc/festival_ops_read') value=await rpc(a,'select public.festival_ops_read($1,$2) value',[p.p_kind,p.p_query]);
      else if(url.pathname==='/rest/v1/rpc/festival_ops_write') { calls.push(p); value=await rpc(a,'select public.festival_ops_write($1,$2,$3) value',[p.p_action,p.p_payload,p.p_request_id]); }
      else if(url.pathname==='/rest/v1/rpc/festival_sun_admin') { calls.push(p); value=await rpc(a,'select public.festival_sun_admin($1,$2) value',[p.p_action,p.p_payload]); }
      else if(url.pathname==='/rest/v1/rpc/festival_sun_claim') { calls.push(p); value=await rpc(a,'select public.festival_sun_claim($1,$2) value',[p.p_payload,p.p_request_id]); }
      else if(url.pathname==='/rest/v1/rpc/festival_nfc_tag_admin') value=await rpc(a,'select public.festival_nfc_tag_admin($1,$2) value',[p.p_action,p.p_payload]);
      else if(url.pathname==='/auth/v1/logout') return route.fulfill({status:204});
      else return route.fulfill({status:404,json:{code:'PGRST202',message:'Missing optional function'}});
      return route.fulfill({json:value});
    } catch(e) { return route.fulfill({status:400,json:{code:e.code || 'TEST_ERROR',message:e.message}}); }
  });
  await page.goto(pathToFileURL(path.join(root,'index.html')).href+hash);
  await page.waitForFunction(()=>festivalOpsUI.snapshot()?.ready);
  pages.push({page,errors});
  return {page,context,errors,calls};
}
const routeTo=(page,route)=>page.evaluate(r=>{state.route=r;render();},route);
async function check(page,width,name) {
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`overflow ${width} ${name}`);
  await page.screenshot({path:path.join(output,`${width}-${name}.png`),fullPage:true});
}
const visits=async a=>(await db.query("select booth_key,method from festival_ops.visits where user_id=$1",[a.uid])).rows;
const UID='04A1B2C3D4E5F6';
try {
  const width=390, a=await pageFor(admin,width);
  await routeTo(a.page,'admin');
  await openOperatorTool(a.page,'sun');
  await a.page.getByRole('heading',{name:'보안 NFC 카드',exact:true}).waitFor();
  await a.page.locator('[data-sun-keys-create]').click();
  await a.page.getByText('키를 만들었어요.',{exact:false}).waitFor();
  assert.match(await a.page.locator('.sun-status').innerText(),/사용 중/);
  await a.page.locator('[data-sun-keys-reveal]').click();
  await a.page.locator('.sun-key code').nth(1).waitFor();
  const shown=await a.page.locator('.sun-key code').allInnerTexts();
  assert.equal(shown.length,2);
  const keys={metaKey:shown[0].toLowerCase(),fileKey:shown[1].toLowerCase()};
  const stored=await rpc(admin,"select public.festival_sun_admin('keys_reveal','{}') value");
  assert.equal(keys.metaKey,stored.metaKey); assert.equal(keys.fileKey,stored.fileKey);
  await check(a.page,width,'keys');

  // Register a card from its pasted link; a forged link explains which key is wrong.
  const paste=async hash=>{ await a.page.locator('[data-sun-paste] [name=address]').fill(`https://festival.example/${hash}`); await a.page.locator('[data-sun-paste] button[type=submit]').click(); };
  await paste(cardHash(UID,3,{...keys,fileKey:'f'.repeat(32)}));
  await a.page.getByText('SDM File Read 키(Key 2)',{exact:false}).waitFor();
  await paste(cardHash(UID,3,keys));
  await a.page.getByText('정상 카드 · 아직 등록 전',{exact:false}).waitFor();
  await check(a.page,width,'inspect');
  const booth=await a.page.locator('[data-sun-register] [name=booth]').inputValue();
  await a.page.locator('[data-sun-register] [name=label]').fill('정문 카드');
  await a.page.locator('[data-sun-register] button[type=submit]').click();
  await a.page.getByText('카드를 등록했어요.',{exact:false}).waitFor();
  await a.page.getByText('등록된 카드 1장',{exact:false}).waitFor();
  assert.equal((await db.query('select booth::text b,label,last_counter from festival_nfc_private.sun_cards')).rows[0].label,'정문 카드');
  await check(a.page,width,'registered');

  // The signed-tag screen is separate and unchanged.
  await openOperatorTool(a.page,'nfc');
  await a.page.locator('.nfc-manager-heading').waitFor();
  await openOperatorTool(a.page,'sun');
  await a.page.getByText('등록된 카드 1장',{exact:false}).waitFor();

  // A student opens the card link: one stamp, then the same link is refused.
  const student=await account(false,'21001'), link=cardHash(UID,4,keys);
  const s=await pageFor(student,width,link);
  await s.page.getByText('스탬프 1개 적립 완료',{exact:true}).waitFor();
  assert.equal(await s.page.evaluate(()=>location.hash),'');
  assert.deepEqual(await visits(student),[{booth_key:booth,method:'nfc'}]);
  await check(s.page,width,'student-earned');
  const other=await account(false,'21002'), replay=await pageFor(other,width,link);
  await replay.page.getByText('이미 사용한 카드 주소예요',{exact:true}).waitFor();
  assert.deepEqual(await visits(other),[]);

  // An operator who taps a new card can register it from 관리 마법사 afterwards.
  const fresh=await pageFor(admin,320,cardHash('04BBBBBBBBBBBB',1,keys));
  await fresh.page.getByText('등록되지 않은 보안 카드예요',{exact:true}).waitFor();
  await routeTo(fresh.page,'admin');
  await openOperatorTool(fresh.page,'sun');
  await fresh.page.locator('[data-sun-last]').click();
  await fresh.page.getByText('정상 카드 · 아직 등록 전',{exact:false}).waitFor();
  await check(fresh.page,320,'last-read');

  // Stop and restore a card from the list.
  await a.page.locator('.sun-card-list summary').first().click();
  await a.page.locator('[data-sun-toggle]').first().click();
  await a.page.getByText('카드를 사용 중지했어요.',{exact:true}).waitFor();
  assert.notEqual((await db.query('select revoked_at from festival_nfc_private.sun_cards where uid=$1',[UID])).rows[0].revoked_at,null);
  const audit=(await db.query("select action from festival_ops.audit where action like 'sun_%'")).rows.map(r=>r.action);
  for(const action of ['sun_keys_create','sun_keys_reveal','sun_card_register','sun_card_revoke']) assert.ok(audit.includes(action),action);
  for(const {errors} of pages) assert.deepEqual(errors,[]);
  console.log('PASS secure-card screen, registration, student stamp, replay refusal, last-read registration, stop');
} finally { await browser.close(); }
