// Moteur géométrique du prototype T0 — isolé, aucune dépendance nouvelle,
// aucune persistance. Toutes les valeurs sont des HYPOTHÈSES DE CONCEPTION
// modifiables, jamais des normes locales certifiées (aucune réglementation
// n'est connue ni supposée ici).
//
// Topologie T0.2 : corridor central unique, colonne(s) de pièces DE CHAQUE
// CÔTÉ, chaque pièce posée à plat contre le mur extérieur (fenêtre garantie
// par construction, revérifiée indépendamment) et contre le corridor (porte
// garantie par construction, revérifiée indépendamment via un graphe
// d'accessibilité réel). Chaque pièce garde SA PROPRE taille cible — aucun
// remplissage automatique de l'emprise, aucune mise à l'échelle partagée.

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
export const CORRIDOR_WIDTH = 1.2; // largeur du corridor central (m), hypothèse
export const DOOR_WIDTH = 0.9; // largeur mini d'une porte (m)
// Élongation maximale d'une pièce par rapport à sa dimension cible — un
// garde-fou documenté, pas un mécanisme de remplissage : à taille cible
// normale (>= minimum), il ne se déclenche jamais (voir sizeFor()).
export const MAX_ELONGATION = 1.25;
// Types de pièces pour lesquels une ouverture extérieure représentée est une
// RÈGLE DE CONCEPTION de ce prototype (hypothèse de confort, pas une norme
// réglementaire certifiée) : toute variante qui échoue est écartée des
// propositions satisfaisantes.
const REQUIRE_EXTERIOR_TYPES = new Set(["chambre", "salon"]);
// Largeur d'une porte de garage (véhicule), distincte d'une porte intérieure
// piétonne — hypothèse de conception, pas une norme.
export const GARAGE_DOOR_WIDTH = 2.4;
// Un garage n'est pas satisfait par un simple accès couloir : il doit
// déboucher directement sur la façade d'accès (entrée véhicule).
const REQUIRE_VEHICLE_ACCESS_TYPES = new Set(["garage"]);

export type AccessSide = "front" | "back" | "left" | "right";
export type WallSide = "left" | "right" | "top" | "bottom";

export interface Setbacks {
  front: number;
  back: number;
  left: number;
  right: number;
}

export type EntryMode = "direct" | "courtyard";
export type RoomConnection = "corridor" | "salon";

export interface GenerationInput {
  terrainWidth: number;
  terrainDepth: number;
  setbacks: Setbacks;
  accessSide: AccessSide;
  orientation: "N" | "S" | "E" | "O";
  needs: RoomNeed[];
  // Organisation guidée — rue → cour → salon central → reste. Une COUR est un
  // espace dimensionné et accessible, jamais un simple reste de terrain.
  entryMode: EntryMode;
  courtyardDepth: number; // utilisé seulement si entryMode === "courtyard"
  centralSalon: boolean;
  // Deux pièces qui se touchent ne sont pas nécessairement communicantes :
  // ce choix décide explicitement PAR QUELLE PORTE une pièce est reliée.
  roomsConnectVia: RoomConnection; // chambre / cuisine, si centralSalon
  sanitaireConnectVia: RoomConnection; // "salon" ici = accès direct depuis le salon
}

export interface Door {
  wall: WallSide;
  cx: number;
  cy: number;
  width: number;
}

