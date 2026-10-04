// Classification de l'espace situé devant un mur de pièce (lot « façades
// extérieures », 2026-10-04, SUIVI_MOTEUR_PLANS_2D.md).
// BRANCHEMENT (lot suivant, même jour) : utilisé UNIQUEMENT par
// independentVerify, en COMPLÉMENT de la règle historique pour les fenêtres
// (une fenêtre est acceptée si la règle historique l'accepte OU si cette
// preuve la classe « exterieur » sur sa propre portion). Jamais par
// chooseExteriorWindow, la génération, la régénération (sauf via le
// vérificateur), les surfaces, les exports ou le format de projet.
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
//   3. propagation (4-voisinage) depuis le bord du terrain à travers un
//      passage libre de largeur paramétrée 0,60 m (ouverture morphologique,
//      voir buildExposureGrid ; EN PRATIQUE plus exigeant, voir ci-dessous) : atteintes = « extérieur » ; libres non
//      atteintes = « vide intérieur ». Un vide n'est JAMAIS extérieur par
//      défaut : il faut un chemin libre continu et assez large jusqu'à la
//      limite du terrain ;
//   4. pour une ouverture : contact direct (même sonde que wallAdjacency) →
//      « séparation » ; sinon sonde de profondeur exposureProbeDepth() sur la
//      largeur de l'ouverture, au-delà de l'épaisseur du mur ; toutes les
//      cellules doivent être de la même classe, sinon « non classé ».

import { MIN_WINDOW_WIDTH, WALL_EXT, WALL_INT, type Layout, type Rect, type WallSide } from "./geometry";

export const GRID_STEP = 0.05; // m — résolution de la preuve
// Les constantes de geometry.ts sont lues AU MOMENT DE L'APPEL, jamais au
// chargement du module : geometry.ts importe ce module (import circulaire),
// une lecture au niveau supérieur trouverait des valeurs non initialisées.
// Dégagement minimal exigé devant l'ouverture, au-delà du mur : la largeur
// minimale d'une fenêtre utilisable du moteur (MIN_WINDOW_WIDTH), fixée
// AVANT les cas de test — un retrait plus étroit n'est pas une façade.
export function exposureProbeDepth(): number {
  return MIN_WINDOW_WIDTH;
}
// Contact direct : même distance que wallAdjacency (ADJACENCY_TOLERANCE).
function contactDepth(): number {
  return WALL_EXT + WALL_INT + 0.02;
}
// Marge du tracé : une cellule qui TOUCHE (à cette marge près) un élément
// bâti épaissi est bâtie — règle prudente, jamais l'inverse. Ferme aussi les
// coins qui ne se touchent qu'en un point, quels que soient les arrondis.
const RASTER_EPS = 1e-6;

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

// Ordre des codes stockés dans ExposureGrid.cells.
export const CELL_CLASSES: readonly CellClass[] = ["vide_interieur", "bati", "cour", "exterieur"];
const VIDE = 0, BATI = 1, COUR = 2, EXT = 3;

export interface ExposureGrid {
  x0: number;
  y0: number;
  nx: number;
  ny: number;
  // Codes compacts (tableau d'octets) : voir CELL_CLASSES.
  cells: Uint8Array;
}

