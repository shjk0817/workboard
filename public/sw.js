/* ============================================================
   WorkBoard Service Worker — 离线缓存 + 后台更新
   ============================================================ */
const CACHE = 'workboard-v1';
const SHELL = [
  '/',
  '/manage',
  '/css/main.css',
  '/js/app.js',
  '/logo.png',
  '/apple-touch-icon.png',
  '/favicon.ico',
  '/manifest.json'
];

/* ---------- install: 预缓存核心壳 ---------- */
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {}))
  );
  self.skipWaiting();
});

/* ---------- activate: 清理旧缓存 ---------- */
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

/* ---------- fetch: 缓存优先，网络更新 ---------- */
self.addEventListener('fetch', (e) => {
  // 跳过 API 请求和非 GET 请求
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('/api/')) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      const fetched = fetch(e.request).then(response => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return response;
      }).catch(() => cached);
      return cached || fetched;
    })
  );
});