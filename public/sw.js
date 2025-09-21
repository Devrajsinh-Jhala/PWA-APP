// v5 — same-origin GET only; never cache API or non-GET
const CACHE = "emergency-shell-v5";
const SHELL = [
  "/",
  "/emergency",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
];

// Install: precache app shell
self.addEventListener("install", (e) => {
  e.waitUntil(
    (async () => {
      const c = await caches.open(CACHE);
      // addAll handles cloning internally; don't fail install if one 404s
      try {
        await c.addAll(SHELL);
      } catch (_) {}
    })()
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return; // GET only
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // same-origin only

  // Never intercept API
  if (url.pathname.startsWith("/api/")) {
    e.respondWith(fetch(req)); // network only
    return;
  }

  // NAVIGATION: network-first → fallback to cached shells
  // IMPORTANT: do NOT cache streamed HTML; rely on /emergency precached shell
  if (req.mode === "navigate" || req.destination === "document") {
    e.respondWith(
      (async () => {
        try {
          return await fetch(req);
        } catch {
          return (
            (await caches.match(req)) ||
            (await caches.match("/emergency")) ||
            (await caches.match("/"))
          );
        }
      })()
    );
    return;
  }

  // Is this a static asset? (Next assets, fonts, css/js/images, or precached SHELL)
  const isStaticAsset =
    ["style", "script", "font", "image"].includes(req.destination) ||
    url.pathname.startsWith("/_next/") ||
    SHELL.includes(url.pathname);

  if (isStaticAsset) {
    e.respondWith(
      (async () => {
        const hit = await caches.match(req);
        if (hit) return hit;

        const resp = await fetch(req);
        if (resp && resp.ok && resp.type === "basic") {
          const copy = resp.clone();
          e.waitUntil(
            caches
              .open(CACHE)
              .then((c) => c.put(req, copy))
              .catch(() => {})
          );
        }
        return resp;
      })()
    );
    return;
  }

  // EVERYTHING ELSE (same-origin GET but not API/static): stale-while-revalidate
  e.respondWith(
    (async () => {
      const hit = await caches.match(req);
      const net = fetch(req)
        .then((resp) => {
          if (resp && resp.ok) {
            const copy = resp.clone();
            e.waitUntil(
              caches
                .open(CACHE)
                .then((c) => c.put(req, copy))
                .catch(() => {})
            );
          }
          return resp;
        })
        .catch(() => hit || caches.match("/emergency"));

      return hit || (await net);
    })()
  );
});
