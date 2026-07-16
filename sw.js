/* 予測シェルの Service Worker: シェル+予測をオフライン化 / data.json はネット優先 */
const CACHE = 'slot-mobile-20260717-0601-7ed55ee0a8';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './predict/index.html',
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
  const url = new URL(e.request.url);
  // data.json はネット優先(取れたらキャッシュ更新、ダメなら最後の成功分)
  if (url.pathname.indexOf('data.json') !== -1) {
    e.respondWith(
      fetch(e.request, {cache: 'no-store'}).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }
  // それ以外はキャッシュ優先
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
