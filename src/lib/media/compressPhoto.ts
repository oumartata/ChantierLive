// B025 — préparation d'une photo sur l'appareil, avant l'envoi. API natives
// du navigateur uniquement (createImageBitmap, canvas.toBlob) : aucune
// dépendance ajoutée. Les décisions (compresser ou non, dimensions,
// qualités, choix du résultat) sont dans photoCompression.ts (fonctions
// pures, testées).
//
// - Orientation : createImageBitmap(..., { imageOrientation: "from-image" })
//   applique l'orientation enregistrée dans la photo ; l'image préparée est
//   donc droite, sans dépendre de ce champ ensuite.
// - Métadonnées : la copie réencodée ne contient plus les métadonnées
//   embarquées (date de prise, position éventuelle). Aucune règle n'en
//   dépend ; la localisation n'est jointe qu'après consentement explicite
//   (BR042, AC063).
// - L'original de l'appareil n'est jamais modifié (BR043) : seule une copie
//   en mémoire est préparée.

import {
  attemptSequence,
  chooseOutcome,
  OUTPUT_PHOTO_TYPE,
  outcomeWhenUnsupported,
  PHOTO_COMPRESSION_DEFAULTS,
  planPhoto,
  preparedFileName,
  targetDimensions,
  type PhotoOutcome,
} from "./photoCompression";

export type PreparedPhoto = { outcome: PhotoOutcome; file: File | null; originalBytes: number };

function canPrepare(): boolean {
  return typeof window !== "undefined" && typeof createImageBitmap === "function" && typeof document !== "undefined";
}

function encode(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), OUTPUT_PHOTO_TYPE, quality));
}

export async function preparePhotoForUpload(original: File, config = PHOTO_COMPRESSION_DEFAULTS): Promise<PreparedPhoto> {
  const originalBytes = original.size;
  const firstLook = planPhoto({ mimeType: original.type, sizeBytes: originalBytes }, null, config);
  if (firstLook.action === "keep" && firstLook.reason === "not_a_photo") {
    return { outcome: { kind: "original", reason: "not_a_photo" }, file: original, originalBytes };
  }
  if (!canPrepare()) {
    const outcome = outcomeWhenUnsupported(originalBytes, config);
    return { outcome, file: outcome.kind === "original" ? original : null, originalBytes };
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(original, { imageOrientation: "from-image" });
  } catch {
    const outcome = outcomeWhenUnsupported(originalBytes, config);
    return { outcome, file: outcome.kind === "original" ? original : null, originalBytes };
  }

  try {
    const plan = planPhoto({ mimeType: original.type, sizeBytes: originalBytes }, { width: bitmap.width, height: bitmap.height }, config);
    if (plan.action === "keep") {
      return { outcome: { kind: "original", reason: "within_target" }, file: original, originalBytes };
    }

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      const outcome = outcomeWhenUnsupported(originalBytes, config);
      return { outcome, file: outcome.kind === "original" ? original : null, originalBytes };
    }

    const results: { attempt: { scale: number; quality: number }; sizeBytes: number; blob: Blob }[] = [];
    let drawnScale: number | null = null;
    for (const attempt of attemptSequence(config)) {
      if (drawnScale !== attempt.scale) {
        const dims = targetDimensions(bitmap.width, bitmap.height, config.maxLongSide, attempt.scale);
        canvas.width = dims.width;
        canvas.height = dims.height;
        // Fond blanc : une image avec transparence (PNG, WebP) devient un
        // JPEG lisible, jamais un fond noir.
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, dims.width, dims.height);
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(bitmap, 0, 0, dims.width, dims.height);
        drawnScale = attempt.scale;
      }
      const blob = await encode(canvas, attempt.quality);
      if (!blob) continue;
      results.push({ attempt, sizeBytes: blob.size, blob });
      if (blob.size <= config.targetBytes) break; // meilleure qualité qui respecte la cible
    }

    if (results.length === 0) {
      const outcome = outcomeWhenUnsupported(originalBytes, config);
      return { outcome, file: outcome.kind === "original" ? original : null, originalBytes };
    }

    const outcome = chooseOutcome(
      originalBytes,
      results.map(({ attempt, sizeBytes }) => ({ attempt, sizeBytes })),
      config
    );
    if (outcome.kind === "compressed") {
      const chosen = results.find((r) => r.attempt === outcome.attempt);
      const file = new File([chosen!.blob], preparedFileName(original.name), { type: OUTPUT_PHOTO_TYPE, lastModified: Date.now() });
      return { outcome, file, originalBytes };
    }
    return { outcome, file: outcome.kind === "original" ? original : null, originalBytes };
  } finally {
    bitmap.close();
  }
}
