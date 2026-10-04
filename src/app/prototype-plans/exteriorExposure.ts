// PREUVE ISOLÉE — classification de l'espace situé devant un mur de pièce
// (lot « façades extérieures », 2026-10-04, SUIVI_MOTEUR_PLANS_2D.md).
// N'EST BRANCHÉ NULLE PART : ni independentVerify, ni chooseExteriorWindow,
// ni la génération, la régénération, les surfaces ou les exports. Aucun
// projet n'est relu ni modifié par ce module.
//
// Pourquoi : la règle actuelle (wallTouchesExterior) ne reconnaît une façade
// que si le mur touche le RECTANGLE ENGLOBANT du bâti. Une façade réellement
// exposée mais en retrait (encoche, bâtiment en L) est donc refusée.
//
// Ce que le modèle permet de déduire SÛREMENT, et seulement cela :
//   - la masse bâtie = pièces posées + corridor + raccords + circulations
//     (exactement les rectangles de recomputeDerivedGeometry) ;
//   - les murs sont IMPLICITES : épaisseur WALL_EXT autour de la masse,
//     interstice WALL_INT entre deux éléments voisins ;
//   - hors de l'emprise mais dans le terrain (reculs) : non bâti, par
//     définition de l'emprise ;
//   - la cour, quand elle existe, est un rectangle explicitement identifié.
// Ce qu'il NE permet PAS de déduire : ce qui se trouve au-delà de la limite
// du terrain (voisins) ; la couverture éventuelle d'un vide (auvent, toiture) ;
// la hauteur ; les trajets extérieurs (exteriorPaths) sont une CONVENTION
// d'accès, traités ici comme non bâtis sans être une preuve d'air libre.
//
// Méthode, sans aucune tolérance ajustée pour un exemple :
//   1. grille de pas GRID_STEP sur le terrain ; une cellule est « bâtie » si
//      elle CHEVAUCHE un élément bâti épaissi de WALL_EXT (règle prudente :
//      au moindre recouvrement, la cellule est bâtie) — ferme aussi les
//      interstices de murs intérieurs (WALL_INT < 2 × WALL_EXT) ;
//   2. cellule de la cour : « cour » (si non bâtie) ;
//   3. propagation (4-voisinage) depuis les cellules libres du bord du
//      terrain : atteintes = « extérieur » ; libres non atteintes = « vide
//      intérieur ». Un vide n'est JAMAIS extérieur par défaut : il faut un
//      chemin libre continu jusqu'à la limite du terrain ;
//   4. pour une ouverture : contact direct (même sonde que wallAdjacency) →
//      « séparation » ; sinon sonde de profondeur EXPOSURE_PROBE_DEPTH sur la
//      largeur de l'ouverture, au-delà de l'épaisseur du mur ; toutes les
//      cellules doivent être de la même classe, sinon « non classé ».

import { MIN_WINDOW_WIDTH, WALL_EXT, WALL_INT, type Layout, type Rect, type WallSide } from "./geometry";

export const GRID_STEP = 0.05; // m — résolution de la preuve
// Dégagement minimal exigé devant l'ouverture, au-delà du mur : la largeur
// minimale d'une fenêtre utilisable du moteur (MIN_WINDOW_WIDTH), fixée
// AVANT les cas de test — un retrait plus étroit n'est pas une façade.
export const EXPOSURE_PROBE_DEPTH = MIN_WINDOW_WIDTH;
// Contact direct : même distance que wallAdjacency (ADJACENCY_TOLERANCE).
const CONTACT_DEPTH = WALL_EXT + WALL_INT + 0.02;

export type CellClass = "bati" | "exterieur" | "cour" | "vide_interieur";
export type ExposureKind = "exterieur" | "cour" | "separation" | "obstruee" | "vide_interieur" | "non_classe";

export interface ExposureResult {
  kind: ExposureKind;
  reason: string;
  // Comptes de cellules de la sonde, pour que la décision soit vérifiable.
  evidence: Partial<Record<CellClass | "hors_terrain", number>>;
}

interface Named {
  rect: Rect;
  name: string;
}

