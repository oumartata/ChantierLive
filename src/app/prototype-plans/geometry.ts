// Moteur géométrique du prototype T0 — isolé, aucune dépendance nouvelle,
// aucune persistance. Toutes les valeurs sont des HYPOTHÈSES DE CONCEPTION
// modifiables, jamais des normes locales certifiées (aucune réglementation
// n'est connue ni supposée ici).

export interface RoomNeed {
  type: string;
  label: string;
  count: number;
  minWidth: number;
  minDepth: number;
  targetWidth: number;
  targetDepth: number;
}

// Préréglages par défaut — modifiables dans l'UI, jamais figés en dur pour
// l'utilisateur final. Valeurs indicatives (m), pas une norme.
export const DEFAULT_PRESETS: Record<string, Omit<RoomNeed, "count">> = {
  chambre: { type: "chambre", label: "Chambre", minWidth: 3.0, minDepth: 3.0, targetWidth: 3.5, targetDepth: 3.5 },
  salon: { type: "salon", label: "Salon", minWidth: 4.0, minDepth: 4.0, targetWidth: 5.0, targetDepth: 4.5 },
  cuisine: { type: "cuisine", label: "Cuisine", minWidth: 2.5, minDepth: 2.5, targetWidth: 3.0, targetDepth: 3.0 },
  sanitaire: { type: "sanitaire", label: "Sanitaire", minWidth: 1.5, minDepth: 1.8, targetWidth: 1.8, targetDepth: 2.0 },
  garage: { type: "garage", label: "Garage", minWidth: 3.0, minDepth: 5.0, targetWidth: 3.5, targetDepth: 5.5 },
};

export const WALL_EXT = 0.2; // épaisseur mur extérieur (m), hypothèse fixe en T0
export const WALL_INT = 0.1; // épaisseur mur intérieur (m), hypothèse fixe en T0
export const CORRIDOR_DEPTH = 1.2; // bande de circulation (m), hypothèse
export const DOOR_WIDTH = 0.9; // largeur mini d'une porte (m)

export interface Setbacks {
  front: number;
  back: number;
  left: number;
  right: number;
}

export type AccessSide = "front" | "back" | "left" | "right";

export interface GenerationInput {
  terrainWidth: number;
  terrainDepth: number;
  setbacks: Setbacks;
  accessSide: AccessSide;
  orientation: "N" | "S" | "E" | "O";
  needs: RoomNeed[];
}

export interface PlacedRoom {
  type: string;
  label: string;
  x: number;
  y: number;
  w: number;
  d: number;
  hasExteriorWall: boolean;
  doorOk: boolean;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  d: number;
}

export interface ExteriorSpace {
  label: string;
  rect: Rect;
  accessFrom: string;
}

export interface Layout {
  variantLabel: string;
  feasible: boolean;
  failureReasons: string[];
  terrain: Rect;
  emprise: Rect | null;
  footprint: Rect | null;
  // Une bande de circulation PAR rangée de pièces (jamais fusionnées en une
  // seule bande de profondeur multipliée : ça chevaucherait la rangée
  // intermédiaire — corrigé après détection par la vérification indépendante).
  corridors: Rect[];
  rooms: PlacedRoom[];
  exteriorSpaces: ExteriorSpace[];
  surfaces: {
    terrain: number;
    emprise: number;
    batie: number;
    utileHabitable: number;
    circulation: number;
    exterieure: number;
  };
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.d && a.y + a.d > b.y;
}

function rectWithin(inner: Rect, outer: Rect, eps = 1e-6): boolean {
  return (
    inner.x >= outer.x - eps &&
    inner.y >= outer.y - eps &&
    inner.x + inner.w <= outer.x + outer.w + eps &&
    inner.y + inner.d <= outer.y + outer.d + eps
  );
}

// Expand needs (count>1) into individual room instances, in a given order.
function expandNeeds(needs: RoomNeed[], order: string[]): RoomNeed[] {
  const byType = new Map(needs.map((n) => [n.type, n]));
  const out: RoomNeed[] = [];
  for (const type of order) {
    const n = byType.get(type);
    if (!n) continue;
    for (let i = 0; i < n.count; i++) out.push(n);
  }
  // Any type not in `order` (shouldn't happen) appended at the end.
  for (const n of needs) if (!order.includes(n.type)) for (let i = 0; i < n.count; i++) out.push(n);
  return out;
}

