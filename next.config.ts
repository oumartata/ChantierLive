import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // B046 (D200) : rapport PDF généré côté serveur avec pdfkit, qui lit ses
  // fichiers de métriques et la police intégrée (via fontkit) sur le disque ;
  // ces deux paquets restent donc chargés par Node, hors du regroupement.
  serverExternalPackages: ["pdfkit", "fontkit"],
  // "Body exceeded 1 MB limit" sur le dépôt de plan (constat fondateur) :
  // Next.js limite par défaut le corps d'une Server Action à 1 Mo — une
  // limite de TRANSPORT du framework, sans rapport avec le flux
  // prepare/upload/finalize déjà livré. Le bucket Storage "project-plans"
  // (M020) a lui-même TOUJOURS été configuré à file_size_limit=20971520
  // (20 Mo, PDF/JPEG/PNG) — c'est cette limite, déjà décidée pour ce flux,
  // qui sert de référence ici, pas une valeur arbitraire. +1 Mo de marge
  // pour les en-têtes/limites de multipart/form-data (recommandation de la
  // documentation Next.js elle-même) — le plafond réel reste celui du
  // bucket : un fichier de 20 Mo passe le transport puis est de toute façon
  // refusé par Storage au-delà, inchangé.
  experimental: {
    serverActions: {
      bodySizeLimit: "21mb",
    },
  },
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
