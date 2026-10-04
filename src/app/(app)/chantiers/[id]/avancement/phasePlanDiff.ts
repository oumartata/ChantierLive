// Comparaison pure (aucune dépendance) entre la liste d'étapes soumise pour une
// restructuration et les étapes actives actuelles. Une restructuration
// identique ne doit jamais produire d'événement STRUCTURE_CHANGED : l'historique
// est append-only, une entrée sans changement ne pourrait plus être retirée.

const PERCENT = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 });
const NBSP = " ";

// Affichage d'un pourcentage en français (« 22,5 % » et non « 22.5 % »), arrondi
// à 2 décimales, avec une espace insécable avant « % » : le symbole ne passe
// jamais seul à la ligne sur mobile.
export function formatPercent(value: number | string | null | undefined): string {
  return `${PERCENT.format(Number(value ?? 0))}${NBSP}%`;
}

export type CurrentPhase = { phase_id: string; position: number; label: string; weight: number | string };

export function isSameStructure(submitted: unknown, current: CurrentPhase[]): boolean {
  if (!Array.isArray(submitted) || submitted.length !== current.length) return false;
  const ordered = [...current].sort((a, b) => a.position - b.position);
  return submitted.every((item, i) => {
    if (typeof item !== "object" || item === null) return false;
    const s = item as Record<string, unknown>;
    const c = ordered[i];
    return (
      s.phase_id === c.phase_id &&
      typeof s.label === "string" &&
      s.label.trim() === c.label.trim() &&
      Number(s.weight) === Number(c.weight)
    );
  });
}
