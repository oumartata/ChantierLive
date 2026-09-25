import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "ChantierLive",
    short_name: "ChantierLive",
    // Description prudente : aucune promesse d'authenticité ou de preuve
    // absolue (voir BRAND_DIRECTIONS.yaml prohibited_claims).
    description:
      "Suivi de chantier à distance : avancement, dépenses et documents consultables où que vous soyez.",
    start_url: "/",
    display: "standalone",
    // Non verrouillée : l'application est utilisée aussi bien en portrait
    // (mobile) qu'en paysage (tablette, ordinateur) — voir RESPONSIVE_RULES.yaml.
    orientation: "any",
    background_color: "#eef2f5",
    theme_color: "#0b3b5c",
    // Uniquement des icônes PNG rastérisées : /icon.svg reste le favicon
    // Next.js mais n'est plus déclaré comme icône du manifeste (échec de
    // chargement constaté dans le panneau Application de Chrome DevTools
    // malgré une réponse HTTP et un SVG valides).
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
