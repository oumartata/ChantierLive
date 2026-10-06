// M034 — validation à l'écriture d'une variante de demande de plan.
// Fonction pure, appelée par savePlanRequestVariantAction AVANT toute
// attestation, et exercée telle quelle par scripts/test-plan-request-
// variant-attestation.mjs. Réutilise validateProjectFile sans le modifier :
// - fichier structurellement invalide : refus ;
// - autorisations F2 invalides (tout avis de validation) : refus explicite,
//   jamais un retrait silencieux ;
// - aucune exigence d'admissibilité géométrique ajoutée.
// Le fichier renvoyé est le fichier EFFECTIVEMENT validé (celui à attester).

import { validateProjectFile, type ProjectFile } from "./projectFile";

export function validateVariantLayoutForSave(layoutRaw: string): { ok: true; file: ProjectFile } | { ok: false; message: string } {
  let layout: unknown;
  try {
    layout = JSON.parse(layoutRaw);
  } catch {
    return { ok: false, message: "Fichier de projet illisible (JSON invalide)." };
  }
  const validated = validateProjectFile(layout);
  if (!validated.ok) return { ok: false, message: `Fichier de projet invalide : ${validated.error}` };
  if (validated.notices.length > 0) {
    // Motif précis repris de l'avis : « écartées (motif) : … » ou
    // « ignorées : motif. » (fichier antérieur à v5) ; sinon l'avis entier.
    const reasons = validated.notices.map((n) => n.match(/écartées \((.+)\) :/)?.[1] ?? n.match(/ignorées : (.+?)\.?$/)?.[1] ?? n);
    return {
      ok: false,
      message: `Enregistrement refusé : les autorisations d'adaptation de ce plan sont invalides (${reasons.join(" ; ")}). Corrigez-les ou révoquez-les dans le panneau d'adaptation, puis enregistrez à nouveau.`,
    };
  }
  return { ok: true, file: validated.value };
}
