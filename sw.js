/* Offline shell: the app opens with no signal (storage units often have none). Lookups still need a connection. */
const CACHE = "storage-inventory-1.0.0";
const SHELL = [
  "./", "index.html", "styles.css", "manifest.webmanifest",
  "js/store.js", "js/lookup.js", "js/scanner.js", "js/app.js", "js/decode-worker.js",
  "vendor/zxing-wasm-3.1.4/reader.iife.js", "vendor/zxing-wasm-3.1.4/zxing_reader.wasm", "vendor/jszip-3.10.1.min.js",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // never touch API calls
  // network first so updates show up; cache when offline
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match("index.html")))
  );
});
