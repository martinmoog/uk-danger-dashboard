// Offline support: the app shell is cached; live data is fetched fresh and falls back to the last copy.
const SHELL = 'shell-v1';
const DATA = 'data-v1';
const SHELL_FILES = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icon.svg', 'data/outcodes.json', 'data/basemap.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const live = /\/data\/(events|feeds|forecast)\.json$/.test(url.pathname);
  if (live) {
    // Network first so warnings are current; the cached copy is only for when offline.
    const key = url.origin + url.pathname;
    e.respondWith(fetch(e.request).then((r) => {
      const copy = r.clone();
      caches.open(DATA).then((c) => c.put(key, copy));
      return r;
    }).catch(() => caches.match(key)));
    return;
  }
  // App shell: serve cached, update in the background.
  e.respondWith(caches.match(e.request).then((hit) => {
    const net = fetch(e.request).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); } return r; }).catch(() => hit);
    return hit || net;
  }));
});
