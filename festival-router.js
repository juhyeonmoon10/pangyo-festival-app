(function (root, factory) {
  const router = factory();
  if (typeof module === 'object' && module.exports) module.exports = router;
  else root.FestivalRouter = router;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const paths = Object.freeze({home:'/',login:'/login',map:'/map',stamps:'/stamp',
    vouchers:'/voucher',profile:'/my',reviews:'/reviews',identity:'/identity',scan:'/nfc',admin:'/admin',
    notices:'/notices',manage:'/manage'});
  const aliases = Object.freeze({'/index.html':'home','/home':'home','/stamps':'stamps',
    '/vouchers':'vouchers','/profile':'profile','/scan':'scan'});
  const returnKey = 'pangyo-login-destination-v1';
  const pagePattern = '/(?:|index\\.html|home/?|login/?|map/?|stamp/?|stamps/?|voucher/?|vouchers/?|my/?|profile/?|reviews/?|identity/?|nfc/?|scan/?|admin/?|notices(?:/[^/]+)?/?|manage/?|booth/[^/]+(?:/reviews)?/?)';
  const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 180
    && !/[\/\\?#\u0000-\u001f]/.test(id) && !['.','..'].includes(id);

  function parse(pathname) {
    if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.startsWith('//')) return null;
    const path = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
    const route = Object.keys(paths).find(key => paths[key] === path) || aliases[path];
    if (route) return {route};
    const notice = path.match(/^\/notices\/([^/]+)$/);
    if (notice) {
      try { const id = decodeURIComponent(notice[1]); return validId(id) ? {route:'notice',noticeId:id} : null; } catch { return null; }
    }
    const match = path.match(/^\/booth\/([^/]+)(\/reviews)?$/);
    if (!match) return null;
    try {
      const id = decodeURIComponent(match[1]);
      return validId(id) ? {route:match[2] ? 'boothReviews' : 'detail',selectedBoothId:id} : null;
    } catch { return null; }
  }

  function pathname(snapshot) {
    if (['detail','boothReviews'].includes(snapshot?.route) && validId(snapshot.selectedBoothId)) {
      return `/booth/${encodeURIComponent(snapshot.selectedBoothId)}${snapshot.route === 'boothReviews' ? '/reviews' : ''}`;
    }
    if (snapshot?.route === 'notice' && validId(snapshot.noticeId)) return `/notices/${encodeURIComponent(snapshot.noticeId)}`;
    return paths[snapshot?.route] || '/map';
  }

  function isWeb(location) {
    return ['http:','https:'].includes(location.protocol)
      && location.origin !== 'https://appassets.androidplatform.net';
  }

  function safeReturn(value) {
    if (typeof value !== 'string' || /[?#\\]/.test(value)) return null;
    const target = parse(value);
    return target && target.route !== 'login' ? target : null;
  }

  function href(snapshot, current, pending) {
    const url = new URL(current);
    if (!isWeb(url)) return url.href;
    url.pathname = pathname(snapshot);
    url.searchParams.delete('next');
    if (snapshot.route === 'login' && pending && !['home','login'].includes(pending.route)) {
      url.searchParams.set('next', pathname(pending));
    }
    return url.href;
  }

  function remember(storage, target) {
    try { storage.setItem(returnKey, JSON.stringify({path:pathname(target),at:Date.now()})); } catch { /* Storage can be disabled. */ }
  }

  function takeRemembered(storage) {
    try {
      const saved = JSON.parse(storage.getItem(returnKey) || 'null');
      storage.removeItem(returnKey);
      const age = Date.now() - saved?.at;
      return Number.isFinite(age) && age >= 0 && age < 900000 ? safeReturn(saved.path) : null;
    } catch { return null; }
  }

  return {paths,parse,pathname,isWeb,safeReturn,href,remember,takeRemembered,pagePattern};
});