// Une variante = un ordre de pièces + un nombre de rangées (1 ou 2) + une
// orientation de la bande de circulation. Construction "en rangée(s)" :
// simple, mais garantit PAR CONSTRUCTION l'absence de chevauchement et une
// façade extérieure par pièce (vérifié indépendamment ensuite, jamais
// supposé acquis).
function buildRowLayout(
  input: GenerationInput,
  order: string[],
  rows: 1 | 2,
  label: string
): Layout {
  const terrain: Rect = { x: 0, y: 0, w: input.terrainWidth, d: input.terrainDepth };
  const empriseW = input.terrainWidth - input.setbacks.left - input.setbacks.right;
  const empriseD = input.terrainDepth - input.setbacks.front - input.setbacks.back;
  const failure = (reasons: string[]): Layout => ({
    variantLabel: label,
    feasible: false,
    failureReasons: reasons,
    terrain,
    emprise: null,
    footprint: null,
    corridors: [],
    rooms: [],
    exteriorSpaces: [],
    surfaces: { terrain: input.terrainWidth * input.terrainDepth, emprise: 0, batie: 0, utileHabitable: 0, circulation: 0, exterieure: 0 },
  });

  if (empriseW <= 0 || empriseD <= 0) {
    return failure(["Les reculs ne laissent aucune emprise constructible (largeur ou profondeur disponible ≤ 0)."]);
  }
  const emprise: Rect = { x: input.setbacks.left, y: input.setbacks.front, w: empriseW, d: empriseD };

  const roomList = expandNeeds(input.needs, order);
  if (roomList.length === 0) return failure(["Aucun besoin renseigné."]);

  const perRow: RoomNeed[][] = rows === 1 ? [roomList] : [roomList.slice(0, Math.ceil(roomList.length / 2)), roomList.slice(Math.ceil(roomList.length / 2))];

  const availableDepthForRooms = empriseD - CORRIDOR_DEPTH * rows - WALL_EXT * 2;
  if (availableDepthForRooms <= 0) {
    return failure(["La profondeur disponible ne laisse aucune place après circulation et murs extérieurs."]);
  }
  const depthPerRow = rows === 1 ? availableDepthForRooms : availableDepthForRooms / 2;

  const maxMinDepth = Math.max(...roomList.map((r) => r.minDepth));
  if (depthPerRow < maxMinDepth) {
    return failure([
      `Le terrain est trop ÉTROIT en profondeur pour ce moteur : ${depthPerRow.toFixed(2)} m disponibles par rangée, ${maxMinDepth.toFixed(2)} m minimum requis pour au moins une pièce (surface totale par ailleurs suffisante).`,
    ]);
  }

  // Largeur : réparti proportionnellement aux surfaces cibles, jamais sous le minimum.
  const rooms: PlacedRoom[] = [];
  let footprintW = 0;
  let footprintD = 0;
  const failures: string[] = [];

  perRow.forEach((rowRooms, rowIndex) => {
    const totalTargetW = rowRooms.reduce((s, r) => s + r.targetWidth, 0);
    const availableWidth = empriseW - WALL_EXT * 2 - WALL_INT * Math.max(0, rowRooms.length - 1);
    if (availableWidth <= 0) {
      failures.push("La largeur disponible ne laisse aucune place après murs.");
      return;
    }
    const scale = Math.min(1, availableWidth / totalTargetW);
    let cursorX = emprise.x + WALL_EXT;
    const rowY = emprise.y + WALL_EXT + rowIndex * (depthPerRow + CORRIDOR_DEPTH);
    for (const need of rowRooms) {
      const w = need.targetWidth * scale;
      if (w < need.minWidth) {
        failures.push(
          `« ${need.label} » : largeur obtenue ${w.toFixed(2)} m < minimum ${need.minWidth.toFixed(2)} m pour ce terrain (terrain trop étroit en largeur, surface totale par ailleurs suffisante).`
        );
      }
      if (w < DOOR_WIDTH) {
        failures.push(`« ${need.label} » : porte non plaçable (largeur ${w.toFixed(2)} m < ${DOOR_WIDTH} m).`);
      }
      rooms.push({
        type: need.type,
        label: need.label,
        x: cursorX,
        y: rowY,
        w,
        d: depthPerRow,
        hasExteriorWall: false, // vérifié indépendamment ensuite
        doorOk: w >= DOOR_WIDTH,
      });
      cursorX += w + WALL_INT;
    }
    footprintW = Math.max(footprintW, cursorX - emprise.x - WALL_INT + WALL_EXT);
  });

  if (failures.length > 0) return failure(failures);

  footprintD = rows * depthPerRow + rows * CORRIDOR_DEPTH + WALL_EXT * 2;
  const footprint: Rect = { x: emprise.x, y: emprise.y, w: footprintW, d: Math.min(footprintD, empriseD) };

  if (!rectWithin(footprint, emprise)) {
    return failure(["L'emprise bâtie calculée dépasse l'emprise disponible (terrain trop étroit ou trop court)."]);
  }

  // Une bande de circulation directement après CHAQUE rangée (jamais une
  // bande unique de profondeur multipliée placée ailleurs, qui chevaucherait
  // la rangée suivante — c'est exactement ce que la vérification
  // indépendante a détecté lors d'un essai antérieur de cette construction).
  const corridors: Rect[] = [];
  for (let rowIndex = 0; rowIndex < rows; rowIndex++) {
    const corridorY = emprise.y + WALL_EXT + rowIndex * (depthPerRow + CORRIDOR_DEPTH) + depthPerRow;
    corridors.push({ x: emprise.x, y: corridorY, w: footprintW, d: CORRIDOR_DEPTH });
  }

  return {
    variantLabel: label,
    feasible: true,
    failureReasons: [],
    terrain,
    emprise,
    footprint,
    corridors,
    rooms,
    exteriorSpaces: computeExteriorSpaces(terrain, emprise, footprint, input.accessSide),
    surfaces: computeSurfaces(terrain, emprise, footprint, corridors, rooms),
  };
}

