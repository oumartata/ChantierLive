// B025 — compression des photos sur l'appareil, avant l'envoi (FR064,
// AC064, NFR003, BR043, EC026). Logique PURE : dimensions cibles, qualités
// essayées, choix du résultat. Aucun accès au navigateur ici (voir
// compressPhoto.ts) ; testée par scripts/test-photo-compression.mjs.
//
// Règles écrites appliquées :
// - NFR003 : cible configurable <= 1,5 Mo par photo ;
// - AC064 : une photo qui DÉPASSE la cible est préparée en une version qui
//   respecte la taille et la qualité configurées ;
// - BR043 : qualité lisible ; l'original de l'appareil n'est jamais modifié
//   ni supprimé (seule une copie est préparée) ;
// - EC026 : si la photo ne peut pas être ramenée à la cible de façon sûre,
//   elle est refusée avec une explication, sans bloquer le reste.
// Les valeurs ci-dessous sont des PARAMÈTRES de départ, réglables, jamais une
// norme : seule la cible de 1,5 Mo vient d'une exigence écrite (NFR003).

export interface PhotoCompressionConfig {
  // Taille maximale visée pour une photo envoyée (octets).
  targetBytes: number;
  // Plus grand côté de l'image envoyée (pixels) ; jamais d'agrandissement.
  maxLongSide: number;
  // Qualités JPEG essayées, de la meilleure à la plus basse admise.
  qualities: number[];
  // Réductions supplémentaires du côté long si la cible n'est pas atteinte.
  extraScales: number[];
}

export const PHOTO_COMPRESSION_DEFAULTS: PhotoCompressionConfig = {
  targetBytes: 1_500_000,
  maxLongSide: 2560,
  qualities: [0.85, 0.75, 0.65, 0.6],
  extraScales: [0.8, 0.64],
};

// Types d'image que l'appareil sait préparer ; le résultat est toujours un
// JPEG (format accepté par le serveur, image/jpeg).
export const COMPRESSIBLE_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const OUTPUT_PHOTO_TYPE = "image/jpeg";

export interface PhotoInput {
  mimeType: string;
  sizeBytes: number;
}

export type PhotoPlan =
  | { action: "keep"; reason: "not_a_photo" | "within_target" }
  | { action: "compress"; reason: "above_target" | "too_large_dimensions" };

// Faut-il préparer une copie compressée ? Seules les photos qui dépassent la
// cible (AC064) ou des dimensions raisonnables le sont ; une photo déjà
// légère est envoyée telle quelle (aucune perte inutile). Les vidéos et
// autres fichiers ne sont jamais touchés (B025 : photos seulement).
export function planPhoto(input: PhotoInput, dims: { width: number; height: number } | null, config = PHOTO_COMPRESSION_DEFAULTS): PhotoPlan {
  if (!COMPRESSIBLE_PHOTO_TYPES.includes(input.mimeType)) return { action: "keep", reason: "not_a_photo" };
  if (input.sizeBytes > config.targetBytes) return { action: "compress", reason: "above_target" };
  if (dims && Math.max(dims.width, dims.height) > config.maxLongSide) return { action: "compress", reason: "too_large_dimensions" };
  return { action: "keep", reason: "within_target" };
}

// Dimensions cibles : proportions conservées, entiers, jamais plus grandes
// que l'original (aucun agrandissement), jamais nulles.
export function targetDimensions(width: number, height: number, maxLongSide: number, extraScale = 1): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) throw new Error("Dimensions d'image invalides.");
  const longSide = Math.max(width, height);
  const scale = Math.min(1, maxLongSide / longSide) * Math.min(1, extraScale);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export interface Attempt {
  scale: number;
  quality: number;
}

// Ordre des essais : dimensions maximales d'abord, qualités décroissantes ;
// puis réductions supplémentaires. On s'arrête au premier essai qui respecte
// la cible (compressPhoto.ts), donc la meilleure qualité possible est gardée.
export function attemptSequence(config = PHOTO_COMPRESSION_DEFAULTS): Attempt[] {
  const scales = [1, ...config.extraScales];
  return scales.flatMap((scale) => config.qualities.map((quality) => ({ scale, quality })));
}

export type PhotoOutcome =
  | { kind: "original"; reason: "not_a_photo" | "within_target" | "original_smaller" | "unsupported_within_target" }
  | { kind: "compressed"; sizeBytes: number; attempt: Attempt }
  | { kind: "refused"; reason: "target_unreachable" | "unsupported_above_target"; message: string };

const mo = (bytes: number) => `${(bytes / 1_000_000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Mo`;

// Choix final à partir des essais réellement produits (taille de chaque
// résultat). Jamais un résultat plus lourd que l'original ; jamais un envoi
// au-dessus de la cible pour une photo qui la dépassait (AC064) : refus
// expliqué (EC026).
export function chooseOutcome(
  originalBytes: number,
  results: { attempt: Attempt; sizeBytes: number }[],
  config = PHOTO_COMPRESSION_DEFAULTS
): PhotoOutcome {
  const fitting = results.find((r) => r.sizeBytes <= config.targetBytes);
  if (fitting) {
    if (fitting.sizeBytes >= originalBytes) return { kind: "original", reason: "original_smaller" };
    return { kind: "compressed", sizeBytes: fitting.sizeBytes, attempt: fitting.attempt };
  }
  if (originalBytes <= config.targetBytes) return { kind: "original", reason: "original_smaller" };
  return {
    kind: "refused",
    reason: "target_unreachable",
    message: `Cette photo (${mo(originalBytes)}) ne peut pas être ramenée sous ${mo(config.targetBytes)} sans perdre sa lisibilité. Choisissez une autre photo ; vos autres envois ne sont pas concernés.`,
  };
}

// Navigateur incapable de préparer la photo (API absente ou image illisible
// par l'appareil) : une photo déjà sous la cible part telle quelle ; une
// photo au-dessus est refusée avec explication (EC026, AC064).
export function outcomeWhenUnsupported(originalBytes: number, config = PHOTO_COMPRESSION_DEFAULTS): PhotoOutcome {
  if (originalBytes <= config.targetBytes) return { kind: "original", reason: "unsupported_within_target" };
  return {
    kind: "refused",
    reason: "unsupported_above_target",
    message: `Cet appareil n'a pas pu préparer la photo (${mo(originalBytes)}, au-delà de ${mo(config.targetBytes)}). Essayez une autre photo ou un autre navigateur ; vos autres envois ne sont pas concernés.`,
  };
}

// Nom du fichier préparé : même nom, extension .jpg (contenu JPEG).
export function preparedFileName(originalName: string): string {
  const base = originalName.replace(/\.[^./\\]+$/, "") || "photo";
  return `${base}.jpg`;
}

export function formatMegabytes(bytes: number): string {
  return mo(bytes);
}
