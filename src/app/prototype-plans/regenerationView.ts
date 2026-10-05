// Présentation des propositions de régénération (lot « comparer et
// choisir », 2026-10-05). Module PUR, sans React : il ne relance aucune
// recherche et ne modifie aucune donnée produite par le moteur — il
// réordonne seulement des RÉFÉRENCES (indices dans `result.variants`) et
// relit des grandeurs déjà calculées (surfaces, contour englobant,
// independentVerify). Aucun score nouveau.
import { independentVerify, type Layout, type RegenerationResult } from "./geometry";

// Libellé posé par le moteur sur la disposition identique au brouillon.
export const CURRENT_VARIANT_LABEL = "Disposition actuelle (inchangée)";
// Cartes affichées à la fois ; « Afficher davantage » en ajoute autant.
export const REGEN_PAGE_SIZE = 6;
// Même seuil que compareLayoutQuality : un écart plus petit n'est jamais
// présenté comme une différence.
const EPS = 0.05;

export interface LayoutMetrics {
  circulation: number;
  cheminementExterieur: number;
  // Circulation intérieure + cheminement extérieur (somme des deux
  // grandeurs déjà calculées, rien d'autre).
  total: number;
  footprint: { w: number; d: number; area: number } | null;
  errors: number;
  warnings: number;
  lockedCount: number;
  // Chaque pièce verrouillée du brouillon garde position, dimensions,
  // portes et fenêtres à l'identique.
  locksPreserved: boolean;
}

const openingsOf = (layout: Layout, roomIndex: number) =>
  JSON.stringify({
    d: layout.doors.filter((d) => d.roomIndex === roomIndex).map((d) => [d.wall, d.cx, d.cy, d.width, d.to]),
    w: layout.windows.filter((w) => w.roomIndex === roomIndex).map((w) => [w.wall, w.cx, w.cy, w.width]),
  });

export function metricsOf(layout: Layout, base: Layout): LayoutMetrics {
  const issues = independentVerify(layout);
  const lockedIdx = base.rooms.map((r, i) => (r.locked && !r.parked ? i : -1)).filter((i) => i >= 0);
  const locksPreserved = lockedIdx.every((i) => {
    const a = base.rooms[i];
    const b = layout.rooms[i];
    return !!b && b.locked === true && a.x === b.x && a.y === b.y && a.w === b.w && a.d === b.d && openingsOf(layout, i) === openingsOf(base, i);
  });
  return {
    circulation: layout.surfaces.circulation,
    cheminementExterieur: layout.surfaces.cheminementExterieur,
    total: layout.surfaces.circulation + layout.surfaces.cheminementExterieur,
    footprint: layout.footprint ? { w: layout.footprint.w, d: layout.footprint.d, area: layout.footprint.w * layout.footprint.d } : null,
    errors: issues.filter((i) => i.severity === "error").length,
    warnings: issues.filter((i) => i.severity !== "error").length,
    lockedCount: lockedIdx.length,
    locksPreserved,
  };
}

export interface ProposalEntry {
  // Identité de la proposition : son indice dans `result.variants`, jamais
  // son numéro d'affichage.
  engineIndex: number;
  // Numéro d'affichage, continu (1..N) et stable tant que le panneau reste
  // ouvert sur le même résultat.
  displayNumber: number;
  metrics: LayoutMetrics;
  note: string;
  // Moins de circulation intérieure que l'actuelle MAIS plus de cheminement
  // extérieur : le classement existant ne compte pas ce dernier.
  exteriorTradeoff: boolean;
}

export interface RegenerationView {
  current: LayoutMetrics;
  // Indice de la disposition actuelle dans `result.variants` si la recherche
  // l'a retrouvée admissible, sinon null.
  currentEngineIndex: number | null;
  proposals: ProposalEntry[];
}

