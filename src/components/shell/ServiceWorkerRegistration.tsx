"use client";

import { useEffect } from "react";

// Enregistre le service worker du socle PWA (public/sw.js, lot B004)
// uniquement en production. En développement, un service worker actif
// intercepterait les requêtes du serveur de dev (Turbopack/HMR) et risquerait
// de servir des fichiers obsolètes après un redémarrage — toute inscription
// existante y est donc explicitement retirée plutôt qu'ignorée.
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) {
      return;
    }

    if (process.env.NODE_ENV !== "production") {
      navigator.serviceWorker.getRegistrations().then((registrations) => {
        registrations.forEach((registration) => registration.unregister());
      });
      return;
    }

    navigator.serviceWorker.register("/sw.js").catch((error: unknown) => {
      console.error("Échec de l'enregistrement du service worker", error);
    });
  }, []);

  return null;
}