function builtElements(layout: Layout): Named[] {
  const out: Named[] = [];
  if (layout.corridor) out.push({ rect: layout.corridor, name: "la circulation" });
  for (const r of layout.corridorFillers) out.push({ rect: r, name: "la circulation" });
  for (const r of layout.circulations) out.push({ rect: r, name: "la circulation" });
  layout.rooms.forEach((r) => {
    if (!r.parked) out.push({ rect: { x: r.x, y: r.y, w: r.w, d: r.d }, name: `« ${r.label} ${r.number} »` });
  });
  return out;
}

function overlaps(a: Rect, b: Rect, eps = 1e-9): boolean {
  return a.x < b.x + b.w - eps && b.x < a.x + a.w - eps && a.y < b.y + b.d - eps && b.y < a.y + a.d - eps;
}

export interface ExposureGrid {
  x0: number;
  y0: number;
  nx: number;
  ny: number;
  cells: CellClass[];
}

export function buildExposureGrid(layout: Layout): ExposureGrid {
  const t = layout.terrain;
  const nx = Math.round(t.w / GRID_STEP);
  const ny = Math.round(t.d / GRID_STEP);
  const cells: CellClass[] = new Array(nx * ny).fill("vide_interieur");
  const built = builtElements(layout).map((b) => ({
    x: b.rect.x - WALL_EXT,
    y: b.rect.y - WALL_EXT,
    w: b.rect.w + 2 * WALL_EXT,
    d: b.rect.d + 2 * WALL_EXT,
  }));
  const cellRect = (i: number, j: number): Rect => ({ x: t.x + i * GRID_STEP, y: t.y + j * GRID_STEP, w: GRID_STEP, d: GRID_STEP });
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = cellRect(i, j);
      if (built.some((b) => overlaps(c, b))) cells[j * nx + i] = "bati";
      else if (layout.courtyard && overlaps(c, layout.courtyard)) cells[j * nx + i] = "cour";
    }
  }
  // Propagation depuis le bord du terrain à travers les cellules libres
  // (la cour se propage aussi mais garde sa classe « cour »).
  const queue: number[] = [];
  const seen = new Uint8Array(nx * ny);
  const push = (i: number, j: number) => {
    const k = j * nx + i;
    if (seen[k] || cells[k] === "bati") return;
    seen[k] = 1;
    queue.push(k);
  };
  for (let i = 0; i < nx; i++) {
    push(i, 0);
    push(i, ny - 1);
  }
  for (let j = 0; j < ny; j++) {
    push(0, j);
    push(nx - 1, j);
  }
  while (queue.length) {
    const k = queue.pop()!;
    const i = k % nx;
    const j = (k - i) / nx;
    if (cells[k] === "vide_interieur") cells[k] = "exterieur";
    if (i > 0) push(i - 1, j);
    if (i < nx - 1) push(i + 1, j);
    if (j > 0) push(i, j - 1);
    if (j < ny - 1) push(i, j + 1);
  }
  return { x0: t.x, y0: t.y, nx, ny, cells };
}

function outward(rect: Rect, wall: WallSide, from: number, depth: number, alongMin: number, alongMax: number): Rect {
  switch (wall) {
    case "left":
      return { x: rect.x - from - depth, y: alongMin, w: depth, d: alongMax - alongMin };
    case "right":
      return { x: rect.x + rect.w + from, y: alongMin, w: depth, d: alongMax - alongMin };
    case "top":
      return { x: alongMin, y: rect.y - from - depth, w: alongMax - alongMin, d: depth };
    case "bottom":
      return { x: alongMin, y: rect.y + rect.d + from, w: alongMax - alongMin, d: depth };
  }
}

