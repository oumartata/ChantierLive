// B047 — partage manuel du rapport de suivi (BR072, AC123, FR123, FR138 ;
// D200). Fonctions pures, sans dépendance, testées par
// scripts/test-report-share.mjs.
//
// - Le fichier partagé est EXACTEMENT le PDF de B046 pour ce rôle, généré à
//   la demande ; il est joint au menu de partage natif de l'appareil (Web
//   Share API avec fichier), d'où l'on choisit WhatsApp.
// - Aucun lien : ni public, ni signé, ni vers le chantier, le rapport ou un
//   fichier. Le contenu partagé ne contient JAMAIS de champ « url ».
// - Texte minimal, sans aucune donnée du chantier (ni nom, ni montant, ni
//   date, ni personne) : le destinataire reçoit seulement le fichier choisi.
// - Repli : si l'appareil ne sait pas partager un fichier, le PDF est
//   téléchargé et la personne l'envoie elle-même depuis WhatsApp.

export const SHARE_TITLE = "Rapport de suivi de chantier";
export const SHARE_TEXT = "Rapport de suivi de chantier (PDF) établi avec ChantierLive.";

export interface ShareFile {
  name: string;
  type: string;
  size: number;
}

export interface SharePayload<F extends ShareFile> {
  title: string;
  text: string;
  files: F[];
}

export function buildSharePayload<F extends ShareFile>(file: F): SharePayload<F> {
  return { title: SHARE_TITLE, text: SHARE_TEXT, files: [file] };
}

interface ShareCapableNavigator<F> {
  canShare?: (data: { files: F[] }) => boolean;
  share?: unknown;
}

// Partage natif d'un fichier possible sur cet appareil ?
export function canShareFile<F extends ShareFile>(nav: ShareCapableNavigator<F> | undefined, file: F): boolean {
  if (!nav || typeof nav.share !== "function" || typeof nav.canShare !== "function") return false;
  try {
    return nav.canShare({ files: [file] }) === true;
  } catch {
    return false;
  }
}

// Nom du fichier tiré de l'en-tête Content-Disposition (B046 :
// rapport-chantier-<identifiant court>-<du>_<au>.pdf), sinon nom générique.
export function fileNameFromDisposition(header: string | null): string {
  const m = /filename="([^"]+)"/.exec(header ?? "");
  return m && /^rapport-chantier-[0-9a-f]{8}-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.pdf$/.test(m[1]) ? m[1] : "rapport-chantier.pdf";
}
