/* Service worker de Campo: shell offline + caché de estáticos.
 * - Navegaciones: red primero; si falla → shell cacheado ('/') → /offline.html.
 * - /_next/static (con hash): cache-first.
 * - Resto de GET del mismo origen: stale-while-revalidate.
 * - Nunca intercepta /api ni WebSocket.
 * Subir VERSION invalida las cachés anteriores.
 */
const VERSION = 'v1';
const SHELL_CACHE = `campo-shell-${VERSION}`;
const STATIC_CACHE = `campo-static-${VERSION}`;
const RUNTIME_CACHE = `campo-runtime-${VERSION}`;
const KEEP = [SHELL_CACHE, STATIC_CACHE, RUNTIME_CACHE];

const PRECACHE = [
  '/',
  '/offline.html',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL_CACHE);
      await Promise.all(PRECACHE.map((u) => shell.add(new Request(u, { cache: 'reload' })).catch(() => {})));
      // Precarga los chunks referenciados por el HTML del shell (JS/CSS con hash).
      try {
        const html = await (await shell.match('/'))?.text();
        const urls = new Set(html?.match(/\/_next\/static\/[^"'\\\s)<>]+/g) ?? []);
        const statics = await caches.open(STATIC_CACHE);
        await Promise.all([...urls].map((u) => statics.add(u).catch(() => {})));
      } catch {
        /* el shell se completará en tiempo de ejecución */
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith('campo-') && !KEEP.includes(n)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

async function networkFirstNavigation(request) {
  try {
    const res = await fetch(request);
    if (res.ok && new URL(request.url).pathname === '/') {
      const copy = res.clone();
      caches.open(SHELL_CACHE).then((c) => c.put('/', copy));
    }
    return res;
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    // /login y demás rutas: el shell cliente de '/' es la mejor aproximación offline
    return (await cache.match(request)) || (await cache.match('/')) || (await cache.match('/offline.html')) || Response.error();
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const hit = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => hit);
  return hit || network;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws' || url.pathname === '/sw.js') return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
  } else if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
  } else {
    event.respondWith(staleWhileRevalidate(request));
  }
});