// Classe l'espace devant une portion [alongMin, alongMax] du mur `wall` de la
// pièce (par défaut : tout le mur). `grid` peut être fourni pour éviter de
// recalculer la grille pour chaque ouverture d'une même disposition.
export function classifyWallExposure(
  layout: Layout,
  roomIndex: number,
  wall: WallSide,
  span?: { alongMin: number; alongMax: number },
  grid: ExposureGrid = buildExposureGrid(layout)
): ExposureResult {
  const room = layout.rooms[roomIndex];
  if (!room || room.parked) return { kind: "non_classe", reason: "Pièce absente ou mise de côté.", evidence: {} };
  const rect: Rect = { x: room.x, y: room.y, w: room.w, d: room.d };
  const vertical = wall === "left" || wall === "right";
  const alongMin = span?.alongMin ?? (vertical ? rect.y : rect.x);
  const alongMax = span?.alongMax ?? (vertical ? rect.y + rect.d : rect.x + rect.w);

  // 1) Contact direct avec un autre élément bâti ou la cour (épaisseur d'une
  //    cloison) : séparation, jamais une façade.
  const contact = outward(rect, wall, 0, CONTACT_DEPTH, alongMin, alongMax);
  const others = builtElements(layout).filter((b) => !(b.name === `« ${room.label} ${room.number} »`));
  const touching = others.find((b) => overlaps(contact, b.rect));
  if (touching) return { kind: "separation", reason: `Mur mitoyen de ${touching.name} (à moins d'une épaisseur de cloison).`, evidence: {} };
  if (layout.courtyard && overlaps(contact, layout.courtyard)) {
    return { kind: "cour", reason: "Mur directement en contact avec la cour identifiée.", evidence: { cour: 1 } };
  }

  // 2) Sonde au-delà de l'épaisseur du mur extérieur (+ une cellule, pour
  //    ne jamais lire la bordure de l'épaississement de la pièce elle-même).
  const probe = outward(rect, wall, WALL_EXT + GRID_STEP, EXPOSURE_PROBE_DEPTH, alongMin, alongMax);
  const evidence: Partial<Record<CellClass | "hors_terrain", number>> = {};
  const t = layout.terrain;
  for (let y = probe.y + GRID_STEP / 2; y < probe.y + probe.d; y += GRID_STEP) {
    for (let x = probe.x + GRID_STEP / 2; x < probe.x + probe.w; x += GRID_STEP) {
      const i = Math.floor((x - grid.x0) / GRID_STEP);
      const j = Math.floor((y - grid.y0) / GRID_STEP);
      const key: CellClass | "hors_terrain" = x < t.x || y < t.y || x > t.x + t.w || y > t.y + t.d || i < 0 || j < 0 || i >= grid.nx || j >= grid.ny ? "hors_terrain" : grid.cells[j * grid.nx + i];
      evidence[key] = (evidence[key] ?? 0) + 1;
    }
  }
  const total = Object.values(evidence).reduce((s, n) => s + (n ?? 0), 0);
  const only = (k: CellClass | "hors_terrain") => (evidence[k] ?? 0) === total && total > 0;
  if (only("exterieur")) return { kind: "exterieur", reason: "Dégagement libre devant l'ouverture, relié sans interruption à la limite du terrain.", evidence };
  if (only("cour")) return { kind: "cour", reason: "Dégagement entièrement situé dans la cour identifiée.", evidence };
  if (only("vide_interieur")) return { kind: "vide_interieur", reason: "Vide libre mais enclos : aucun chemin libre jusqu'à la limite du terrain.", evidence };
  if ((evidence.hors_terrain ?? 0) > 0) return { kind: "non_classe", reason: "Le dégagement sort du terrain : ce qui se trouve au-delà n'est pas représenté.", evidence };
  if ((evidence.bati ?? 0) > 0) {
    const hit = others.find((b) => overlaps(probe, { x: b.rect.x - WALL_EXT, y: b.rect.y - WALL_EXT, w: b.rect.w + 2 * WALL_EXT, d: b.rect.d + 2 * WALL_EXT }));
    return { kind: "obstruee", reason: `Dégagement obstrué par ${hit ? hit.name : "un élément bâti"} à moins de ${(WALL_EXT + EXPOSURE_PROBE_DEPTH).toFixed(2)} m.`, evidence };
  }
  return { kind: "non_classe", reason: "Dégagement mixte (classes différentes) : exposition non démontrée.", evidence };
}

// Rappel exporté pour la documentation des cas (aucun usage métier).
export const EXPOSURE_ASSUMPTIONS = { GRID_STEP, EXPOSURE_PROBE_DEPTH, WALL_EXT, WALL_INT };
