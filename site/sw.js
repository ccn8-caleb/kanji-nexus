// Kanji Nexus service worker: network-first with an offline cache.
//
// * Online: every same-origin GET goes to the network (so deploys are picked up
//   immediately) and the response refreshes the cache.
// * Offline / network failing: the cached copy is served.
// * Install: the whole app is precached so every page works offline after one visit.
//
// CI replaces VERSION and PRECACHE at deploy time (see .github/workflows/static.yml).
// Locally they stay as below and pages are cached as they are visited.
// Cross-origin requests (Google sign-in, Drive API) are never touched.

const VERSION = 'dev';
const PRECACHE = [];
const CACHE = `kanji-nexus-${VERSION}`;
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('kanji-nexus-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  const isPage = request.mode === 'navigate';
  // Pages are cached without their query (?focus=…) so one entry serves every deep link.
  const key = isPage ? new URL(request.url).origin + new URL(request.url).pathname : request;
  // Offline page fallback: the exact page, else the map (cached as index.html or as "/").
  const fromCache = async () =>
    (await cache.match(key)) ||
    (isPage ? (await cache.match(new URL('./index.html', self.location).href)) || (await cache.match(new URL('./', self.location).href)) : undefined);

  // Pages always revalidate with the server (bypassing the browser's HTTP cache), so a
  // new deploy's HTML, which points at new ?v= asset URLs, is picked up immediately.
  // (A navigate-mode Request can't take init options, hence fetching by URL.)
  const network = (isPage ? fetch(request.url, { cache: 'no-cache', credentials: 'same-origin' }) : fetch(request)).then((response) => {
    if (response.ok) cache.put(key, response.clone());
    return response;
  });
  try {
    // Slow network: fall back to the cache after a few seconds if we have a copy,
    // otherwise keep waiting for the network.
    const winner = await Promise.race([network, new Promise((r) => setTimeout(r, NETWORK_TIMEOUT_MS, 'timeout'))]);
    if (winner !== 'timeout') return winner;
    return (await fromCache()) || (await network);
  } catch (err) {
    const cached = await fromCache();
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(networkFirst(request));
});
