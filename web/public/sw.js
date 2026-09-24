/* L'interface web, gardée par le navigateur pour s'ouvrir quand le serveur
 * ne répond pas — avec la copie hors ligne (`src/lib/offline.ts`), c'est ce
 * qui permet de lire son coffre sans lui.
 *
 * - `/assets/…` (noms versionnés, immuables) : le cache d'abord ;
 * - les pages : le réseau d'abord, le cache s'il ne répond pas — une page
 *   en ligne est toujours celle du serveur, jamais une version gardée ;
 * - l'API (`/api/`) ne passe jamais par ici : rien de ce qu'elle renvoie
 *   n'est mis en cache.
 *
 * Même origine, servi par le binaire comme le reste (`web.rs`, CSP
 * comprise, que la page gardée conserve). Changer ce fichier remplace
 * l'ancien au prochain chargement. */
const CACHE = "guivault-shell-v1";

/** La page et ce qu'elle charge d'emblée, relevé dans `index.html`. */
async function precache() {
  const cache = await caches.open(CACHE);
  const res = await fetch("/", { cache: "no-cache" });
  if (!res.ok) return;
  const html = await res.clone().text();
  await cache.put("/", res);
  const assets = [...html.matchAll(/(?:src|href)="(\/(?:assets\/[^"]+|favicon\.png|apple-touch-icon\.png))"/g)].map((m) => m[1]);
  await Promise.all(assets.map((a) => cache.add(a).catch(() => {})));
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache().catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ??
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // La page (routage côté client : toujours `index.html`).
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put("/", copy));
          }
          return res;
        })
        .catch(() => caches.match("/").then((hit) => hit ?? Response.error())),
    );
  }
});
