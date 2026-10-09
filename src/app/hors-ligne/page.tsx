import type { Metadata } from "next";
import { HorsLigneClient } from "./HorsLigneClient";

export const metadata: Metadata = {
  title: "Hors ligne — ChantierLive",
};

// L06 (B036, B037 ; O1 à O14 ; D202) — brouillons hors ligne de la personne
// connectée sur cet appareil. Page STATIQUE (aucune donnée serveur, aucune
// session dans le HTML) : le service worker peut la garder pour l'ouvrir sans
// réseau ; tout le contenu vient de la base locale du compte (IndexedDB).
export default function HorsLignePage() {
  return <HorsLigneClient />;
}