export interface PlacedRoom {
  type: string;
  label: string;
  number: number;
  x: number;
  y: number;
  w: number;
  d: number;
  exteriorWall: WallSide | null;
  door: Door;
  // À quelle infrastructure la porte ci-dessus relie réellement la pièce —
  // jamais déduit d'un simple contact de rectangles (proximité ≠ connexion).
  connectsTo: "corridor" | "salon";
  // Porte véhicule directe vers la façade d'accès (garage uniquement) — un
  // couloir intérieur ne peut jamais la remplacer.
  vehicleDoor: Door | null;
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
  // Écartée des propositions "satisfaisantes" (règle fenêtre chambre/salon,
  // ou accès réel non prouvé) même si géométriquement constructible.
  rejected: boolean;
  rejectionReasons: string[];
  terrain: Rect;
  emprise: Rect | null;
  footprint: Rect | null;
  corridor: Rect | null;
  // Petits segments de raccord entre une pièce plus étroite que sa colonne
  // et le corridor central — jamais un chevauchement, jamais une pièce
  // "presque" reliée : soit le raccord existe et touche les deux, soit non.
  corridorFillers: Rect[];
  // Cour d'entrée — espace dimensionné et accessible depuis la rue, JAMAIS le
  // simple reste du terrain (voir exteriorSpaces pour cela).
  courtyard: Rect | null;
  streetDoor: Door | null;
  entryDoor: Door | null;
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

function rectsOverlap(a: Rect, b: Rect, eps = 1e-6): boolean {
  return a.x < b.x + b.w - eps && a.x + a.w > b.x + eps && a.y < b.y + b.d - eps && a.y + a.d > b.y + eps;
}

// "Adjacent" veut dire ici : séparé par au plus l'empilement de murs réel
// posé à la construction (jusqu'à un mur extérieur PLUS une cloison
// intérieure — cas du salon central, séparé du corridor par sa propre
// cloison ET la marge avant de la section suivante), jamais un chevauchement
// ni un écart plus grand — une pièce à 2 m d'un corridor n'est PAS adjacente.
const ADJACENCY_TOLERANCE = WALL_EXT + WALL_INT + 0.02;

function rectsAdjacent(a: Rect, b: Rect, eps = ADJACENCY_TOLERANCE): boolean {
  const xTouch = Math.abs(a.x + a.w - b.x) < eps || Math.abs(b.x + b.w - a.x) < eps;
  const yOverlap = a.y < b.y + b.d - 1e-6 && a.y + a.d > b.y + 1e-6;
  const yTouch = Math.abs(a.y + a.d - b.y) < eps || Math.abs(b.y + b.d - a.y) < eps;
  const xOverlap = a.x < b.x + b.w - 1e-6 && a.x + a.w > b.x + 1e-6;
  return (xTouch && yOverlap) || (yTouch && xOverlap);
}

function rectWithin(inner: Rect, outer: Rect, eps = 1e-6): boolean {
  return (
    inner.x >= outer.x - eps &&
    inner.y >= outer.y - eps &&
    inner.x + inner.w <= outer.x + outer.w + eps &&
    inner.y + inner.d <= outer.y + outer.d + eps
  );
}

// Taille d'une pièce : sa dimension CIBLE, jamais étirée pour remplir de
// l'espace disponible. Le plafond d'élongation ne joue que si la cible est
// (par une saisie utilisateur) inférieure au minimum.
function sizeFor(target: number, min: number): number {
  return Math.min(Math.max(target, min), target * MAX_ELONGATION);
}

function expandNeeds(needs: RoomNeed[], order: string[]): RoomNeed[] {
  const byType = new Map(needs.map((n) => [n.type, n]));
  const out: RoomNeed[] = [];
  for (const type of order) {
    const n = byType.get(type);
    if (!n) continue;
    for (let i = 0; i < n.count; i++) out.push(n);
  }
  for (const n of needs) if (!order.includes(n.type)) for (let i = 0; i < n.count; i++) out.push(n);
  return out;
}

interface ColumnRoom {
  need: RoomNeed;
  width: number;
  depth: number;
}

function layoutColumn(needs: RoomNeed[]): { rooms: ColumnRoom[]; maxWidth: number; totalDepth: number } {
  const rooms = needs.map((need) => ({ need, width: sizeFor(need.targetWidth, need.minWidth), depth: sizeFor(need.targetDepth, need.minDepth) }));
  const maxWidth = rooms.reduce((m, r) => Math.max(m, r.width), 0);
  const totalDepth = rooms.reduce((s, r) => s + r.depth, 0) + WALL_INT * Math.max(0, rooms.length - 1);
  return { rooms, maxWidth, totalDepth };
}

// Compte les instances déjà vues par type pour numéroter "Chambre 1/2/3".
function numberWithin(rooms: RoomNeed[], upToIndex: number, type: string): number {
  let n = 0;
  for (let i = 0; i <= upToIndex; i++) if (rooms[i].type === type) n++;
  return n;
}

function buildDoubleLoadedLayout(
  input: GenerationInput,
  leftNeeds: RoomNeed[],
  rightNeeds: RoomNeed[],
  label: string
): Layout {
  const terrain: Rect = { x: 0, y: 0, w: input.terrainWidth, d: input.terrainDepth };
  const empriseW = input.terrainWidth - input.setbacks.left - input.setbacks.right;
  const empriseD = input.terrainDepth - input.setbacks.front - input.setbacks.back;
  const fail = (reasons: string[]): Layout => ({
    variantLabel: label,
    feasible: false,
    failureReasons: reasons,
    rejected: false,
    rejectionReasons: [],
    terrain,
    emprise: null,
    footprint: null,
    corridor: null,
    corridorFillers: [],
    courtyard: null,
    streetDoor: null,
    entryDoor: null,
    rooms: [],
    exteriorSpaces: [],
    surfaces: { terrain: input.terrainWidth * input.terrainDepth, emprise: 0, batie: 0, utileHabitable: 0, circulation: 0, exterieure: 0 },
  });

  if (empriseW <= 0 || empriseD <= 0) {
    return fail(["Les reculs ne laissent aucune emprise constructible (largeur ou profondeur disponible ≤ 0)."]);
  }
  if (leftNeeds.length === 0 && rightNeeds.length === 0) return fail(["Aucun besoin renseigné."]);
  const emprise: Rect = { x: input.setbacks.left, y: input.setbacks.front, w: empriseW, d: empriseD };

  const left = leftNeeds.length > 0 ? layoutColumn(leftNeeds) : null;
  const right = rightNeeds.length > 0 ? layoutColumn(rightNeeds) : null;

  const footprintW =
    WALL_EXT * 2 +
    (left ? left.maxWidth + WALL_INT : 0) +
    CORRIDOR_WIDTH +
    (right ? right.maxWidth + WALL_INT : 0);
  const footprintD = WALL_EXT * 2 + Math.max(left?.totalDepth ?? 0, right?.totalDepth ?? 0);

  if (footprintW > empriseW) {
    return fail([
      `Largeur insuffisante dans cette disposition : ${footprintW.toFixed(2)} m nécessaires > ${empriseW.toFixed(2)} m disponibles pour cette répartition des pièces (une autre répartition peut suffire, la surface totale est peut-être par ailleurs suffisante).`,
    ]);
  }
  if (footprintD > empriseD) {
    return fail([
      `Profondeur insuffisante dans cette disposition : ${footprintD.toFixed(2)} m nécessaires > ${empriseD.toFixed(2)} m disponibles pour cette répartition des pièces (une autre répartition peut suffire).`,
    ]);
  }

  const footprint: Rect = { x: emprise.x, y: emprise.y, w: footprintW, d: footprintD };
  const corridorX = emprise.x + WALL_EXT + (left ? left.maxWidth + WALL_INT : 0);
  const corridor: Rect = { x: corridorX, y: emprise.y + WALL_EXT, w: CORRIDOR_WIDTH, d: Math.max(left?.totalDepth ?? 0, right?.totalDepth ?? 0) };

  const rooms: PlacedRoom[] = [];
  const corridorFillers: Rect[] = [];
  const doorFailures: string[] = [];

  function placeColumn(col: { rooms: ColumnRoom[]; maxWidth: number } | null, needsArr: RoomNeed[], side: "left" | "right") {
    if (!col) return;
    let cursorY = emprise.y + WALL_EXT;
    const colMaxWidth = col.maxWidth;
    col.rooms.forEach((cr, i) => {
      const need = needsArr[i];
      const x = side === "left" ? emprise.x + WALL_EXT : corridor.x + corridor.w + WALL_INT + (colMaxWidth - cr.width);
      const exteriorWall: WallSide = side === "left" ? "left" : "right";
      const innerX = side === "left" ? x + cr.width : x;
      const door: Door = {
        wall: side === "left" ? "right" : "left",
        cx: innerX,
        cy: cursorY + cr.depth / 2,
        width: Math.min(DOOR_WIDTH, cr.depth),
      };
      if (cr.depth < DOOR_WIDTH) {
        doorFailures.push(`« ${need.label} » : profondeur ${cr.depth.toFixed(2)} m insuffisante pour une porte (${DOOR_WIDTH} m).`);
      }
      rooms.push({
        type: need.type,
        label: need.label,
        number: numberWithin(needsArr, i, need.type),
        x,
        y: cursorY,
        w: cr.width,
        d: cr.depth,
        exteriorWall,
        door,
        connectsTo: "corridor",
        vehicleDoor: null,
      });
      // Raccord si cette pièce est plus étroite que la colonne : relie son
      // bord intérieur au corridor, jamais un chevauchement supposé.
      const gap = colMaxWidth - cr.width;
      if (gap > 1e-6) {
        const fillerX = side === "left" ? x + cr.width : corridor.x + corridor.w + WALL_INT;
        corridorFillers.push({ x: fillerX, y: cursorY, w: gap + WALL_INT, d: cr.depth });
      }
      cursorY += cr.depth + WALL_INT;
    });
  }

  placeColumn(left, leftNeeds, "left");
  placeColumn(right, rightNeeds, "right");

  if (doorFailures.length > 0) return fail(doorFailures);

  // Accès véhicule (garage) : un couloir intérieur ne suffit jamais. Pour un
  // accès avant/arrière, seule la pièce la plus proche de la façade d'accès
  // dans sa colonne (première posée, adjacente au mur via WALL_EXT — le
  // symétrique vertical appliqué plus bas pour "back" la replace ensuite
  // côté arrière) peut recevoir une porte véhicule directe. Pour un accès
  // latéral, toute pièce de la colonne du côté choisi touche déjà ce mur.
  for (const r of rooms) {
    if (!REQUIRE_VEHICLE_ACCESS_TYPES.has(r.type)) continue;
    if (input.accessSide === "left" || input.accessSide === "right") {
      if (r.exteriorWall === input.accessSide) {
        r.vehicleDoor = { wall: input.accessSide, cx: r.exteriorWall === "left" ? r.x : r.x + r.w, cy: r.y + r.d / 2, width: Math.min(GARAGE_DOOR_WIDTH, r.d) };
      }
    } else {
      const isFirstInColumn = Math.abs(r.y - (emprise.y + WALL_EXT)) < 1e-6;
      if (isFirstInColumn) {
        r.vehicleDoor = { wall: "top", cx: r.x + r.w / 2, cy: r.y, width: Math.min(GARAGE_DOOR_WIDTH, r.w) };
      }
    }
  }

  const entryDoor: Door = { wall: "top", cx: corridor.x + corridor.w / 2, cy: footprint.y, width: DOOR_WIDTH };

  const terrainOut = terrain;
  const empriseOut = emprise;
  let footprintOut = footprint;
  let corridorOut = corridor;
  let corridorFillersOut = corridorFillers;
  let entryDoorOut = entryDoor;
  let roomsOut = rooms;

  if (input.accessSide === "back") {
    const mirrorY = (r: Rect): Rect => ({ x: r.x, y: emprise.y + emprise.d - (r.y - emprise.y) - r.d, w: r.w, d: r.d });
    footprintOut = mirrorY(footprint);
    corridorOut = mirrorY(corridor);
    corridorFillersOut = corridorFillers.map(mirrorY);
    const mirrorCy = (cy: number) => emprise.y + emprise.d - (cy - emprise.y);
    roomsOut = rooms.map((r) => {
      const mirrored = mirrorY(r);
      return {
        ...r,
        x: mirrored.x,
        y: mirrored.y,
        door: { ...r.door, cy: mirrorCy(r.door.cy) },
        vehicleDoor: r.vehicleDoor ? { ...r.vehicleDoor, wall: "bottom" as WallSide, cy: mirrorCy(r.vehicleDoor.cy) } : null,
      };
    });
    entryDoorOut = { ...entryDoor, wall: "bottom", cy: footprintOut.y + footprintOut.d };
  } else if (input.accessSide === "left") {
    entryDoorOut = { wall: "left", cx: footprint.x, cy: corridor.y + Math.min(DOOR_WIDTH, corridor.d) / 2 + 0.3, width: DOOR_WIDTH };
  } else if (input.accessSide === "right") {
    entryDoorOut = { wall: "right", cx: footprint.x + footprint.w, cy: corridor.y + Math.min(DOOR_WIDTH, corridor.d) / 2 + 0.3, width: DOOR_WIDTH };
  }

  return {
    variantLabel: label,
    feasible: true,
    failureReasons: [],
    rejected: false,
    rejectionReasons: [],
    terrain: terrainOut,
    emprise: empriseOut,
    footprint: footprintOut,
    corridor: corridorOut,
    corridorFillers: corridorFillersOut,
    courtyard: null,
    streetDoor: null,
    entryDoor: entryDoorOut,
    rooms: roomsOut,
    exteriorSpaces: computeExteriorSpaces(terrainOut, empriseOut, footprintOut, input.accessSide),
    surfaces: computeSurfaces(terrainOut, empriseOut, footprintOut, corridorOut, corridorFillersOut, roomsOut),
  };
}

// Organisation guidée — rue → cour → salon central → reste (chambres,
// cuisine, sanitaires). Additif au moteur en rangées/corridor double-chargé
// ci-dessus : réutilisé tel quel pour la section "reste des pièces" en lui
// passant un recul avant augmenté pour réserver la profondeur de la cour et
// du salon, puis la cour et le salon sont posés par-dessus.
//
// Limite explicite de cette première version : seul un accès "avant" est
// pris en charge pour la cour et le salon central (le calque de symétrie
// utilisé pour "arrière" et le déplacement latéral pour "gauche/droite" ne
// sont pas recombinés avec cette organisation ici) — une combinaison non
// prise en charge est refusée avec une raison explicite, jamais ignorée.
function buildGuidedLayout(
  input: GenerationInput,
  leftNeeds: RoomNeed[],
  rightNeeds: RoomNeed[],
  salonNeed: RoomNeed | null,
  leftSlot: RoomNeed | null,
  rightSlot: RoomNeed | null,
  label: string
): Layout {
  const terrain: Rect = { x: 0, y: 0, w: input.terrainWidth, d: input.terrainDepth };
  const fail = (reasons: string[]): Layout => ({
    variantLabel: label,
    feasible: false,
    failureReasons: reasons,
    rejected: false,
    rejectionReasons: [],
    terrain,
    emprise: null,
    footprint: null,
    corridor: null,
    corridorFillers: [],
    courtyard: null,
    streetDoor: null,
    entryDoor: null,
    rooms: [],
    exteriorSpaces: [],
    surfaces: { terrain: input.terrainWidth * input.terrainDepth, emprise: 0, batie: 0, utileHabitable: 0, circulation: 0, exterieure: 0 },
  });

  const needsGuidedLayout = input.entryMode === "courtyard" || (input.centralSalon && salonNeed);
  if (needsGuidedLayout && input.accessSide !== "front") {
    return fail([
      "Cour d'entrée / salon central non pris en charge dans cette version pour une façade d'accès autre qu'avant — combinaison non traitée, choix ignoré nulle part : réessayez avec « Avant », ou désactivez la cour et le salon central.",
    ]);
  }

  const F = input.setbacks.front;
  const courtyardDepth = input.entryMode === "courtyard" ? Math.max(0, input.courtyardDepth) : 0;
  const salonDepth = salonNeed ? sizeFor(salonNeed.targetDepth, salonNeed.minDepth) : 0;
  const reservedFrontDepth = courtyardDepth + (salonNeed ? WALL_EXT + salonDepth + WALL_INT : 0);

  const modifiedInput: GenerationInput = { ...input, setbacks: { ...input.setbacks, front: F + reservedFrontDepth } };
  const lower = buildDoubleLoadedLayout(modifiedInput, leftNeeds, rightNeeds, label);
  if (!lower.feasible || !lower.footprint || !lower.corridor || !lower.emprise) {
    return fail(lower.failureReasons.length > 0 ? lower.failureReasons : ["Disposition impossible sous le salon/la cour demandés."]);
  }

  const realEmpriseW = input.terrainWidth - input.setbacks.left - input.setbacks.right;
  const realEmpriseD = input.terrainDepth - input.setbacks.front - input.setbacks.back;
  if (realEmpriseW <= 0 || realEmpriseD <= 0) {
    return fail(["Les reculs ne laissent aucune emprise constructible (largeur ou profondeur disponible ≤ 0)."]);
  }
  const realEmprise: Rect = { x: input.setbacks.left, y: F, w: realEmpriseW, d: realEmpriseD };

  const footprintW = lower.footprint.w;
  const rooms: PlacedRoom[] = [...lower.rooms];
  let salonRect: Rect | null = null;
  const extraFillers: Rect[] = [];

  if (salonNeed) {
    const leftSlotWidth = leftSlot ? sizeFor(leftSlot.targetWidth, leftSlot.minWidth) : 0;
    const rightSlotWidth = rightSlot ? sizeFor(rightSlot.targetWidth, rightSlot.minWidth) : 0;
    const salonWidth = footprintW - 2 * WALL_EXT - (leftSlot ? leftSlotWidth + WALL_INT : 0) - (rightSlot ? rightSlotWidth + WALL_INT : 0);
    if (salonWidth < salonNeed.minWidth) {
      return fail([
        `Largeur insuffisante dans cette disposition pour le salon central avec les pièces adjacentes demandées (${salonWidth.toFixed(2)} m < ${salonNeed.minWidth.toFixed(2)} m minimum).`,
      ]);
    }
    const salonX = realEmprise.x + WALL_EXT + (leftSlot ? leftSlotWidth + WALL_INT : 0);
    const salonY = F + courtyardDepth + WALL_EXT;
    salonRect = { x: salonX, y: salonY, w: salonWidth, d: salonDepth };

    if (leftSlot) {
      const d = Math.min(sizeFor(leftSlot.targetDepth, leftSlot.minDepth), salonDepth);
      if (d < leftSlot.minDepth) {
        return fail([`Profondeur insuffisante dans cette disposition pour « ${leftSlot.label} » à côté du salon (${d.toFixed(2)} m < ${leftSlot.minDepth.toFixed(2)} m minimum).`]);
      }
      const w = leftSlotWidth;
      rooms.push({
        type: leftSlot.type,
        label: leftSlot.label,
        number: 1,
        x: realEmprise.x + WALL_EXT,
        y: salonY,
        w,
        d,
        exteriorWall: "left",
        door: { wall: "right", cx: realEmprise.x + WALL_EXT + w, cy: salonY + d / 2, width: Math.min(DOOR_WIDTH, d) },
        connectsTo: "salon",
        vehicleDoor: null,
      });
    }
    if (rightSlot) {
      const d = Math.min(sizeFor(rightSlot.targetDepth, rightSlot.minDepth), salonDepth);
      if (d < rightSlot.minDepth) {
        return fail([`Profondeur insuffisante dans cette disposition pour « ${rightSlot.label} » à côté du salon (${d.toFixed(2)} m < ${rightSlot.minDepth.toFixed(2)} m minimum).`]);
      }
      const w = rightSlotWidth;
      const x = realEmprise.x + footprintW - WALL_EXT - w;
      rooms.push({
        type: rightSlot.type,
        label: rightSlot.label,
        number: (leftSlot?.type === rightSlot.type ? 2 : 1),
        x,
        y: salonY,
        w,
        d,
        exteriorWall: "right",
        door: { wall: "left", cx: x, cy: salonY + d / 2, width: Math.min(DOOR_WIDTH, d) },
        connectsTo: "salon",
        vehicleDoor: null,
      });
    }
    rooms.push({
      type: salonNeed.type,
      label: salonNeed.label,
      number: 1,
      x: salonX,
      y: salonY,
      w: salonWidth,
      d: salonDepth,
      exteriorWall: "top",
      door: { wall: "top", cx: salonX + salonWidth / 2, cy: salonY, width: DOOR_WIDTH },
      connectsTo: "salon",
      vehicleDoor: null,
    });
  }

  const courtyard: Rect | null = courtyardDepth > 0 ? { x: realEmprise.x, y: F, w: footprintW, d: courtyardDepth } : null;
  const streetDoor: Door | null = courtyard ? { wall: "top", cx: courtyard.x + courtyard.w / 2, cy: F, width: DOOR_WIDTH } : null;

  const combinedFootprint: Rect = {
    x: lower.footprint.x,
    y: F + courtyardDepth,
    w: footprintW,
    d: lower.footprint.y + lower.footprint.d - (F + courtyardDepth),
  };

  const entryDoor: Door = salonRect
    ? { wall: "top", cx: salonRect.x + salonRect.w / 2, cy: salonRect.y, width: DOOR_WIDTH }
    : lower.entryDoor!;

  return {
    variantLabel: label,
    feasible: true,
    failureReasons: [],
    rejected: false,
    rejectionReasons: [],
    terrain,
    emprise: realEmprise,
    footprint: combinedFootprint,
    corridor: lower.corridor,
    corridorFillers: [...lower.corridorFillers, ...extraFillers],
    courtyard,
    streetDoor,
    entryDoor,
    rooms,
    exteriorSpaces: computeExteriorSpaces(terrain, realEmprise, combinedFootprint, input.accessSide),
    surfaces: computeSurfaces(terrain, realEmprise, combinedFootprint, lower.corridor, lower.corridorFillers, rooms),
  };
}

function computeExteriorSpaces(terrain: Rect, emprise: Rect, footprint: Rect, accessSide: AccessSide): ExteriorSpace[] {
  const spaces: ExteriorSpace[] = [];
  const remainingD = emprise.d - footprint.d;
  if (remainingD > 0.5) {
    spaces.push({
      label: "Espace extérieur non bâti (reste de l'emprise, distinct de la cour d'entrée)",
      rect: { x: emprise.x, y: emprise.y + footprint.d, w: emprise.w, d: remainingD },
      accessFrom: accessSide === "back" ? "façade d'accès" : "arrière de la parcelle",
    });
  }
  const remainingW = emprise.w - footprint.w;
  if (remainingW > 0.5) {
    spaces.push({
      label: "Espace extérieur non bâti (latéral)",
      rect: { x: emprise.x + footprint.w, y: emprise.y, w: remainingW, d: footprint.d },
      accessFrom: "façade latérale",
    });
  }
  return spaces;
}

function computeSurfaces(terrain: Rect, emprise: Rect, footprint: Rect, corridor: Rect, fillers: Rect[], rooms: PlacedRoom[]) {
  const habitable = rooms.reduce((s, r) => s + r.w * r.d, 0);
  const circulation = corridor.w * corridor.d + fillers.reduce((s, f) => s + f.w * f.d, 0);
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

function roomRect(r: PlacedRoom): Rect {
  return { x: r.x, y: r.y, w: r.w, d: r.d };
}

// Contact réel avec le périmètre du bâti, sur n'importe lequel des 4 murs, à
// l'épaisseur du mur extérieur près — jamais lu depuis un champ posé à la
// construction, jamais déduit d'un simple voisinage entre pièces.
function hasExteriorTouch(r: PlacedRoom, footprint: Rect): boolean {
  const onLeft = Math.abs(r.x - footprint.x - WALL_EXT) < 1e-3;
  const onRight = Math.abs(footprint.x + footprint.w - (r.x + r.w) - WALL_EXT) < 1e-3;
  const onTop = Math.abs(r.y - footprint.y - WALL_EXT) < 1e-3;
  const onBottom = Math.abs(footprint.y + footprint.d - (r.y + r.d) - WALL_EXT) < 1e-3;
  return onLeft || onRight || onTop || onBottom;
}

export function independentVerify(layout: Layout): VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  if (!layout.feasible || !layout.footprint || !layout.emprise || !layout.corridor) return issues;

  // 1) Chaque pièce dans l'emprise.
  for (const r of layout.rooms) {
    if (!rectWithin(roomRect(r), layout.emprise)) {
      issues.push({ severity: "error", message: `« ${r.label} ${r.number} » sort de l'emprise disponible.` });
    }
  }
  // 2) Aucun chevauchement : pièce-pièce, pièce-corridor, pièce-raccord.
  const allBlocks: { label: string; rect: Rect }[] = [
    ...layout.rooms.map((r) => ({ label: `${r.label} ${r.number}`, rect: roomRect(r) })),
    { label: "corridor", rect: layout.corridor },
  ];
  for (let i = 0; i < allBlocks.length; i++) {
    for (let j = i + 1; j < allBlocks.length; j++) {
      if (rectsOverlap(allBlocks[i].rect, allBlocks[j].rect)) {
        issues.push({ severity: "error", message: `Chevauchement détecté entre « ${allBlocks[i].label} » et « ${allBlocks[j].label} ».` });
      }
    }
  }
  // 3) Ouverture extérieure : recalculée indépendamment (la pièce touche-t-elle
  // réellement le périmètre du bâti à l'épaisseur du mur extérieur près, sur
  // N'IMPORTE LEQUEL des 4 murs ?), jamais lue depuis le champ posé à la
  // construction. Une pièce à côté (touchant) une autre pièce n'est JAMAIS
  // comptée comme extérieure : seul le contact avec footprint compte.
  for (const r of layout.rooms) {
    if (!hasExteriorTouch(r, layout.footprint)) {
      issues.push({ severity: "warning", message: `« ${r.label} ${r.number} » n'a aucune ouverture extérieure possible (pièce entièrement intérieure).` });
    }
  }
  // 4) Porte : largeur réelle revérifiée.
  for (const r of layout.rooms) {
    if (r.door.width < DOOR_WIDTH - 1e-6) {
      issues.push({ severity: "error", message: `« ${r.label} ${r.number} » : porte de ${r.door.width.toFixed(2)} m insuffisante (${DOOR_WIDTH} m requis).` });
    }
  }
  // 5) Accessibilité RÉELLE depuis l'entrée — graphe construit à partir des
  // adjacences géométriques effectives (porte + contact réel), pas d'un
  // simple contact de boîtes englobantes ni d'une hypothèse de construction.
  // Deux pièces qui se touchent ne sont pas nécessairement communicantes :
  // chaque pièce n'est considérée reliée QUE via l'infrastructure désignée
  // par son propre champ `connectsTo`, jamais par simple proximité.
  const eps = ADJACENCY_TOLERANCE;
  const salonRoom = layout.rooms.find((r) => r.type === "salon" && r.connectsTo === "salon") ?? null;
  const salonRect = salonRoom ? roomRect(salonRoom) : null;

  // Chaîne rue -> cour -> (salon ou corridor) -> corridor.
  let originReached = true;
  if (layout.courtyard && layout.streetDoor) {
    const streetTouchesCourtyard =
      Math.abs(layout.streetDoor.cy - layout.courtyard.y) < eps || Math.abs(layout.streetDoor.cy - (layout.courtyard.y + layout.courtyard.d)) < eps;
    if (!streetTouchesCourtyard) {
      issues.push({ severity: "error", message: "La porte côté rue ne débouche pas sur la cour : accès non garanti." });
      originReached = false;
    }
  }

  if (layout.entryDoor && originReached) {
    const targetRect = salonRect ?? layout.corridor;
    const targetLabel = salonRect ? "le salon" : "le corridor";
    const entryTouches =
      Math.abs(layout.entryDoor.cy - targetRect.y) < eps ||
      Math.abs(layout.entryDoor.cy - (targetRect.y + targetRect.d)) < eps ||
      Math.abs(layout.entryDoor.cx - targetRect.x) < eps ||
      Math.abs(layout.entryDoor.cx - (targetRect.x + targetRect.w)) < eps;
    if (!entryTouches) {
      issues.push({ severity: "error", message: `L'entrée ne débouche pas sur ${targetLabel} : accès non garanti.` });
    }
  } else if (!layout.entryDoor) {
    issues.push({ severity: "error", message: "Aucune porte d'entrée définie." });
  }

  const salonConnectedToCorridor = salonRect ? rectsAdjacent(salonRect, layout.corridor) : true;
  if (salonRect && !salonConnectedToCorridor) {
    issues.push({ severity: "error", message: "Le salon central ne débouche sur le corridor par aucune ouverture réelle : les pièces reliées au dégagement resteraient inaccessibles." });
  }

  for (const r of layout.rooms) {
    if (r === salonRoom) continue;
    const rect = roomRect(r);
    if (r.connectsTo === "salon") {
      if (!salonRect) {
        issues.push({ severity: "error", message: `« ${r.label} ${r.number} » : accès par le salon demandé, mais aucun salon central dans cette disposition.` });
        continue;
      }
      if (!rectsAdjacent(rect, salonRect)) {
        issues.push({ severity: "error", message: `« ${r.label} ${r.number} » n'est reliée au salon par aucune ouverture réelle (accès direct demandé) : accès non garanti depuis l'entrée.` });
      }
      continue;
    }
    const directlyTouchesCorridor = rectsAdjacent(rect, layout.corridor);
    const viaFiller = layout.corridorFillers.some((f) => rectsAdjacent(rect, f) && rectsAdjacent(f, layout.corridor!));
    if (!directlyTouchesCorridor && !viaFiller) {
      issues.push({ severity: "error", message: `« ${r.label} ${r.number} » n'est reliée au dégagement par aucune ouverture réelle : accès non garanti depuis l'entrée.` });
    }
  }
  // 6) Accès véhicule pour un garage — un couloir intérieur, même relié,
  // n'est jamais accepté comme substitut. Recalculé indépendamment : la
  // porte véhicule existe-t-elle réellement et débouche-t-elle sur le mur
  // extérieur de la façade d'accès (pas un mur intérieur) ?
  for (const r of layout.rooms) {
    if (!REQUIRE_VEHICLE_ACCESS_TYPES.has(r.type)) continue;
    if (!r.vehicleDoor || !layout.footprint) {
      issues.push({ severity: "error", message: `« ${r.label} ${r.number} » : aucun accès véhicule direct depuis la façade d'accès (un couloir intérieur ne suffit pas).` });
      continue;
    }
    // La porte véhicule est posée sur le bord de la pièce, lui-même en
    // retrait de WALL_EXT par rapport au bâti (même raisonnement que
    // hasExteriorTouch) — un écart nul serait une erreur de vérification.
    const onExteriorWall =
      Math.abs(r.vehicleDoor.cy - layout.footprint.y - WALL_EXT) < 1e-3 ||
      Math.abs(r.vehicleDoor.cy - (layout.footprint.y + layout.footprint.d) + WALL_EXT) < 1e-3 ||
      Math.abs(r.vehicleDoor.cx - layout.footprint.x - WALL_EXT) < 1e-3 ||
      Math.abs(r.vehicleDoor.cx - (layout.footprint.x + layout.footprint.w) + WALL_EXT) < 1e-3;
    if (!onExteriorWall) {
      issues.push({ severity: "error", message: `« ${r.label} ${r.number} » : la porte véhicule ne débouche pas sur un mur extérieur.` });
    }
  }
  return issues;
}

export interface GenerationResult {
  variants: Layout[];
  rejectedVariants: Layout[];
  attemptFailureReasons: string[];
}

export function generateVariants(input: GenerationInput): GenerationResult {
  const types = input.needs.map((n) => n.type);
  const orders: string[][] = [
    types,
    [...types].reverse(),
    [...types].sort((a, b) => {
      const ta = input.needs.find((n) => n.type === a)!.targetWidth;
      const tb = input.needs.find((n) => n.type === b)!.targetWidth;
      return tb - ta; // plus large d'abord
    }),
  ];

  const variants: Layout[] = [];
  const rejectedVariants: Layout[] = [];
  const attemptFailureReasons: string[] = [];
  const seenKeys = new Set<string>();
  let variantN = 1;

  function layoutKey(layout: Layout): string {
    return JSON.stringify(layout.rooms.map((r) => [r.type, r.number, r.x.toFixed(2), r.y.toFixed(2), r.w.toFixed(2), r.d.toFixed(2)]));
  }

  // Renumérote "Chambre 1/2/3" etc. sur l'ENSEMBLE de la disposition finale
  // (position y puis x), jamais par colonne séparément — deux colonnes
  // différentes partageraient sinon le même numéro 1 pour des pièces
  // distinctes, ce qui n'est pas un libellé compréhensible.
  function renumberRoomsGlobally(rooms: PlacedRoom[]) {
    const ordered = [...rooms].sort((a, b) => a.y - b.y || a.x - b.x);
    const counts = new Map<string, number>();
    for (const r of ordered) {
      const n = (counts.get(r.type) ?? 0) + 1;
      counts.set(r.type, n);
      r.number = n;
    }
  }

  function consider(layout: Layout) {
    if (!layout.feasible) {
      for (const reason of layout.failureReasons) if (!attemptFailureReasons.includes(reason)) attemptFailureReasons.push(reason);
      return;
    }
    renumberRoomsGlobally(layout.rooms);
    const key = layoutKey(layout);
    if (seenKeys.has(key)) return;
    seenKeys.add(key);

    const issues = independentVerify(layout);
    const errors = issues.filter((i) => i.severity === "error");
    // Revérifie via la géométrie réelle (indépendante du flag posé à la
    // construction) pour chaque pièce soumise à la règle fenêtre.
    const realWindowFailures = layout.rooms.filter(
      (r) => REQUIRE_EXTERIOR_TYPES.has(r.type) && layout.footprint && !hasExteriorTouch(r, layout.footprint)
    );

    layout.variantLabel = `Variante ${variantN}`;
    if (errors.length > 0 || realWindowFailures.length > 0) {
      const reasons = [
        ...errors.map((e) => e.message),
        ...realWindowFailures.map((r) => `« ${r.label} ${r.number} » (${r.type}) : règle du prototype — ouverture extérieure requise pour une chambre ou un salon, absente ici.`),
      ];
      layout.rejected = true;
      layout.rejectionReasons = reasons;
      rejectedVariants.push(layout);
    } else {
      variants.push(layout);
    }
    variantN++;
  }

  // Un garage a besoin d'être en tête de sa colonne pour recevoir une porte
  // véhicule directe (avant/arrière) — reformer les groupes ne réduit ni
  // n'ignore aucun minimum ni aucune pièce demandée, seulement leur ordre.
  function garageFirst(list: RoomNeed[]): RoomNeed[] {
    const garages = list.filter((r) => r.type === "garage");
    const rest = list.filter((r) => r.type !== "garage");
    return [...garages, ...rest];
  }

  const guided = input.centralSalon || input.entryMode === "courtyard";

  function buildAny(a: RoomNeed[], b: RoomNeed[], salon: RoomNeed | null, leftSlot: RoomNeed | null, rightSlot: RoomNeed | null, label: string): Layout {
    return guided
      ? buildGuidedLayout(input, garageFirst(a), garageFirst(b), salon, leftSlot, rightSlot, label)
      : buildDoubleLoadedLayout(input, garageFirst(a), garageFirst(b), label);
  }

  for (const order of orders) {
    const fullList = expandNeeds(input.needs, order);
    if (fullList.length === 0) continue;

    // Organisation guidée : le salon central et les pièces à accès direct
    // (salon) en sont extraites une fois pour cet ordre — jamais ignorées
    // silencieusement si la disposition échoue ensuite (motifs remontés).
    let roomList = fullList;
    let salon: RoomNeed | null = null;
    let leftSlot: RoomNeed | null = null;
    let rightSlot: RoomNeed | null = null;
    if (guided) {
      const rest = [...fullList];
      if (input.centralSalon) {
        const idx = rest.findIndex((r) => r.type === "salon");
        if (idx >= 0) {
          salon = rest[idx];
          rest.splice(idx, 1);
        }
      }
      if (salon) {
        if (input.roomsConnectVia === "salon") {
          const idx = rest.findIndex((r) => r.type === "chambre" || r.type === "cuisine");
          if (idx >= 0) {
            leftSlot = rest[idx];
            rest.splice(idx, 1);
          }
        }
        if (input.sanitaireConnectVia === "salon") {
          const idx = rest.findIndex((r) => r.type === "sanitaire");
          if (idx >= 0) {
            rightSlot = rest[idx];
            rest.splice(idx, 1);
          }
        }
      }
      roomList = rest;
    }

    // Corridor simple-chargé : toutes les pièces restantes d'un seul côté.
    consider(buildAny(roomList, [], salon, leftSlot, rightSlot, `Variante ${variantN}`));

    // Corridor double-chargé : deux répartitions de coupure, testées dans
    // les deux sens (gauche/droite), pour donner à l'algorithme une chance
    // de regrouper les pièces de gabarit proche du même côté.
    const n = roomList.length;
    const splitPoints = Array.from(new Set([Math.floor(n / 2), Math.ceil(n / 2)])).filter((sp) => sp > 0 && sp < n);
    for (const sp of splitPoints) {
      const a = roomList.slice(0, sp);
      const b = roomList.slice(sp);
      consider(buildAny(a, b, salon, leftSlot, rightSlot, `Variante ${variantN}`));
      consider(buildAny(b, a, salon, leftSlot, rightSlot, `Variante ${variantN}`));
    }

    // Répartition équilibrée par profondeur — un découpage par simple
    // position dans la liste regroupe parfois systématiquement les pièces
    // les plus profondes du même côté (ex. salon + toutes les chambres) même
    // quand une autre répartition suffirait très largement. Celle-ci
    // recherche activement un équilibre avant de conclure à un manque de
    // place, sans réduire aucun minimum ni écarter aucune pièce demandée.
    if (roomList.length >= 2) {
      const byDepthDesc = [...roomList].sort((r1, r2) => sizeFor(r2.targetDepth, r2.minDepth) - sizeFor(r1.targetDepth, r1.minDepth));
      const balancedA: RoomNeed[] = [];
      const balancedB: RoomNeed[] = [];
      let depthA = 0;
      let depthB = 0;
      for (const need of byDepthDesc) {
        const d = sizeFor(need.targetDepth, need.minDepth);
        if (depthA <= depthB) {
          balancedA.push(need);
          depthA += d;
        } else {
          balancedB.push(need);
          depthB += d;
        }
      }
      consider(buildAny(balancedA, balancedB, salon, leftSlot, rightSlot, `Variante ${variantN}`));
      consider(buildAny(balancedB, balancedA, salon, leftSlot, rightSlot, `Variante ${variantN}`));
    }
  }

  return { variants, rejectedVariants, attemptFailureReasons };
}
