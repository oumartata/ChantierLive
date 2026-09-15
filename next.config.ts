import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // En-têtes sécurisés du service worker (lot B004) : type MIME
        // explicite, jamais mis en cache par le navigateur (sinon les mises
        // à jour du fichier lui-même ne seraient jamais détectées), et
        // portée CSP limitée à l'origine (self) pour son contexte d'exécution.
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;