// « Classement selon les surfaces » (affichage uniquement). Reprend les
// critères du classement du moteur (compareLayoutQuality dans
// geometry.ts, NON modifié : il peut aussi peser sur la sélection des
// candidats), dans le même ordre et avec le même seuil, à UNE différence
// près : le premier critère compte la circulation intérieure PLUS le
// cheminement extérieur. Le comparateur du moteur ne compte que la
// circulation intérieure : une proposition qui la réduit en déplaçant le
// trajet d'entrée à l'extérieur y passe devant, sans économie réelle
// (ex. fixture B3 Salon 1 : 25,42 + 4,56 = 29,98 m² contre 29,74 m²).
// Critères, dans l'ordre (le premier qui départage l'emporte) :
//  1) circulation intérieure + cheminement extérieur, la plus faible ;
//  2) contour englobant (rectangle) le plus petit ;
//  3) distance moyenne à vol d'oiseau entre l'entrée et le centre de
//     chaque pièce, la plus courte (heuristique du moteur, inchangée) ;
//  4) résiduel non affecté le plus faible.
// Aucun score pondéré, aucun critère nouveau. Égalité → ordre reçu du
// moteur (tri stable).
export function compareBySurfaces(a: Layout, b: Layout): number {
  const scoreOf = (layout: Layout) => {
    const footprintArea = layout.footprint ? layout.footprint.w * layout.footprint.d : 0;
    const activeRooms = layout.rooms.filter((r) => !r.parked);
    let entryDistance = 0;
    if (layout.entryDoor && activeRooms.length > 0) {
      const ex = layout.entryDoor.cx;
      const ey = layout.entryDoor.cy;
      entryDistance = activeRooms.reduce((s, r) => s + Math.hypot(r.x + r.w / 2 - ex, r.y + r.d / 2 - ey), 0) / activeRooms.length;
    }
    return {
      circulation: layout.surfaces.circulation + layout.surfaces.cheminementExterieur,
      footprintArea,
      entryDistance,
      nonAffectee: layout.surfaces.nonAffectee,
    };
  };
  const sa = scoreOf(a);
  const sb = scoreOf(b);
  if (Math.abs(sa.circulation - sb.circulation) > EPS) return sa.circulation - sb.circulation;
  if (Math.abs(sa.footprintArea - sb.footprintArea) > EPS) return sa.footprintArea - sb.footprintArea;
  if (Math.abs(sa.entryDistance - sb.entryDistance) > EPS) return sa.entryDistance - sb.entryDistance;
  return sa.nonAffectee - sb.nonAffectee;
}

// Appliqué APRÈS réception de tous les résultats (y compris ceux que le
// moteur obtient dans le repère transposé pour un accès gauche/droite et
// ajoute en fin de liste), sur une copie des RÉFÉRENCES : result.variants
// n'est ni trié ni modifié. La disposition actuelle reste à part.
export function buildRegenerationView(base: Layout, result: RegenerationResult): RegenerationView {
  const current = metricsOf(base, base);
  const idx = result.variants.findIndex((v) => v.variantLabel === CURRENT_VARIANT_LABEL);
  const entries = result.variants
    .map((layout, engineIndex) => ({ layout, engineIndex }))
    .filter((e) => e.layout.variantLabel !== CURRENT_VARIANT_LABEL)
    .sort((a, b) => {
      const c = compareBySurfaces(a.layout, b.layout);
      return Math.abs(c) > 1e-12 ? c : a.engineIndex - b.engineIndex;
    });
  const proposals = entries.map((e, k) => {
    const metrics = metricsOf(e.layout, base);
    return {
      engineIndex: e.engineIndex,
      displayNumber: k + 1,
      metrics,
      note: result.preferenceNotes[e.engineIndex] ?? "",
      exteriorTradeoff: metrics.circulation < current.circulation - EPS && metrics.cheminementExterieur > current.cheminementExterieur + EPS,
    };
  });
  return { current, currentEngineIndex: idx >= 0 ? idx : null, proposals };
}

// Écart signé, arrondi pour l'affichage ; null quand il est négligeable.
export function deltaOf(a: number, b: number): number | null {
  const d = a - b;
  return Math.abs(d) > EPS ? d : null;
}
