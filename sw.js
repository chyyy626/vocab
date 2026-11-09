// 快取網頁本身，讓 App 開啟更快、沒網路時也能打開（查單字仍需要網路）。
// 修改網頁檔案後，把 VERSION 加 1，手機才會拿到新版。
const VERSION = 'v1';
const CACHE = `vocab-${VERSION}`;
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'lib/ai.js',
  'lib/gemini.js',
  'lib/claude.js',
  'lib/prompt.js',
  'lib/image.js',
  'lib/store.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 只處理自己網站的檔案；Claude、Supabase 的請求直接走網路。
// 策略：先用網路拿最新版，失敗（離線）才用快取。
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