export function buildExposureGrid(layout: Layout): ExposureGrid {
  const t = layout.terrain;
  const nx = Math.round(t.w / GRID_STEP);
  const ny = Math.round(t.d / GRID_STEP);
  const cells = new Uint8Array(nx * ny); // 0 = vide_interieur
  // Tracé par PLAGES D'INDICES (une boucle par rectangle) au lieu d'un test
  // de chaque cellule contre chaque rectangle : même résultat prudent,
  // coût proportionnel à la surface tracée.
  const paint = (r: Rect, value: number, onlyIfFree: boolean) => {
    const i0 = Math.max(0, Math.floor((r.x - t.x - RASTER_EPS) / GRID_STEP));
    const i1 = Math.min(nx - 1, Math.floor((r.x + r.w - t.x + RASTER_EPS) / GRID_STEP));
    const j0 = Math.max(0, Math.floor((r.y - t.y - RASTER_EPS) / GRID_STEP));
    const j1 = Math.min(ny - 1, Math.floor((r.y + r.d - t.y + RASTER_EPS) / GRID_STEP));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * nx + i;
        if (!onlyIfFree || cells[k] === VIDE) cells[k] = value;
      }
    }
  };
  for (const b of builtElements(layout)) {
    paint({ x: b.rect.x - WALL_EXT, y: b.rect.y - WALL_EXT, w: b.rect.w + 2 * WALL_EXT, d: b.rect.d + 2 * WALL_EXT }, BATI, false);
  }
  // Cour : cellules encore libres qui la touchent (le bâti reste prioritaire).
  if (layout.courtyard) paint(layout.courtyard, COUR, true);
  // Propagation depuis le bord du terrain, avec une LARGEUR DE PASSAGE
  // minimale (ouverture morphologique, grille seulement) : paramètre
  // exposureProbeDepth() (0,60 m), jamais une fente d'une ou deux cellules.
  // Exigence EFFECTIVE, toutes prudentes, comptées une seule fois chacune :
  //   - murs : chaque élément est épaissi de WALL_EXT (0,20 m) en amont ;
  //   - arrondi : P = ceil(0,30 / 0,05) = 6 cellules de chaque côté, soit
  //     une course libre de 2P+1 = 13 cellules = 0,65 m ;
  //   - tracé prudent : une cellule qui touche un élément épaissi est bâtie,
  //     d'où jusqu'à une cellule perdue de chaque côté selon l'alignement.
  // RÉSULTAT DU SEUL CAS TESTÉ (test 4c : fente droite entre deux rectangles
  // parallèles, écart brut g ; libre après murs = g − 2 × WALL_EXT), mesuré
  // en faisant varier l'alignement sur la grille : toujours fermé si
  // g < 1,055 m, fermé OU ouvert selon l'alignement entre 1,055 et 1,105 m,
  // toujours ouvert dès 1,105 m. Ce n'est pas une règle générale : une
  // autre géométrie (passage oblique, coudé, bord de cour) peut donner un
  // autre seuil ; l'incertitude d'alignement reste de l'ordre d'une cellule.
  //   1. obstacles élargis de P cellules (carré, séparable) ;
  //   2. propagation en 4-voisinage sur les cellules restées libres (un
  //      passage uniquement diagonal est donc impossible) ;
  //   3. restitution : une cellule libre est « exterieur » si elle est à
  //      moins de P cellules (carré) d'une cellule atteinte.
  // La cour garde sa classe ; elle est traversable comme tout espace libre.
  const P = Math.max(1, Math.ceil(exposureProbeDepth() / 2 / GRID_STEP - 1e-9));
  const isBuilt = new Uint8Array(nx * ny);
  for (let k = 0; k < nx * ny; k++) isBuilt[k] = cells[k] === BATI ? 1 : 0;
  const dilate = (src: Uint8Array, r: number): Uint8Array => {
    const tmp = new Uint8Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      let last = -Infinity;
      for (let i = 0; i < nx; i++) if (src[j * nx + i]) last = i; else if (i - last <= r) tmp[j * nx + i] = 1;
      last = Infinity;
      for (let i = nx - 1; i >= 0; i--) { if (src[j * nx + i]) { last = i; tmp[j * nx + i] = 1; } else if (last - i <= r) tmp[j * nx + i] = 1; }
    }
    const res = new Uint8Array(nx * ny);
    for (let i = 0; i < nx; i++) {
      let last = -Infinity;
      for (let j = 0; j < ny; j++) if (tmp[j * nx + i]) last = j; else if (j - last <= r) res[j * nx + i] = 1;
      last = Infinity;
      for (let j = ny - 1; j >= 0; j--) { if (tmp[j * nx + i]) { last = j; res[j * nx + i] = 1; } else if (last - j <= r) res[j * nx + i] = 1; }
    }
    return res;
  };
  const blocked = dilate(isBuilt, P);
  const reached = new Uint8Array(nx * ny);
  const queue: number[] = [];
  const push = (i: number, j: number) => {
    const k = j * nx + i;
    if (reached[k] || blocked[k]) return;
    reached[k] = 1;
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
    if (i > 0) push(i - 1, j);
    if (i < nx - 1) push(i + 1, j);
    if (j > 0) push(i, j - 1);
    if (j < ny - 1) push(i, j + 1);
  }
  const nearReached = dilate(reached, P);
  for (let k = 0; k < nx * ny; k++) {
    if (cells[k] === VIDE && nearReached[k]) cells[k] = EXT;
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
  grid: ExposureGrid = exposureGridFor(layout)
): ExposureResult {
  const room = layout.rooms[roomIndex];
  if (!room || room.parked) return { kind: "non_classe", reason: "Pièce absente ou mise de côté.", evidence: {} };
  const rect: Rect = { x: room.x, y: room.y, w: room.w, d: room.d };
  const vertical = wall === "left" || wall === "right";
  const alongMin = span?.alongMin ?? (vertical ? rect.y : rect.x);
  const alongMax = span?.alongMax ?? (vertical ? rect.y + rect.d : rect.x + rect.w);

  // 1) Contact direct avec un autre élément bâti ou la cour (épaisseur d'une
  //    cloison) : séparation, jamais une façade.
  const contact = outward(rect, wall, 0, contactDepth(), alongMin, alongMax);
  const others = builtElements(layout).filter((b) => !(b.name === `« ${room.label} ${room.number} »`));
  const touching = others.find((b) => overlaps(contact, b.rect));
  if (touching) return { kind: "separation", reason: `Mur mitoyen de ${touching.name} (à moins d'une épaisseur de cloison).`, evidence: {} };
  if (layout.courtyard && overlaps(contact, layout.courtyard)) {
    return { kind: "cour", reason: "Mur directement en contact avec la cour identifiée.", evidence: { cour: 1 } };
  }

  // 2) Sonde au-delà de l'épaisseur du mur extérieur (+ une cellule, pour
  //    ne jamais lire la bordure de l'épaississement de la pièce elle-même).
  const probe = outward(rect, wall, WALL_EXT + GRID_STEP, exposureProbeDepth(), alongMin, alongMax);
  const evidence: Partial<Record<CellClass | "hors_terrain", number>> = {};
  const t = layout.terrain;
  for (let y = probe.y + GRID_STEP / 2; y < probe.y + probe.d; y += GRID_STEP) {
    for (let x = probe.x + GRID_STEP / 2; x < probe.x + probe.w; x += GRID_STEP) {
      const i = Math.floor((x - grid.x0) / GRID_STEP);
      const j = Math.floor((y - grid.y0) / GRID_STEP);
      const key: CellClass | "hors_terrain" = x < t.x || y < t.y || x > t.x + t.w || y > t.y + t.d || i < 0 || j < 0 || i >= grid.nx || j >= grid.ny ? "hors_terrain" : CELL_CLASSES[grid.cells[j * grid.nx + i]];
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
    return { kind: "obstruee", reason: `Dégagement obstrué par ${hit ? hit.name : "un élément bâti"} à moins de ${(WALL_EXT + exposureProbeDepth()).toFixed(2).replace(".", ",")} m.`, evidence };
  }
  return { kind: "non_classe", reason: "Dégagement mixte (classes différentes) : exposition non démontrée.", evidence };
}

// Une grille par ÉTAT GÉOMÉTRIQUE : les dispositions sont immuables dans le
// moteur (chaque modification produit une nouvelle Layout via cloneLayout),
// la grille d'un même objet est donc réutilisée pour toutes ses fenêtres et
// tous les appels du vérificateur sur cet état, jamais recalculée.
const gridCache = new WeakMap<Layout, ExposureGrid>();
export function exposureGridFor(layout: Layout): ExposureGrid {
  let grid = gridCache.get(layout);
  if (!grid) {
    grid = buildExposureGrid(layout);
    gridCache.set(layout, grid);
  }
  return grid;
}

// Une fenêtre est PROUVÉE donner sur l'extérieur si sa propre portion de mur
// est classée « exterieur ». « cour », « non_classe », « vide_interieur »,
// « obstruee » et « separation » ne sont jamais une preuve d'exposition.
export function windowProvenExterior(layout: Layout, w: { roomIndex: number; wall: WallSide; cx: number; cy: number; width: number }): boolean {
  const room = layout.rooms[w.roomIndex];
  if (!room || room.parked) return false;
  const vertical = w.wall === "left" || w.wall === "right";
  // La baie doit reposer RÉELLEMENT sur la ligne de ce mur et tenir dans sa
  // longueur (coordonnées, jamais le seul nom du mur).
  const line = w.wall === "left" ? room.x : w.wall === "right" ? room.x + room.w : w.wall === "top" ? room.y : room.y + room.d;
  const fixed = vertical ? w.cx : w.cy;
  const c = vertical ? w.cy : w.cx;
  const lo = vertical ? room.y : room.x;
  const hi = vertical ? room.y + room.d : room.x + room.w;
  if (Math.abs(fixed - line) > 1e-6 || c - w.width / 2 < lo - 1e-6 || c + w.width / 2 > hi + 1e-6 || w.width <= 0) return false;
  return classifyWallExposure(layout, w.roomIndex, w.wall, { alongMin: c - w.width / 2, alongMax: c + w.width / 2 }, exposureGridFor(layout)).kind === "exterieur";
}
