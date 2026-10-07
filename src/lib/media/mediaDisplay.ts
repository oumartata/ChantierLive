// B027 — libellés d'origine et métadonnées d'un média de suivi (FR062,
// AC062, BR040, BR041, UX_COPY TXT036/TXT037/TXT038). Logique PURE, testée
// par scripts/test-media-display.mjs.
//
// BR041 : seuls « Capturée dans l'application » et « Importée » sont
// autorisés, jamais « Vérifiée » ni « Incontestable ». Libellés exacts
// d'UX_COPY (AC062 : « libellé exact correspondant »).

export const ORIGIN_NOTICE =
  "Cette mention indique seulement l'origine d'ajout. Elle ne garantit pas l'authenticité de l'image.";

export interface OriginLabel {
  label: string;
  known: boolean;
}

export function originLabel(origin: string | null | undefined): OriginLabel {
  if (origin === "CAPTURED") return { label: "Capturée dans l'application", known: true };
  if (origin === "IMPORTED") return { label: "Photo importée", known: true };
  // Valeur imprévue : jamais présentée comme une garantie.
  return { label: "Origine non renseignée", known: false };
}

const KIND: Record<string, string> = {
  "image/jpeg": "Photo JPEG",
  "image/png": "Photo PNG",
  "image/webp": "Photo WebP",
  "video/mp4": "Vidéo MP4",
};

export function mediaKindLabel(mimeType: string | null | undefined): string {
  if (!mimeType) return "Type inconnu";
  return KIND[mimeType] ?? (mimeType.startsWith("video/") ? "Vidéo" : mimeType.startsWith("image/") ? "Photo" : "Fichier");
}

// Taille lisible en français (Ko/Mo, 1 décimale au plus, virgule).
export function formatFileSize(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1000) return `${bytes} octets`;
  const fmt = (v: number) => (Math.round(v * 10) / 10).toString().replace(".", ",");
  if (bytes < 1_000_000) return `${fmt(bytes / 1000)} Ko`;
  return `${fmt(bytes / 1_000_000)} Mo`;
}
