const ACRESIGNAL_CACHE_PREFIX = "acresignal-shell-";
const ACRESIGNAL_CACHE_VERSION = "v2";
const ACRESIGNAL_SHELL_CACHE = `${ACRESIGNAL_CACHE_PREFIX}${ACRESIGNAL_CACHE_VERSION}`;
const ACRESIGNAL_APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png"
];
const STATIC_DESTINATIONS = new Set(["font", "image", "manifest", "script", "style"]);
const PRIVATE_OR_API_PATH = /^\/(?:api|auth|oauth|login|logout|callback|functions|graphql|realtime|rest|rpc|storage|supabase)(?:\/|$)/i;
const TILE_OR_MAP_PATH = /^\/(?:basemap|imagery|maps?|tiles?)(?:\/|$)/i;

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function isPrivateOrApiRequest(request, url) {
  return PRIVATE_OR_API_PATH.test(url.pathname)
    || TILE_OR_MAP_PATH.test(url.pathname)
    || request.headers.has("authorization")
    || request.headers.has("range");
}

function isCacheableStaticRequest(request, url) {
  return request.method === "GET"
    && isSameOrigin(url)
    && !isPrivateOrApiRequest(request, url)
    && STATIC_DESTINATIONS.has(request.destination);
}

function isCacheableStaticResponse(response) {
  if (!response || !response.ok || response.type !== "basic") return false;
  const cacheControl = response.headers.get("cache-control") ?? "";
  return !/(?:no-store|private)/i.test(cacheControl) && !response.headers.has("set-cookie");
}

function isContentHashedAsset(url) {
  return /^\/assets\/.*-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(url.pathname);
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(ACRESIGNAL_SHELL_CACHE)
      .then((cache) => cache.addAll(ACRESIGNAL_APP_SHELL))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames
        .filter((cacheName) => cacheName.startsWith(ACRESIGNAL_CACHE_PREFIX) && cacheName !== ACRESIGNAL_SHELL_CACHE)
        .map((cacheName) => caches.delete(cacheName))
    );
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET" || !isSameOrigin(url) || isPrivateOrApiRequest(request, url)) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok && response.type === "basic") {
          const cache = await caches.open(ACRESIGNAL_SHELL_CACHE);
          await cache.put("/index.html", response.clone());
        }
        return response;
      } catch {
        return await caches.match("/index.html")
          ?? await caches.match("/")
          ?? Response.error();
      }
    })());
    return;
  }

  if (!isCacheableStaticRequest(request, url)) return;

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached && isContentHashedAsset(url)) return cached;

    try {
      const response = await fetch(request);
      if (isCacheableStaticResponse(response)) {
        const cache = await caches.open(ACRESIGNAL_SHELL_CACHE);
        await cache.put(request, response.clone());
      }
      return response;
    } catch {
      return cached ?? Response.error();
    }
  })());
});
