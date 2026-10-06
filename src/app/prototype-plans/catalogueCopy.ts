// Catalogue modifiable — préparation d'une COPIE d'un modèle vers un chantier
// (PREPARATION_CATALOGUE_MODIFIABLE.md, Lot B, premier sous-lot sans
// migration). Fonctions pures, partagées par les actions serveur et les
// tests.
//
// Règles :
// - le fichier du modèle n'est jamais modifié : la copie est construite sur
//   un clone profond ;
// - aucune autorisation F2 n'est héritée (retirées de la copie, comptées) ;
// - aucun redimensionnement ni déplacement automatique : les pièces gardent
//   exactement leurs positions et dimensions ;
// - la copie est posée sur le terrain et l'emprise du CHANTIER DESTINATAIRE
//   (paramètres saisis ou confirmés par l'utilisateur) ; les paramètres du
//   modèle restent une référence distincte, en lecture seule ;
// - une incompatibilité est expliquée. Celles que l'éditeur ne contrôle pas
//   au dépôt (façade d'accès, programme, dimensions minimales, éléments non
//   déplaçables hors emprise) bloquent la copie ; celles que l'éditeur
//   contrôle (pièce hors emprise, anomalies géométriques) sont listées « à
//   adapter » et empêcheront le dépôt tant qu'elles ne sont pas corrigées ;
// - le résultat n'est jamais un verdict d'admissibilité.

import { DEFAULT_PRESETS, independentVerify, recomputeDerivedGeometry } from "./geometry";
import type { AccessSide, Layout, Rect, RoomNeed, Setbacks } from "./geometry";
import { serializeProject, validateProjectFile, type ProjectFile } from "./projectFile";

const EPS = 1e-6;
const ACCESS_SIDES: AccessSide[] = ["front", "back", "left", "right"];
const ORIENTATIONS = ["N", "S", "E", "O"] as const;
export const ACCESS_LABELS: Record<AccessSide, string> = { front: "avant", back: "arrière", left: "gauche", right: "droite" };

// Paramètres du chantier destinataire — enregistrés tels quels comme
// generation_params de la demande créée, jamais déduits du modèle.
export interface DestinationParams {
  terrainWidth: number;
  terrainDepth: number;
  setbacks: Setbacks;
  accessSide: AccessSide;
  orientation: (typeof ORIENTATIONS)[number];
  needs: RoomNeed[];
}

export interface ModelReference {
  terrainWidth: number;
  terrainDepth: number;
  setbacks: Setbacks | null;
  accessSide: AccessSide;
  orientation: string;
  program: { type: string; label: string; count: number; rooms: { name: string; w: number; d: number }[] }[];
  parkedRooms: number;
  hasCourtyard: boolean;
}

const fmt = (n: number) => n.toFixed(2).replace(".", ",");

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

// Lecture stricte des paramètres saisis (côté serveur : jamais supposés
// valides parce que le formulaire les a produits).
export function parseDestinationParams(raw: unknown): { ok: true; value: DestinationParams } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Paramètres du chantier absents." };
  const p = raw as Record<string, unknown>;
  if (!isFiniteNumber(p.terrainWidth) || !isFiniteNumber(p.terrainDepth) || p.terrainWidth <= 0 || p.terrainDepth <= 0 || p.terrainWidth > 1000 || p.terrainDepth > 1000) {
    return { ok: false, error: "Dimensions du terrain invalides." };
  }
  const s = p.setbacks as Record<string, unknown> | undefined;
  if (!s || !["front", "back", "left", "right"].every((k) => isFiniteNumber(s[k]) && (s[k] as number) >= 0)) {
    return { ok: false, error: "Reculs invalides (quatre valeurs positives ou nulles attendues)." };
  }
  const setbacks: Setbacks = { front: s.front as number, back: s.back as number, left: s.left as number, right: s.right as number };
  if (p.terrainWidth - setbacks.left - setbacks.right <= 0 || p.terrainDepth - setbacks.front - setbacks.back <= 0) {
    return { ok: false, error: "Les reculs ne laissent aucune emprise constructible sur ce terrain." };
  }
  if (!ACCESS_SIDES.includes(p.accessSide as AccessSide)) return { ok: false, error: "Façade d'accès invalide." };
  if (!ORIENTATIONS.includes(p.orientation as (typeof ORIENTATIONS)[number])) return { ok: false, error: "Orientation invalide." };
  if (!Array.isArray(p.needs)) return { ok: false, error: "Programme absent." };
  const needs: RoomNeed[] = [];
  const seen = new Set<string>();
  for (const n of p.needs as Record<string, unknown>[]) {
    const preset = n && typeof n.type === "string" ? DEFAULT_PRESETS[n.type] : undefined;
    if (!preset || seen.has(preset.type)) return { ok: false, error: "Programme invalide (type de pièce inconnu ou en double)." };
    seen.add(preset.type);
    if (!Number.isInteger(n.count) || (n.count as number) < 0 || (n.count as number) > 50) return { ok: false, error: `Nombre de pièces invalide pour « ${preset.label} ».` };
    if (!isFiniteNumber(n.minWidth) || !isFiniteNumber(n.minDepth) || n.minWidth <= 0 || n.minDepth <= 0) {
      return { ok: false, error: `Dimensions minimales invalides pour « ${preset.label} ».` };
    }
    needs.push({
      type: preset.type,
      label: preset.label,
      count: n.count as number,
      minWidth: n.minWidth as number,
      minDepth: n.minDepth as number,
      targetWidth: isFiniteNumber(n.targetWidth) ? n.targetWidth : preset.targetWidth,
      targetDepth: isFiniteNumber(n.targetDepth) ? n.targetDepth : preset.targetDepth,
    });
  }
  if (!needs.some((n) => n.count > 0)) return { ok: false, error: "Le programme du chantier ne contient aucune pièce." };
  return {
    ok: true,
    value: {
      terrainWidth: p.terrainWidth,
      terrainDepth: p.terrainDepth,
      setbacks,
      accessSide: p.accessSide as AccessSide,
      orientation: p.orientation as DestinationParams["orientation"],
      needs,
    },
  };
}

