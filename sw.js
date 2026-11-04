// 판교고 축제 service worker (1.59): shows 웨이팅 push notifications and opens the waiting page when one is
// tapped. It caches nothing, so every page and file still comes from the network as before.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

const safeUrl = value => typeof value === 'string' && /^\/waiting\/[0-9a-f-]{36}$/.test(value) ? value : '/';

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : '' }; }
  const url = safeUrl(data.url);
  event.waitUntil((async () => {
    // An open page reads its numbers again right away.
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    windows.forEach(client => client.postMessage({ type: 'festival-waiting-push', url, kind: data.kind || '' }));
    await self.registration.showNotification(String(data.title || '판교고 축제').slice(0, 120), {
      body: String(data.body || '').slice(0, 300),
      tag: String(data.tag || 'festival-waiting').slice(0, 64),
      renotify: true,
      data: { url },
      icon: '/assets/app-icon-192.png',
      badge: '/assets/app-badge-96.png',
      vibrate: data.kind === 'called' ? [300, 120, 300, 120, 300] : [200, 100, 200],
      requireInteraction: data.kind === 'called',
    });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL(safeUrl(event.notification.data?.url), self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      await client.focus();
      client.postMessage({ type: 'festival-waiting-open', url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
