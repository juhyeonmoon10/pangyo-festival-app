// A page left open offers a reload once another release is deployed. Served from a synthetic origin;
// every Supabase request is refused, so nothing reaches the shared project.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require('playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const SITE='https://festival.test';
const release=fs.readFileSync(path.join(root,'app.js'),'utf8').match(/const APP_RELEASE = "([^"]+)";/)[1];
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.webp':'image/webp','.png':'image/png','.svg':'image/svg+xml','.json':'application/json'};
const output=path.join(root,'artifacts/update-banner'); fs.mkdirSync(output,{recursive:true});
const browser=await chromium.launch({headless:true,channel:process.env.CHROME_PATH?undefined:'msedge',executablePath:process.env.CHROME_PATH});
const reports=[];
try {
  for(const width of [320,390]) {
    const context=await browser.newContext({viewport:{width,height:800},isMobile:true,hasTouch:true});
    const page=await context.newPage(), errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    let deployed=release;
    await page.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(url.origin!==SITE) return route.abort();
      if(url.pathname==='/deployment-info.json') return route.fulfill({json:{version:deployed,commit:null}});
      // Page paths (/map, /admin ...) are served as index.html, like the deployment's rewrite.
      const file=path.join(root,decodeURIComponent(path.extname(url.pathname)?url.pathname:'/index.html'));
      if(!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status:404,body:''});
      return route.fulfill({status:200,contentType:types[path.extname(file)] || 'application/octet-stream',body:fs.readFileSync(file)});
    });
    await page.goto(`${SITE}/`);
    await page.waitForFunction(()=>typeof render==='function');
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.app-update-banner').count(),0,'Same release shows nothing');
    deployed='9.99';
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    const banner=page.locator('.app-update-banner'); await banner.waitFor();
    assert.match(await banner.innerText(),/새 버전\(9\.99\)이 배포됐어요/);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No horizontal overflow');
    await page.screenshot({path:path.join(output,`${width}-banner.png`)});
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    assert.equal(await page.locator('.app-update-banner').count(),1,'Shown once');
    await page.evaluate(()=>{window.__beforeReload=true;});
    await Promise.all([page.waitForEvent('load'),banner.getByRole('button',{name:'새로고침'}).click()]);
    await page.waitForFunction(()=>typeof render==='function');
    assert.equal(await page.evaluate(()=>window.__beforeReload),undefined,'The button reloads the page');
    assert.deepEqual(errors,[]);
    reports.push({width,passed:true});
    await context.close();
  }
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(reports,null,2));
  console.log(JSON.stringify(reports));
} finally { await browser.close(); }
