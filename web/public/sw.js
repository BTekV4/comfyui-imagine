/**
 * Imagine's service worker: it keeps the application shell, and never the
 * studio's data.
 *
 * The rule that matters: a job, a gallery, a plugin list or a language pack
 * answered from the cache is a lie — a finished job shown as running, a photo
 * that no longer exists, settings from last week. So those always go to the
 * host, and only the shell (the page, its hashed assets, the icons) is cached.
 *
 * Bump VERSION when the shell's rules change: the old cache is dropped on the
 * next activation, so nobody keeps a page from before the update.
 */
const VERSION = 'v1'
const CACHE = `imagine-shell-${VERSION}`
const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
]

/**
 * Paths that must always reach the host: jobs and media (`/comfy-…`), the
 * first-run report, plugins and their bundles, settings, language packs, and
 * this file. `manifest.webmanifest` is cached (in SHELL) but also listed here
 * so a refresh of it never goes through the stale-while-revalidate path.
 */
const LIVE = /^\/(?:comfy-|api\/|plugin\/|plugins(?:\/|$)|setup-status|sw\.js|manifest\.webmanifest)/

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    await cache.addAll(SHELL)
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys()
    await Promise.all(names.filter(name => name !== CACHE).map(name => caches.delete(name)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', event => {
  const request = event.request
  if (request.method !== 'GET') return
  // A video/audio range read is a stream, not a file to keep.
  if (request.headers.has('range')) return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (LIVE.test(url.pathname)) return
  // Assets are named after a hash of their contents: a hit is always right.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request))
    return
  }
  // A page: the network's copy is this build; the cached one is the answer
  // only when the host cannot be reached at all.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request))
    return
  }
  // Icons and covers: the cached one at once, refreshed behind the scenes.
  event.respondWith(staleWhileRevalidate(request))
})

/** The cache's copy if there is one, otherwise fetch it and keep it. */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE)
  const hit = await cache.match(request)
  if (hit !== undefined) return hit
  const answer = await fetch(request)
  if (answer.ok) await cache.put(request, answer.clone())
  return answer
}

/**
 * The network first; on a total failure the shell answers every address, so
 * an installed app opened offline shows its last shell instead of a browser
 * error page (the studio's own calls will say they failed).
 */
async function networkFirst(request) {
  const cache = await caches.open(CACHE)
  try {
    const answer = await fetch(request)
    if (answer.ok) await cache.put('/', answer.clone())
    return answer
  } catch {
    const shell = await cache.match('/')
    return shell ?? Response.error()
  }
}

/** Answer from the cache when there is one, and refresh it in any case. */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE)
  const hit = await cache.match(request)
  const network = fetch(request).then(async answer => {
    if (answer.ok) await cache.put(request, answer.clone())
    return answer
  }).catch(() => hit)
  return hit ?? await network
}
