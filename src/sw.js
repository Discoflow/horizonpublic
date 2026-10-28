const CACHE_NAME = 'horizon-v2';
const SHELL = [
  '', 'index.html', 'src/app.js', 'src/cloud.js', 'src/supabase-config.js',
  'src/indicators.js', 'src/planner.js', 'src/alerts.js', 'src/styles.css',
  'src/auth.css', 'manifest.webmanifest', 'icon.svg',
].map((path) => new URL(path, self.registration.scope).href);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || !url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    const copy = response.clone();
    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(new URL('index.html', self.registration.scope).href))));
});
self.addEventListener('push', (event) => {
  const payload = event.data?.json() || { title: 'Horizon', body: 'Une nouvelle alerte est disponible.' };
  event.waitUntil(self.registration.showNotification(payload.title, { body: payload.body, icon: new URL('icon.svg', self.registration.scope).href, data: { url: payload.url || self.registration.scope } }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url));
});
