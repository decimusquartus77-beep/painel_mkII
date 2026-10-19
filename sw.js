// Service worker: guarda o app no aparelho para abrir sem internet.
// Ao publicar uma nova versão, aumente o número em CACHE.
const CACHE = 'gaiola-mkii-v03';
const TILES = 'gaiola-tiles-v1';
const TILE_HOSTS = ['server.arcgisonline.com', 'tile.openstreetmap.org', 'tile.opentopomap.org'];
const TILE_MAX = 2500;
const ASSETS = [
  './', './index.html', './app.css', './app.js', './manifest.json',
  './img/logo.png', './img/icon-192.png', './img/icon-512.png', './img/apple-touch-icon.png',
  './fonts/barlow-condensed-latin-500-normal.woff2', './fonts/barlow-condensed-latin-600-normal.woff2',
  './fonts/barlow-condensed-latin-700-normal.woff2', './fonts/barlow-condensed-latin-800-normal.woff2',
  './fonts/barlow-condensed-latin-800-italic.woff2'
];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== TILES).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
async function tileFetch(req) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === 'opaque')) {
      cache.put(req, res.clone());
      cache.keys().then(ks => { if (ks.length > TILE_MAX) ks.slice(0, ks.length - TILE_MAX + 200).forEach(k => cache.delete(k)); });
    }
    return res;
  } catch (err) { return Response.error(); }
}
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method === 'GET' && TILE_HOSTS.includes(new URL(req.url).hostname)) { e.respondWith(tileFetch(req)); return; }
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => {
    const net = fetch(req).then(res => {
      if (res && res.ok) { const cp = res.clone(); caches.open(CACHE).then(c => c.put(req, cp)); }
      return res;
    }).catch(() => hit);
    return hit || net;
  }));
});