function computeExteriorSpaces(terrain: Rect, emprise: Rect, footprint: Rect, accessSide: AccessSide): ExteriorSpace[] {
  const spaces: ExteriorSpace[] = [];
  const remainingD = emprise.d - footprint.d;
  if (remainingD > 0.5) {
    spaces.push({
      label: "Espace extérieur (arrière de l'emprise)",
      rect: { x: emprise.x, y: emprise.y + footprint.d, w: emprise.w, d: remainingD },
      accessFrom: accessSide === "front" ? "circulation intérieure" : "façade d'accès",
    });
  }
  const remainingW = emprise.w - footprint.w;
  if (remainingW > 0.5) {
    spaces.push({
      label: "Espace extérieur (latéral)",
      rect: { x: emprise.x + footprint.w, y: emprise.y, w: remainingW, d: footprint.d },
      accessFrom: "façade latérale",
    });
  }
  return spaces;
}

function computeSurfaces(terrain: Rect, emprise: Rect, footprint: Rect, corridors: Rect[], rooms: PlacedRoom[]) {
  const habitable = rooms.reduce((s, r) => s + r.w * r.d, 0);
  const circulation = corridors.reduce((s, c) => s + c.w * c.d, 0);
  const batie = footprint.w * footprint.d;
  const empriseArea = emprise.w * emprise.d;
  return {
    terrain: terrain.w * terrain.d,
    emprise: empriseArea,
    batie,
    utileHabitable: habitable,
    circulation,
    exterieure: Math.max(0, empriseArea - batie),
  };
}

// ---- Vérification INDÉPENDANTE — ne fait jamais confiance à la
// construction ci-dessus, même si elle est censée garantir ces propriétés. ----
export interface VerificationIssue {
  severity: "error" | "warning";
  message: string;
}

