/* Service Worker: アプリシェルをキャッシュしオフライン動作させる */
const CACHE = 'practice-counter-v14';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './css/app.css?v=13',
  './js/db.js?v=14',
  './js/engine.js?v=14',
  './js/cloud.js?v=14',
  './js/app.js?v=14',
];

self.addEventListener('install', (e) => {
  // skipWaiting しない: 更新は index.html の更新バナー(タップ)経由でのみ適用する
  // (実践中にサイレント切替されるとUIが不意にリロードされるため)
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// index.html からのメッセージで即座に新バージョンへ切り替える(更新バナーの「更新」タップ用)
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // 自オリジン以外（Supabase等のクラウドAPI）はSWで触らない＝キャッシュせず常に直接ネットワークへ
  if (new URL(e.request.url).origin !== self.location.origin) return;
  // network-first: 常に最新を取りに行き、成功したらキャッシュ更新。
  // オフライン時のみキャッシュへフォールバック（＝更新が確実に届き、圏外でも動く）。
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request).then(hit => hit || caches.match('./index.html')))
  );
});
