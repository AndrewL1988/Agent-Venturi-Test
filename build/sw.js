// Agent Venturi Service Worker — offline caching for reference tools
const CACHE = "agent-venturi-v1";
const STATIC = [
  "/",
  "/index.html",
  "/agent_venturi_FINAL_full_logo.png",
  "/agent_venturi_FINAL_small_icon.png",
  "/agent_venturi_FINAL_app_icon.png",
  "/agent_venturi_FINAL_chat_icon.png",
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  // Never cache API calls — always go to network
  if (url.pathname.startsWith("/api/")) return;
  // Cache-first for static assets, network-first for HTML
  if (e.request.destination === "document" || url.pathname === "/") {
    e.respondWith(
      fetch(e.request).then(r => {
        const clone = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return r;
      }).catch(() => caches.match(e.request))
    );
  } else {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(r => {
          if (r.status === 200) {
            const clone = r.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return r;
        });
      })
    );
  }
});