// Paramètres d'origine du modèle, déduits de SON fichier — affichés comme
// référence, jamais recopiés dans les paramètres du chantier.
export function modelReference(file: ProjectFile): ModelReference {
  const L = file.layout;
  const e = L.emprise;
  const setbacks = e ? { front: e.y, left: e.x, right: L.terrain.w - e.x - e.w, back: L.terrain.d - e.y - e.d } : null;
  const byType = new Map<string, ModelReference["program"][number]>();
  for (const r of L.rooms) {
    if (r.parked) continue;
    const entry = byType.get(r.type) ?? { type: r.type, label: DEFAULT_PRESETS[r.type]?.label ?? r.label, count: 0, rooms: [] };
    entry.count += 1;
    entry.rooms.push({ name: `${r.label} ${r.number}`, w: r.w, d: r.d });
    byType.set(r.type, entry);
  }
  return {
    terrainWidth: L.terrain.w,
    terrainDepth: L.terrain.d,
    setbacks,
    accessSide: L.accessSide,
    orientation: file.orientation,
    program: [...byType.values()],
    parkedRooms: L.rooms.filter((r) => r.parked).length,
    hasCourtyard: !!L.courtyard,
  };
}

export function destinationEmprise(dest: DestinationParams): Rect {
  // Même convention que le générateur (generateVariants) : reculs nommés par
  // bord du terrain, quelle que soit la façade d'accès.
  return {
    x: dest.setbacks.left,
    y: dest.setbacks.front,
    w: dest.terrainWidth - dest.setbacks.left - dest.setbacks.right,
    d: dest.terrainDepth - dest.setbacks.front - dest.setbacks.back,
  };
}

function within(inner: Rect, outer: Rect): boolean {
  return inner.x >= outer.x - EPS && inner.y >= outer.y - EPS && inner.x + inner.w <= outer.x + outer.w + EPS && inner.y + inner.d <= outer.y + outer.d + EPS;
}

export interface CatalogueCopyReport {
  // Bloquant : la copie n'est pas créée (l'éditeur ne saurait pas le
  // contrôler au dépôt, ou ce lot ne le prend pas en charge).
  blocking: string[];
  // À adapter dans l'éditeur : contrôlé par l'éditeur, dépôt refusé tant
  // que ce n'est pas corrigé.
  toAdapt: string[];
  // Avertissements géométriques (non bloquants pour le dépôt).
  warnings: string[];
  // Informations : ce qui a été repris ou retiré, et ce qui ne l'a pas été.
  notes: string[];
  removedAllowances: number;
}

