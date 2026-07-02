/* Service Worker: アプリシェルをキャッシュしオフライン動作させる */
const CACHE = 'practice-counter-v9';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './css/app.css?v=9',
  './js/db.js?v=9',
  './js/engine.js?v=9',
  './js/app.js?v=9',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
