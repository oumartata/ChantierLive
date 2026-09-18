// Service worker du socle ChantierLive (lot B004).
//
// Portée strictement limitée au shell technique et aux ressources statiques
// publiques. Aucune interception d'API, d'authentification, de données
// Supabase, de données financières, de photos/documents privés ou de toute
// réponse propre à un utilisateur : ces requêtes ne sont jamais capturées
// par ce fichier (voir NEVER_CACHE_PREFIXES et le filtrage par liste
// blanche ci-dessous).

// v3 : correction du gestionnaire fetch — les requêtes RSC Next.js
// (paramètre _rsc, en-têtes RSC/Next-Router) étaient à tort assimilées à la
// ressource précachée "/" et interceptées, et le repli stale-while-revalidate
// pouvait résoudre vers `undefined` (Promise toujours "truthy") au lieu
// d'une vraie Response, provoquant "Failed to convert value to 'Response'".
//
// v4 (B012) : "/" retiré du précache. L'authentification introduit des
// routes dont la réponse dépend de la session (cookies, éventuel
// Set-Cookie) ; une réponse "/" figée à l'installation pourrait devenir
// incohérente. Version de cache renouvelée pour purger l'ancienne entrée
// précachée chez les utilisateurs existants (activate ci-dessous supprime
// tout cache dont le nom ne correspond plus à CACHE_VERSION).
const CACHE_VERSION = "chantierlive-shell-v4";
const OFFLINE_URL = "/offline";

// Shell + ressources publiques précachées à l'installation. Ne jamais y
// remettre "/" ni aucune route dont la réponse peut varier selon la
// session/l'authentification.
const PRECACHE_URLS = [
  OFFLINE_URL,
  "/manifest.webmanifest",
  "/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
];

// Préfixes d'origine dont les réponses peuvent être mises en cache au fil de
// l'eau : uniquement des bundles/assets statiques publics, jamais de route
// dynamique ou propre à un utilisateur.
const RUNTIME_CACHEABLE_PREFIXES = ["/_next/static/", "/icons/"];

// Liste noire explicite : toujours réseau direct, jamais de cache, même si
// un préfixe ci-dessus venait à correspondre par erreur.
const NEVER_CACHE_PREFIXES = ["/api/", "/auth/", "/supabase/"];

// En-têtes que Next.js pose sur ses propres requêtes internes (React Server
// Components, prefetch de routeur) — jamais des navigations réelles, jamais
// des ressources publiques statiques. Toujours réseau direct, jamais capturé.
const RSC_HEADER_NAMES = ["rsc", "next-router-state-tree", "next-router-prefetch", "next-url"];

function isNextInternalRequest(request, url) {
  if (url.searchParams.has("_rsc")) {
    return true;
  }
  return RSC_HEADER_NAMES.some((name) => request.headers.has(name));
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      // Ne pas activer automatiquement : voir le gestionnaire "message"
      // (mise à jour contrôlée par le client, pas silencieuse).
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

// Mise à jour contrôlée : un nouveau service worker reste "en attente"
// jusqu'à ce que le client envoie explicitement ce message (pas de
// remplacement silencieux du cache actif).
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) {
    return;
  }

  if (isNeverCached(url) || isNextInternalRequest(request, url)) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (isRuntimeCacheable(url)) {
    event.respondWith(staleWhileRevalidate(event, request));
  }

  // Toute autre requête (y compris API, auth, Supabase, RSC, données
  // privées) : ni interceptée ni mise en cache, réseau direct par défaut du
  // navigateur — event.respondWith n'est jamais appelé dans ce cas.
});

function isNeverCached(url) {
  return NEVER_CACHE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

// Une URL n'est considérée comme la ressource précachée que si son chemin
// ET sa recherche correspondent exactement — "/?_rsc=abc" n'est donc jamais
// assimilée à "/" (voir aussi isNextInternalRequest, vérifié en amont).
function isPrecachedUrl(url) {
  return url.search === "" && PRECACHE_URLS.includes(url.pathname);
}

function isRuntimeCacheable(url) {
  return (
    RUNTIME_CACHEABLE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix)) ||
    isPrecachedUrl(url)
  );
}

// Stratégie réseau prudente pour la navigation : toujours essayer le réseau
// en premier (jamais de page obsolète servie silencieusement) ; la page
// hors ligne minimale n'apparaît qu'en dernier recours.
async function networkFirstNavigation(request) {
  try {
    return await fetch(request);
  } catch {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(OFFLINE_URL);
    return cached || Response.error();
  }
}

// Doit toujours résoudre vers une vraie Response, jamais `undefined` :
// `respondWith` lève "Failed to convert value to 'Response'" sinon.
// (Le bug précédent renvoyait la Promise `network` elle-même — toujours
// "truthy" même quand elle finit par résoudre `undefined` via le .catch —
// au lieu d'attendre sa résolution.)
async function staleWhileRevalidate(event, request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);

  const networkUpdate = fetch(request)
    .then((response) => {
      if (response && response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    // Sert le cache immédiatement ; la mise à jour continue en arrière-plan
    // sans bloquer la réponse (waitUntil évite que le worker soit arrêté
    // avant la fin de cette mise à jour).
    event.waitUntil(networkUpdate);
    return cached;
  }

  const networkResponse = await networkUpdate;
  return networkResponse || Response.error();
}