export function prepareCatalogueCopy(
  modelFile: ProjectFile,
  dest: DestinationParams,
  options: { modelLabel: string; savedAt?: string }
): { report: CatalogueCopyReport; copy: ProjectFile | null } {
  const report: CatalogueCopyReport = { blocking: [], toAdapt: [], warnings: [], notes: [], removedAllowances: 0 };
  const source = modelFile.layout;

  if (!source.feasible || !source.emprise || !source.footprint) {
    report.blocking.push("Le modèle ne contient pas de disposition vérifiable (emprise ou contour bâti absent) : il ne peut pas servir de point de départ.");
    return { report, copy: null };
  }
  if (source.courtyard) {
    report.blocking.push("Modèle avec cour d'entrée : sa copie n'est pas prise en charge dans ce premier lot (l'emprise et la cour ne peuvent pas être reportées sans ambiguïté sur un autre terrain).");
  }
  if (source.accessSide !== dest.accessSide) {
    report.blocking.push(
      `Façade d'accès différente : modèle conçu pour un accès ${ACCESS_LABELS[source.accessSide]}, chantier avec un accès ${ACCESS_LABELS[dest.accessSide]}. La copie n'est jamais réorientée automatiquement.`
    );
  }

  // Programme : même nombre de pièces par type, dimensions minimales du
  // chantier respectées — jamais un redimensionnement pour y parvenir.
  const active = source.rooms.filter((r) => !r.parked);
  const types = new Set([...active.map((r) => r.type), ...dest.needs.filter((n) => n.count > 0).map((n) => n.type)]);
  for (const t of types) {
    const need = dest.needs.find((n) => n.type === t);
    const wanted = need?.count ?? 0;
    const rooms = active.filter((r) => r.type === t);
    const label = need?.label ?? DEFAULT_PRESETS[t]?.label ?? t;
    if (rooms.length !== wanted) {
      report.blocking.push(`Programme différent : « ${label} » — ${rooms.length} dans le modèle, ${wanted} demandée(s) pour le chantier.`);
      continue;
    }
    if (!need) continue;
    for (const r of rooms) {
      if (r.w < need.minWidth - EPS || r.d < need.minDepth - EPS) {
        report.blocking.push(
          `« ${r.label} ${r.number} » mesure ${fmt(r.w)} × ${fmt(r.d)} m, sous le minimum du chantier (${fmt(need.minWidth)} × ${fmt(need.minDepth)} m). Aucun redimensionnement automatique.`
        );
      }
    }
  }
  if (source.rooms.some((r) => r.parked)) {
    report.toAdapt.push(`${source.rooms.filter((r) => r.parked).length} pièce(s) du modèle sont mises de côté : à replacer avant tout dépôt.`);
  }

  // Copie : clone profond, autorisations F2 retirées, terrain et emprise du
  // chantier. Positions et dimensions des pièces inchangées.
  const clone = JSON.parse(JSON.stringify(source)) as Layout;
  if (clone.dimensionAllowances && clone.dimensionAllowances.length > 0) {
    report.removedAllowances = clone.dimensionAllowances.length;
    report.notes.push(`${report.removedAllowances} autorisation(s) d'adaptation des dimensions du modèle non reprise(s) : elles ne sont jamais héritées.`);
  }
  delete clone.dimensionAllowances;
  const emprise = destinationEmprise(dest);
  clone.terrain = { x: 0, y: 0, w: dest.terrainWidth, d: dest.terrainDepth };
  clone.emprise = emprise;
  clone.variantLabel = `Copie du modèle « ${options.modelLabel} »`;
  const placed = recomputeDerivedGeometry(clone);

  // Éléments que l'éditeur ne déplace pas : doivent déjà tenir sur le
  // terrain du chantier (le dépôt ne les contrôle pas).
  const fixed: { name: string; rect: Rect | null; area: Rect }[] = [
    { name: "Le couloir", rect: placed.corridor, area: emprise },
    ...placed.corridorFillers.map((r) => ({ name: "Un raccord de couloir", rect: r, area: emprise })),
    ...placed.circulations.map((r) => ({ name: "Une circulation", rect: r, area: emprise })),
    ...(placed.exteriorPaths ?? []).map((r) => ({ name: "Un cheminement extérieur", rect: r, area: placed.terrain })),
  ];
  for (const f of fixed) {
    if (f.rect && !within(f.rect, f.area)) {
      report.blocking.push(
        `${f.name} du modèle sort ${f.area === emprise ? "de l'emprise constructible" : "du terrain"} du chantier : cet élément ne peut pas être déplacé dans l'éditeur.`
      );
    }
  }
  if (placed.footprint && !within(placed.footprint, emprise)) {
    report.notes.push(
      `Le bâti du modèle (${fmt(placed.footprint.w)} × ${fmt(placed.footprint.d)} m) ne tient pas entièrement dans l'emprise du chantier (${fmt(emprise.w)} × ${fmt(emprise.d)} m).`
    );
  }
  if (modelFile.orientation !== dest.orientation) {
    report.notes.push(`Orientation du chantier (${dest.orientation}) reprise à la place de celle du modèle (${modelFile.orientation}).`);
  }
  report.notes.push("Les dimensions et positions des pièces du modèle sont conservées telles quelles.");

  // savedAt fourni : même fichier à chaque reprise de la même opération
  // (attestation idempotente, M034), jamais une date déduite du modèle.
  const file = serializeProject(placed, dest.orientation);
  if (options.savedAt) file.savedAt = options.savedAt;
  const revalidated = validateProjectFile(JSON.parse(JSON.stringify(file)));
  if (!revalidated.ok) {
    report.blocking.push(`La copie n'est pas un fichier de projet valide sur ce terrain : ${revalidated.error}`);
  } else if (revalidated.notices.length > 0 || revalidated.value.version !== 4) {
    report.blocking.push("La copie contient encore des données propres au modèle qui ne peuvent pas être reprises.");
  }

  for (const issue of independentVerify(placed)) {
    (issue.severity === "error" ? report.toAdapt : report.warnings).push(issue.message);
  }

  return { report, copy: report.blocking.length === 0 ? file : null };
}
