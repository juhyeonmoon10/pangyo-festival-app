const {test}=require('node:test');
const assert=require('node:assert/strict');
const router=require('../festival-router.js');
const {createAccount}=require('../festival-account.js');
const config=require('../supabase-catalog.js');

test('every main screen has a canonical URL and supports trailing slashes',()=>{
  for(const [route,path] of Object.entries(router.paths)) {
    assert.equal(router.parse(path).route,route);
    assert.equal(router.pathname({route}),path);
    if(path!=='/') assert.equal(router.parse(path+'/').route,route);
  }
  assert.equal(router.parse('/stamps').route,'stamps');
});

test('booth and review URLs round-trip Unicode identifiers without route injection',()=>{
  for(const route of ['detail','boothReviews']) {
    const target={route,selectedBoothId:'club-인벨릭스'};
    assert.deepEqual(router.parse(router.pathname(target)),target);
  }
  for(const path of ['/booth/%ZZ','/booth/%2Fadmin','/booth/%5Cadmin','/booth/%00','/booth/..','/booth/a/extra']) assert.equal(router.parse(path),null);
});

test('login destinations accept only known internal pages',()=>{
  for(const path of ['https://evil.invalid','//evil.invalid','/\\evil.invalid','/login','/map?next=bad','/admin#bad','/api/reset']) assert.equal(router.safeReturn(path),null);
  assert.deepEqual(router.safeReturn('/admin'),{route:'admin'});
});

test('URL changes preserve mode and pending OAuth code, but remove the return parameter after login',()=>{
  const current='https://festival.test/map?demo=1&v=1.18&code=fixture';
  const login=new URL(router.href({route:'login'},current,{route:'stamps'}));
  assert.equal(login.pathname,'/login');assert.equal(login.searchParams.get('next'),'/stamp');
  assert.equal(login.searchParams.get('code'),'fixture');assert.equal(login.searchParams.get('demo'),'1');
  const map=new URL(router.href({route:'map'},login.href));
  assert.equal(map.pathname,'/map');assert.equal(map.searchParams.has('next'),false);
});

test('file previews and the existing native shell retain their asset URL',()=>{
  for(const current of ['file:///C:/fixture/index.html?demo=1','https://appassets.androidplatform.net/assets/site/index.html']) {
    assert.equal(router.href({route:'stamps'},current),current);
  }
});

test('OAuth return targets are one-use, expire, and cannot redirect outside the app',()=>{
  const values=new Map(),storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
  router.remember(storage,{route:'stamps'});
  assert.deepEqual(router.takeRemembered(storage),{route:'stamps'});
  assert.equal(router.takeRemembered(storage),null);
  for(const saved of [{path:'/admin',at:Date.now()-900001},{path:'//evil.invalid',at:Date.now()}]) {
    storage.setItem('pangyo-login-destination-v1',JSON.stringify(saved));
    assert.equal(router.takeRemembered(storage),null);
  }
});

test('Google login uses the existing root callback from every web page',async()=>{
  for(const pathname of ['/login','/map','/stamp','/admin','/booth/example']) {
    let options;
    const sdk={createClient:()=>({auth:{onAuthStateChange(){},signInWithOAuth:async value=>{
      options=value.options;return {data:{url:config.PROJECT_URL+'/auth/v1/authorize'}};
    }}})};
    const account=createAccount({sdk,config,location:new URL('https://festival.test'+pathname),openUrl(){}});
    await account.signIn();assert.equal(options.redirectTo,'https://festival.test/');
  }
});