export function independentVerify(layout: Layout): VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  if (!layout.feasible || !layout.footprint || !layout.emprise) return issues;

  // 1) Chaque pièce dans l'emprise.
  for (const r of layout.rooms) {
    if (!rectWithin({ x: r.x, y: r.y, w: r.w, d: r.d }, layout.emprise)) {
      issues.push({ severity: "error", message: `« ${r.label} » sort de l'emprise disponible.` });
    }
  }
  // 2) Aucun chevauchement entre pièces, ET aucune pièce ne chevauche une
  // bande de circulation (vérifié paire par paire, jamais supposé).
  for (let i = 0; i < layout.rooms.length; i++) {
    for (let j = i + 1; j < layout.rooms.length; j++) {
      const a = layout.rooms[i], b = layout.rooms[j];
      if (rectsOverlap({ x: a.x, y: a.y, w: a.w, d: a.d }, { x: b.x, y: b.y, w: b.w, d: b.d })) {
        issues.push({ severity: "error", message: `Chevauchement détecté entre « ${a.label} » et « ${b.label} ».` });
      }
    }
    for (const corridor of layout.corridors) {
      if (rectsOverlap({ x: layout.rooms[i].x, y: layout.rooms[i].y, w: layout.rooms[i].w, d: layout.rooms[i].d }, corridor)) {
        issues.push({ severity: "error", message: `« ${layout.rooms[i].label} » chevauche la circulation.` });
      }
    }
  }
  // 3) Fenêtre : au moins une arête de la pièce sur le périmètre EXTÉRIEUR du
  // bâti, à l'épaisseur du mur extérieur près (les pièces sont en retrait de
  // WALL_EXT par rapport au bord du bâti, jamais collées exactement dessus —
  // une comparaison d'égalité stricte ferait échouer TOUTES les pièces).
  for (const r of layout.rooms) {
    const onLeft = Math.abs(r.x - layout.footprint.x - WALL_EXT) < 1e-6;
    const onRight = Math.abs(layout.footprint.x + layout.footprint.w - (r.x + r.w) - WALL_EXT) < 1e-6;
    const onTop = Math.abs(r.y - layout.footprint.y - WALL_EXT) < 1e-6;
    const onBottom = Math.abs(layout.footprint.y + layout.footprint.d - (r.y + r.d) - WALL_EXT) < 1e-6;
    r.hasExteriorWall = onLeft || onRight || onTop || onBottom;
    if (!r.hasExteriorWall) {
      issues.push({ severity: "warning", message: `« ${r.label} » n'a aucune ouverture extérieure possible (pièce entièrement intérieure).` });
    }
  }
  // 4) Porte : déjà calculée à la construction, revérifiée ici sur les dimensions réelles.
  for (const r of layout.rooms) {
    if (r.w < DOOR_WIDTH) {
      issues.push({ severity: "error", message: `« ${r.label} » : largeur ${r.w.toFixed(2)} m insuffisante pour une porte (${DOOR_WIDTH} m).` });
    }
  }
  // 5) Circulation atteint chaque pièce (chaque pièce touche l'une des bandes de corridor).
  for (const r of layout.rooms) {
    const touchesCorridor = layout.corridors.some(
      (c) => Math.abs(r.y + r.d - c.y) < 1e-6 || Math.abs(c.y + c.d - r.y) < 1e-6
    );
    if (!touchesCorridor) {
      issues.push({ severity: "error", message: `« ${r.label} » ne touche pas la circulation : accès non garanti depuis l'entrée.` });
    }
  }
  return issues;
}

export interface GenerationResult {
  variants: Layout[];
  // Motifs d'échec des tentatives NON retenues — utilisés uniquement pour
  // expliquer un échec total ("aucune solution trouvée par ce moteur avec
  // ces paramètres"), jamais pour affirmer une impossibilité architecturale.
  attemptFailureReasons: string[];
}

export function generateVariants(input: GenerationInput): GenerationResult {
  const types = input.needs.map((n) => n.type);
  const orders: string[][] = [
    types,
    [...types].reverse(),
    [...types].sort(() => (types.indexOf("salon") < types.indexOf("cuisine") ? 1 : -1)),
  ];
  const variants: Layout[] = [];
  const attemptFailureReasons: string[] = [];
  let variantN = 1;
  for (const rows of [1, 2] as const) {
    for (const order of orders) {
      const layout = buildRowLayout(input, order, rows, `Variante ${variantN}`);
      if (layout.feasible) {
        // Déduplique les géométries identiques (même ordre produit le même résultat).
        const key = JSON.stringify(layout.rooms.map((r) => [r.type, r.x.toFixed(2), r.y.toFixed(2), r.w.toFixed(2), r.d.toFixed(2)]));
        if (!variants.some((c) => JSON.stringify(c.rooms.map((r) => [r.type, r.x.toFixed(2), r.y.toFixed(2), r.w.toFixed(2), r.d.toFixed(2)])) === key)) {
          variants.push(layout);
          variantN++;
        }
      } else {
        for (const reason of layout.failureReasons) {
          if (!attemptFailureReasons.includes(reason)) attemptFailureReasons.push(reason);
        }
      }
    }
  }
  return { variants, attemptFailureReasons };
}
