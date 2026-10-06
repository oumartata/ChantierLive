// F2 — recherche adaptée hors du fil de l'interface (Web Worker, sans
// dépendance). Reçoit une COPIE du plan et les autorisations valides ;
// renvoie la régénération ordinaire (propositions sans réduction) et la
// régénération adaptée (regenerateWithAllowances). Aucun accès au brouillon :
// l'éditeur seul décide d'afficher (si le plan n'a pas changé entre-temps)
// ou d'ignorer le résultat. Annulation = terminaison du worker par l'éditeur.
import { regenerateUnlocked, regenerateWithAllowances, type DimensionAllowance, type Layout } from "./geometry";

export interface AdaptedSearchRequest {
  id: number;
  layout: Layout;
  allowances: DimensionAllowance[];
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<AdaptedSearchRequest>) => void) | null;
  postMessage: (message: unknown) => void;
};

ctx.onmessage = (e) => {
  const { id, layout, allowances } = e.data;
  const t0 = Date.now();
  try {
    const ordinary = regenerateUnlocked(layout);
    const adapted = regenerateWithAllowances(layout, { allowances });
    ctx.postMessage({ id, ok: true, ordinary, adapted, millis: Date.now() - t0 });
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err), millis: Date.now() - t0 });
  }
};
