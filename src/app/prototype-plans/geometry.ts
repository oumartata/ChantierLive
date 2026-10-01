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

// Référence générique vers UN espace identifié du plan — pièce, réseau de
// circulation, cour, ou extérieur direct. Remplace l'ancien couple
// connectsTo/doorTargetRoom (fermé à 4 cas ad hoc, avec un détournement de
// "salon" comme simple marqueur) par une référence uniforme, réutilisable
// pour n'importe quel espace futur (plusieurs réseaux de circulation, etc.).
export type SpaceRef =
  | { kind: "room"; index: number }
  | { kind: "circulation" }
  | { kind: "courtyard" }
  | { kind: "exterior" };

// Géométrie brute d'une baie (mur, position, largeur) — utilisée telle
// quelle pour la porte côté rue et la porte d'entrée du bâti, qui ne
// relient pas deux ESPACES INTÉRIEURS identifiés mais la rue/la cour à
// l'intérieur : un cas particulier, pas une pièce dans Layout.doors.
export interface DoorGeometry {
  wall: WallSide;
  cx: number;
  cy: number;
  width: number;
  // Sens d'ouverture — purement visuel (miroir du battant), ne change
  // jamais la connectivité ni les contrôles d'accès.
  flip?: boolean;
}

export interface Door extends DoorGeometry {
  // Pièce de RÉFÉRENCE géométrique (mur, position, battant) — le battant
  // balaie toujours vers CETTE pièce. Une porte est un objet INDÉPENDANT
  // (voir Layout.doors) : elle n'est plus possédée par la pièce, ce qui
  // permet plusieurs portes par pièce et une ouverture UNIQUE partagée par
  // les deux côtés (jamais deux portes indépendantes et contradictoires
  // pour le même passage — voir placeDoor).
  roomIndex: number;
  // Espace RÉELLEMENT relié de l'autre côté — jamais déduit d'un simple
  // contact de rectangles, toujours posé par wallAdjacency puis revérifié
  // indépendamment (voir independentVerify).
  to: SpaceRef;
}

// Fenêtre INDÉPENDANTE de toute porte — sa propre position, largeur et mur.
// Générée par défaut sur le mur extérieur d'une pièce à la génération, mais
// suivie comme un objet réel (translatée avec la pièce, revérifiée après un
// déplacement) : jamais un simple trait dérivé de "cette pièce touche le
// bâti quelque part", qui ne garantirait pas que CE mur précis est toujours
// extérieur après une modification.
export interface Window {
  roomIndex: number;
  wall: WallSide;
  cx: number;
  cy: number;
  width: number;
}

// Source UNIQUE du rectangle balayé par le battant — utilisée à la fois par
// le rendu (render.ts) et par la vérification indépendante ci-dessous :
// jamais deux calculs séparés qui pourraient diverger. Le battant balaie un
// carré de côté `door.width`, depuis la baie jusqu'à cette distance À
// L'INTÉRIEUR de la pièce qu'il dessert (jamais vers le dégagement).
export function doorSwingRect(door: Door): Rect {
  const half = door.width / 2;
  switch (door.wall) {
    case "right":
      return { x: door.cx - door.width, y: door.cy - half, w: door.width, d: door.width };
    case "left":
      return { x: door.cx, y: door.cy - half, w: door.width, d: door.width };
    case "top":
      return { x: door.cx - half, y: door.cy, w: door.width, d: door.width };
    case "bottom":
      return { x: door.cx - half, y: door.cy - door.width, w: door.width, d: door.width };
  }
}

// Contrepartie EXTÉRIEURE de doorSwingRect : sonde juste au-delà de la baie,
// large de door.width seulement (pas tout le mur) — sert à vérifier que
// l'ouverture RÉELLE (pas seulement la pièce dans son ensemble) débouche sur
// l'espace annoncé par connectsTo. Nécessaire après un déplacement de pièce :
// une porte translatée avec sa pièce peut sortir de la portion de mur qui
// touche réellement le dégagement/la pièce voisine, même si le reste du mur
// continue de chevaucher cet espace.
function doorOutsideProbe(door: Door): Rect {
  const half = door.width / 2;
  const depth = ADJACENCY_TOLERANCE;
  switch (door.wall) {
    case "right":
      return { x: door.cx, y: door.cy - half, w: depth, d: door.width };
    case "left":
      return { x: door.cx - depth, y: door.cy - half, w: depth, d: door.width };
    case "top":
      return { x: door.cx - half, y: door.cy - depth, w: door.width, d: depth };
    case "bottom":
      return { x: door.cx - half, y: door.cy, w: door.width, d: depth };
  }
}

export interface PlacedRoom {
  type: string;
  label: string;
  number: number;
  x: number;
  y: number;
  w: number;
  d: number;
  // Dimensions MINIMALES telles que saisies pour cette pièce à la
  // génération — conservées sur la pièce elle-même (pas redéduites d'un
  // préréglage par type, l'utilisateur a pu les personnaliser) pour que le
  // redimensionnement en édition respecte la même limite.
  minW: number;
  minD: number;
  exteriorWall: WallSide | null;
  // Porte véhicule directe vers la façade d'accès (garage uniquement) — un
  // couloir intérieur ne peut jamais la remplacer. Toujours vers l'extérieur
  // par nature — conservée sur la pièce (pas dans Layout.doors) car
  // conceptuellement distincte d'une porte de circulation intérieure
  // piétonne, et sans ambiguïté possible sur l'espace qu'elle rejoint.
  vehicleDoor: DoorGeometry | null;
  // Mise de côté dans la zone de rangement temporaire (hors du terrain) :
  // x/y n'ont alors aucun sens géométrique, la pièce est exclue des
  // surfaces bâties, du contour (footprint) et du graphe de circulation —
  // jamais comptée deux fois ni comme obstacle à un autre placement. Sa
  // porte est retirée en même temps (voir parkRoom) : une liaison vers un
  // mur qui n'existe plus une fois la pièce hors du terrain serait fictive.
  parked?: boolean;
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
  // Conservée pour recalculer le contour bâti (footprint) après un
  // déplacement de pièce en édition — sans elle, computeExteriorSpaces ne
  // saurait plus quel côté est la façade d'accès.
  accessSide: AccessSide;
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
  streetDoor: DoorGeometry | null;
  entryDoor: DoorGeometry | null;
  rooms: PlacedRoom[];
  // Portes intérieures — objets INDÉPENDANTS des pièces (voir Door) : une
  // pièce peut en avoir plusieurs (une par mur au plus dans cette tranche),
  // et l'ouverture entre deux pièces n'existe qu'UNE fois ici, jamais
  // dupliquée d'un côté et de l'autre (voir placeDoor).
  doors: Door[];
  // Fenêtres — objets INDÉPENDANTS des portes, une pièce peut en avoir
  // plusieurs (une par mur extérieur touché au plus dans cette tranche).
  windows: Window[];
  exteriorSpaces: ExteriorSpace[];
  surfaces: {
    terrain: number;
    emprise: number;
    // Cour d'entrée, bâti et reste de l'emprise sont mutuellement exclusifs
    // ici : leur somme (+ emprise non répartie éventuelle) vaut exactement
    // `emprise`, jamais un recouvrement compté deux fois.
    cour: number;
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
    accessSide: input.accessSide,
    terrain,
    emprise: null,
    footprint: null,
    corridor: null,
    corridorFillers: [],
    courtyard: null,
    streetDoor: null,
    entryDoor: null,
    rooms: [],
    doors: [],
    windows: [],
    exteriorSpaces: [],
    surfaces: { terrain: input.terrainWidth * input.terrainDepth, emprise: 0, batie: 0, utileHabitable: 0, circulation: 0, exterieure: 0, cour: 0 },
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
  const doors: Door[] = [];
  const windows: Window[] = [];
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
      const doorWall: WallSide = side === "left" ? "right" : "left";
      if (cr.depth < DOOR_WIDTH) {
        doorFailures.push(`« ${need.label} » : profondeur ${cr.depth.toFixed(2)} m insuffisante pour une porte (${DOOR_WIDTH} m).`);
      }
      const roomIndex = rooms.length;
      rooms.push({
        type: need.type,
        label: need.label,
        number: numberWithin(needsArr, i, need.type),
        x,
        y: cursorY,
        w: cr.width,
        d: cr.depth,
        minW: need.minWidth,
        minD: need.minDepth,
        exteriorWall,
        vehicleDoor: null,
      });
      doors.push({
        roomIndex,
        wall: doorWall,
        cx: innerX,
        cy: cursorY + cr.depth / 2,
        width: Math.min(DOOR_WIDTH, cr.depth),
        to: { kind: "circulation" },
      });
      windows.push({
        roomIndex,
        wall: exteriorWall,
        cx: exteriorWall === "left" ? x : x + cr.width,
        cy: cursorY + cr.depth / 2,
        width: cr.depth * 0.5,
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

  const entryDoor: DoorGeometry = { wall: "top", cx: corridor.x + corridor.w / 2, cy: footprint.y, width: DOOR_WIDTH };

  const terrainOut = terrain;
  const empriseOut = emprise;
  let footprintOut = footprint;
  let corridorOut = corridor;
  let corridorFillersOut = corridorFillers;
  let entryDoorOut = entryDoor;
  let roomsOut = rooms;
  let doorsOut = doors;
  let windowsOut = windows;

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
        vehicleDoor: r.vehicleDoor ? { ...r.vehicleDoor, wall: "bottom" as WallSide, cy: mirrorCy(r.vehicleDoor.cy) } : null,
      };
    });
    doorsOut = doors.map((d) => ({ ...d, cy: mirrorCy(d.cy) }));
    windowsOut = windows.map((w) => ({ ...w, cy: mirrorCy(w.cy) }));
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
    accessSide: input.accessSide,
    terrain: terrainOut,
    emprise: empriseOut,
    footprint: footprintOut,
    corridor: corridorOut,
    corridorFillers: corridorFillersOut,
    courtyard: null,
    streetDoor: null,
    entryDoor: entryDoorOut,
    rooms: roomsOut,
    doors: doorsOut,
    windows: windowsOut,
    exteriorSpaces: computeExteriorSpaces(terrainOut, empriseOut, footprintOut, input.accessSide),
    surfaces: computeSurfaces(terrainOut, empriseOut, footprintOut, corridorOut, corridorFillersOut, roomsOut, null),
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
    accessSide: input.accessSide,
    terrain,
    emprise: null,
    footprint: null,
    corridor: null,
    corridorFillers: [],
    courtyard: null,
    streetDoor: null,
    entryDoor: null,
    rooms: [],
    doors: [],
    windows: [],
    exteriorSpaces: [],
    surfaces: { terrain: input.terrainWidth * input.terrainDepth, emprise: 0, batie: 0, utileHabitable: 0, circulation: 0, exterieure: 0, cour: 0 },
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
  const doors: Door[] = [...lower.doors];
  const windows: Window[] = [...lower.windows];
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
    // Index prévu du salon — connu à l'avance car les 3 pièces ci-dessous
    // sont poussées dans un ordre fixe (gauche, droite, salon).
    const salonIndex = rooms.length + (leftSlot ? 1 : 0) + (rightSlot ? 1 : 0);

    if (leftSlot) {
      const d = Math.min(sizeFor(leftSlot.targetDepth, leftSlot.minDepth), salonDepth);
      if (d < leftSlot.minDepth) {
        return fail([`Profondeur insuffisante dans cette disposition pour « ${leftSlot.label} » à côté du salon (${d.toFixed(2)} m < ${leftSlot.minDepth.toFixed(2)} m minimum).`]);
      }
      const w = leftSlotWidth;
      const x = realEmprise.x + WALL_EXT;
      const roomIndex = rooms.length;
      rooms.push({ type: leftSlot.type, label: leftSlot.label, number: 1, x, y: salonY, w, d, minW: leftSlot.minWidth, minD: leftSlot.minDepth, exteriorWall: "left", vehicleDoor: null });
      doors.push({ roomIndex, wall: "right", cx: x + w, cy: salonY + d / 2, width: Math.min(DOOR_WIDTH, d), to: { kind: "room", index: salonIndex } });
      windows.push({ roomIndex, wall: "left", cx: x, cy: salonY + d / 2, width: d * 0.5 });
    }
    if (rightSlot) {
      const d = Math.min(sizeFor(rightSlot.targetDepth, rightSlot.minDepth), salonDepth);
      if (d < rightSlot.minDepth) {
        return fail([`Profondeur insuffisante dans cette disposition pour « ${rightSlot.label} » à côté du salon (${d.toFixed(2)} m < ${rightSlot.minDepth.toFixed(2)} m minimum).`]);
      }
      const w = rightSlotWidth;
      const x = realEmprise.x + footprintW - WALL_EXT - w;
      const roomIndex = rooms.length;
      rooms.push({ type: rightSlot.type, label: rightSlot.label, number: leftSlot?.type === rightSlot.type ? 2 : 1, x, y: salonY, w, d, minW: rightSlot.minWidth, minD: rightSlot.minDepth, exteriorWall: "right", vehicleDoor: null });
      doors.push({ roomIndex, wall: "left", cx: x, cy: salonY + d / 2, width: Math.min(DOOR_WIDTH, d), to: { kind: "room", index: salonIndex } });
      windows.push({ roomIndex, wall: "right", cx: x + w, cy: salonY + d / 2, width: d * 0.5 });
    }
    const salonRoomIndex = rooms.length;
    rooms.push({ type: salonNeed.type, label: salonNeed.label, number: 1, x: salonX, y: salonY, w: salonWidth, d: salonDepth, minW: salonNeed.minWidth, minD: salonNeed.minDepth, exteriorWall: "top", vehicleDoor: null });
    // Le salon n'a pas de porte propre dans Layout.doors : son entrée EST
    // l'entrée du bâti (entryDoor ci-dessous), jamais une seconde porte
    // dupliquant la même baie sous un autre nom.
    windows.push({ roomIndex: salonRoomIndex, wall: "top", cx: salonX + salonWidth / 2, cy: salonY, width: salonWidth * 0.5 });
  }

  const courtyard: Rect | null = courtyardDepth > 0 ? { x: realEmprise.x, y: F, w: footprintW, d: courtyardDepth } : null;
  const streetDoor: DoorGeometry | null = courtyard ? { wall: "top", cx: courtyard.x + courtyard.w / 2, cy: F, width: DOOR_WIDTH } : null;

  const combinedFootprint: Rect = {
    x: lower.footprint.x,
    y: F + courtyardDepth,
    w: footprintW,
    d: lower.footprint.y + lower.footprint.d - (F + courtyardDepth),
  };

  const entryDoor: DoorGeometry = salonRect
    ? { wall: "top", cx: salonRect.x + salonRect.w / 2, cy: salonRect.y, width: DOOR_WIDTH }
    : lower.entryDoor!;

  return {
    variantLabel: label,
    feasible: true,
    failureReasons: [],
    rejected: false,
    rejectionReasons: [],
    accessSide: input.accessSide,
    terrain,
    emprise: realEmprise,
    footprint: combinedFootprint,
    corridor: lower.corridor,
    corridorFillers: [...lower.corridorFillers, ...extraFillers],
    courtyard,
    streetDoor,
    entryDoor,
    rooms,
    doors,
    windows,
    exteriorSpaces: computeExteriorSpaces(terrain, realEmprise, combinedFootprint, input.accessSide),
    surfaces: computeSurfaces(terrain, realEmprise, combinedFootprint, lower.corridor, lower.corridorFillers, rooms, courtyard),
  };
}

function computeExteriorSpaces(terrain: Rect, emprise: Rect, footprint: Rect, accessSide: AccessSide): ExteriorSpace[] {
  // Utilise les bords RÉELS du bâti (footprint.y/footprint.x), jamais ceux de
  // l'emprise directement : avec une cour d'entrée, footprint.y est décalé
  // de la profondeur de cour par rapport à emprise.y — les confondre plaçait
  // ce rectangle "libre" par-dessus des pièces réelles (chevauchement visuel
  // détecté à la revue, corrigé ici).
  const spaces: ExteriorSpace[] = [];
  const backEdge = footprint.y + footprint.d;
  const empriseBackEdge = emprise.y + emprise.d;
  const remainingD = empriseBackEdge - backEdge;
  if (remainingD > 0.5) {
    spaces.push({
      label: "Espace extérieur non bâti (reste de l'emprise, distinct de la cour d'entrée)",
      rect: { x: emprise.x, y: backEdge, w: emprise.w, d: remainingD },
      accessFrom: accessSide === "back" ? "façade d'accès" : "arrière de la parcelle",
    });
  }
  const remainingW = emprise.w - footprint.w;
  if (remainingW > 0.5) {
    spaces.push({
      label: "Espace extérieur non bâti (latéral)",
      rect: { x: emprise.x + footprint.w, y: footprint.y, w: remainingW, d: footprint.d },
      accessFrom: "façade latérale",
    });
  }
  return spaces;
}

function computeSurfaces(terrain: Rect, emprise: Rect, footprint: Rect, corridor: Rect, fillers: Rect[], rooms: PlacedRoom[], courtyard: Rect | null) {
  const habitable = rooms.reduce((s, r) => s + r.w * r.d, 0);
  const circulation = corridor.w * corridor.d + fillers.reduce((s, f) => s + f.w * f.d, 0);
  const batie = footprint.w * footprint.d;
  const empriseArea = emprise.w * emprise.d;
  const courArea = courtyard ? courtyard.w * courtyard.d : 0;
  return {
    terrain: terrain.w * terrain.d,
    emprise: empriseArea,
    cour: courArea,
    batie,
    utileHabitable: habitable,
    // La cour est exclue d'ici (comptée une seule fois, séparément) — jamais
    // dans le "reste" ET dans "cour" à la fois.
    exterieure: Math.max(0, empriseArea - batie - courArea),
    circulation,
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
function wallTouchesExterior(rect: Rect, footprint: Rect, wall: WallSide): boolean {
  switch (wall) {
    case "left":
      return Math.abs(rect.x - footprint.x - WALL_EXT) < 1e-3;
    case "right":
      return Math.abs(footprint.x + footprint.w - (rect.x + rect.w) - WALL_EXT) < 1e-3;
    case "top":
      return Math.abs(rect.y - footprint.y - WALL_EXT) < 1e-3;
    case "bottom":
      return Math.abs(footprint.y + footprint.d - (rect.y + rect.d) - WALL_EXT) < 1e-3;
  }
}

// Un mur quelconque de la pièce touche l'extérieur (sert à la règle "pas de
// chambre/salon sans ouverture extérieure représentée" — une fenêtre peut
// être sur un mur différent de la porte, donc on regarde les 4 murs ici).
function hasExteriorTouch(r: PlacedRoom, footprint: Rect): boolean {
  return (["left", "right", "top", "bottom"] as WallSide[]).some((w) => wallTouchesExterior(r, footprint, w));
}

// La baie ELLE-MÊME (son propre mur, pas un autre mur de la pièce) débouche
// sur l'extérieur — condition différente et plus stricte que hasExteriorTouch,
// nécessaire pour valider qu'une porte ou une fenêtre étiquetée "extérieure"
// en est vraiment une après un déplacement de pièce.
function openingLeadsOutside(layout: Layout, roomIndex: number, wall: WallSide): boolean {
  const room = layout.rooms[roomIndex];
  return !!room && !!layout.footprint && wallTouchesExterior(roomRect(room), layout.footprint, wall);
}

export function doorsOf(layout: Layout, roomIndex: number): Door[] {
  return layout.doors.filter((d) => d.roomIndex === roomIndex);
}

export function windowsOf(layout: Layout, roomIndex: number): Window[] {
  return layout.windows.filter((w) => w.roomIndex === roomIndex);
}

// Tous les rectangles classés "circulation" — corridor principal ET
// raccords. Un seul réseau identifié dans cette tranche (voir SpaceRef) ;
// plusieurs réseaux distincts sont un travail de moteur ultérieur, pas un
// changement de ce type.
export function circulationSpaces(layout: Layout): Rect[] {
  const spaces: Rect[] = [];
  if (layout.corridor) spaces.push(layout.corridor);
  spaces.push(...layout.corridorFillers);
  return spaces;
}

// Résout une SpaceRef en son rectangle réel actuel — jamais une position
// figée : toujours relu depuis layout.rooms/courtyard au moment de l'appel.
// null pour "exterior" (pas de rectangle, un mur du bâti n'est pas un espace).
export function spaceRect(layout: Layout, ref: SpaceRef): Rect | null {
  if (ref.kind === "room") return layout.rooms[ref.index] ? roomRect(layout.rooms[ref.index]) : null;
  if (ref.kind === "courtyard") return layout.courtyard;
  if (ref.kind === "circulation") return null; // plusieurs rectangles possibles, voir circulationSpaces
  return null;
}

// Graphe d'accessibilité RÉEL depuis l'entrée : nœuds = circulation, salon
// (s'il existe, simple pièce de type "salon" — plus de marqueur ad hoc) et
// chaque pièce ; arêtes = portes réellement adjacentes ET réellement
// utilisables. Un graphe connecté seul ne prouve rien : chaque arête exige
// ICI une largeur de porte suffisante (DOOR_WIDTH) EN PLUS du contact
// géométrique réel (doorOutsideProbe) — une porte trop étroite ou mal
// positionnée après un déplacement ne "connecte" jamais silencieusement.
// Une pièce reliée uniquement à une AUTRE pièce n'est atteinte que si cette
// autre pièce l'est elle-même — sinon deux pièces isolées ensemble du reste
// du logement se déclareraient accessibles l'une l'autre à tort.
export function computeReachableRooms(layout: Layout): Set<number> {
  const reached = new Set<number>();
  if (!layout.corridor) return reached;
  const salonIndex = layout.rooms.findIndex((r) => r.type === "salon");
  const salonRect = salonIndex >= 0 ? roomRect(layout.rooms[salonIndex]) : null;
  const salonTouchesCorridor = salonRect ? rectsAdjacent(salonRect, layout.corridor) : false;
  const circulation = circulationSpaces(layout);
  const usableDoors = layout.doors.filter((d) => d.width >= DOOR_WIDTH - 1e-6);
  const genuinelyTouches = (d: Door, target: Rect) => rectsOverlap(doorOutsideProbe(d), target);

  const infraQueue: ("corridor" | "salon")[] = [];
  if (layout.entryDoor) infraQueue.push(salonRect ? "salon" : "corridor");

  const roomQueue: number[] = [];
  const pushRoomsConnectedTo = (node: "corridor" | "salon") => {
    for (const d of usableDoors) {
      if (d.roomIndex === salonIndex) continue;
      const reachesNode =
        node === "salon"
          ? d.to.kind === "room" && d.to.index === salonIndex && !!salonRect && genuinelyTouches(d, salonRect)
          : d.to.kind === "circulation" && circulation.some((c) => genuinelyTouches(d, c));
      if (reachesNode) roomQueue.push(d.roomIndex);
    }
  };

  const infraReached = new Set<"corridor" | "salon">();
  while (infraQueue.length || roomQueue.length) {
    while (infraQueue.length) {
      const node = infraQueue.shift()!;
      if (infraReached.has(node)) continue;
      infraReached.add(node);
      if (node === "salon" && salonIndex >= 0) {
        reached.add(salonIndex);
        if (salonTouchesCorridor) infraQueue.push("corridor");
      }
      if (node === "corridor" && salonTouchesCorridor) infraQueue.push("salon");
      pushRoomsConnectedTo(node);
    }
    while (roomQueue.length) {
      const i = roomQueue.shift()!;
      if (reached.has(i)) continue;
      reached.add(i);
      for (const d of usableDoors) {
        if (d.roomIndex === i && d.to.kind === "room" && genuinelyTouches(d, roomRect(layout.rooms[d.to.index]))) {
          roomQueue.push(d.to.index);
        }
        if (d.to.kind === "room" && d.to.index === i && genuinelyTouches(d, roomRect(layout.rooms[i]))) {
          roomQueue.push(d.roomIndex);
        }
      }
    }
  }
  // Toute pièce avec une entrée extérieure propre est atteignable même sans
  // chemin par la circulation/le salon (accès direct depuis dehors).
  for (const d of usableDoors) {
    if (d.to.kind === "exterior" && openingLeadsOutside(layout, d.roomIndex, d.wall)) reached.add(d.roomIndex);
  }
  return reached;
}

export function independentVerify(layout: Layout): VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  if (!layout.feasible || !layout.footprint || !layout.emprise || !layout.corridor) return issues;

  // Une pièce mise de côté (zone de rangement) est volontairement hors du
  // terrain : son incomplétude est signalée séparément (compteur de pièces
  // non placées), jamais mêlée ici aux vrais défauts géométriques d'une
  // pièce réellement posée.
  const activeRooms = layout.rooms.filter((r) => !r.parked);

  // 1) Chaque pièce dans l'emprise.
  for (const r of activeRooms) {
    if (!rectWithin(roomRect(r), layout.emprise)) {
      issues.push({ severity: "error", message: `« ${r.label} ${r.number} » sort de l'emprise disponible.` });
    }
  }
  // 2) Aucun chevauchement : pièce-pièce, pièce-corridor, pièce-raccord.
  const allBlocks: { label: string; rect: Rect }[] = [
    ...activeRooms.map((r) => ({ label: `${r.label} ${r.number}`, rect: roomRect(r) })),
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
  for (const r of activeRooms) {
    if (!hasExteriorTouch(r, layout.footprint)) {
      issues.push({ severity: "warning", message: `« ${r.label} ${r.number} » n'a aucune ouverture extérieure possible (pièce entièrement intérieure).` });
    }
  }
  // 3bis) Fenêtre INDÉPENDANTE : chaque fenêtre est revérifiée sur SON PROPRE
  // mur (pas seulement "la pièce touche l'extérieur quelque part") — une
  // fenêtre laissée sur un mur devenu intérieur après un déplacement de
  // pièce est une incohérence signalée, jamais masquée ni recalée en
  // silence sur un autre mur.
  const activeIndexSet = new Set(layout.rooms.map((r, i) => i).filter((i) => !layout.rooms[i].parked));
  for (const w of layout.windows) {
    if (!activeIndexSet.has(w.roomIndex)) continue;
    const room = layout.rooms[w.roomIndex];
    if (!openingLeadsOutside(layout, w.roomIndex, w.wall)) {
      issues.push({ severity: "error", message: `« ${room.label} ${room.number} » : une fenêtre ne débouche plus sur un mur extérieur réel après déplacement.` });
    }
  }
  // 4) Porte : présence et largeur réelle revérifiées, pour CHAQUE porte
  // d'une pièce (plusieurs portes possibles par pièce dans cette tranche).
  // Une pièce sans aucune porte (supprimée par l'éditeur, jamais recréée)
  // est signalée ici — jamais masquée ni implicitement refermée sans
  // avertissement. Le salon central est l'exception structurelle : sa
  // propre entrée EST layout.entryDoor (vérifié plus bas), jamais une
  // seconde porte dupliquant la même baie dans Layout.doors.
  const activeDoors = layout.doors.filter((d) => activeIndexSet.has(d.roomIndex));
  const salonForDoorCheck = activeRooms.find((r) => r.type === "salon");
  for (const r of activeRooms) {
    if (r === salonForDoorCheck) continue;
    const i = layout.rooms.indexOf(r);
    const doors = activeDoors.filter((d) => d.roomIndex === i);
    if (doors.length === 0) {
      issues.push({ severity: "error", message: `« ${r.label} ${r.number} » n'a aucune porte : pièce inaccessible.` });
      continue;
    }
    for (const d of doors) {
      if (d.width < DOOR_WIDTH - 1e-6) {
        issues.push({ severity: "error", message: `« ${r.label} ${r.number} » : porte de ${d.width.toFixed(2)} m insuffisante (${DOOR_WIDTH} m requis).` });
      }
    }
  }
  // 4bis) Battant : le carré balayé (même géométrie que le rendu, voir
  // doorSwingRect) ne doit rencontrer NI un mur (rester entièrement dans la
  // pièce qu'il dessert) NI un autre battant — pas seulement ne pas déborder
  // dans une pièce voisine : deux battants pourraient se croiser dans un
  // renfoncement sans qu'aucun ne "déborde" dans la pièce de l'autre.
  for (const d of activeDoors) {
    const room = layout.rooms[d.roomIndex];
    const swing = doorSwingRect(d);
    if (!rectWithin(swing, roomRect(room), 1e-2)) {
      issues.push({ severity: "error", message: `« ${room.label} ${room.number} » : le battant d'une porte rencontre un mur (balayage hors de la pièce).` });
    }
  }
  for (let i = 0; i < activeDoors.length; i++) {
    for (let j = i + 1; j < activeDoors.length; j++) {
      const a = activeDoors[i], b = activeDoors[j];
      if (rectsOverlap(doorSwingRect(a), doorSwingRect(b))) {
        const ra = layout.rooms[a.roomIndex], rb = layout.rooms[b.roomIndex];
        issues.push({ severity: "error", message: `Les battants de portes de « ${ra.label} ${ra.number} » et « ${rb.label} ${rb.number} » se croisent.` });
      }
    }
  }
  // 5) Accessibilité RÉELLE depuis l'entrée — graphe construit à partir des
  // adjacences géométriques effectives (porte + contact réel), pas d'un
  // simple contact de boîtes englobantes ni d'une hypothèse de construction.
  // Deux pièces qui se touchent ne sont pas nécessairement communicantes :
  // chaque porte n'est considérée reliée QU'À l'espace qu'elle désigne
  // (Door.to), jamais par simple proximité.
  const eps = ADJACENCY_TOLERANCE;
  const salonRoom = activeRooms.find((r) => r.type === "salon") ?? null;
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

  // Vérification immédiate (contact réel, jamais supposé) de CHAQUE porte
  // avec l'espace qu'elle désigne (Door.to). Sonde la baie ELLE-MÊME
  // (doorOutsideProbe), pas seulement le contour englobant de la pièce :
  // après un déplacement, la pièce peut encore chevaucher légèrement
  // l'espace visé sans que la porte s'y trouve réellement — un simple
  // contact de boîtes ne suffit pas à garantir une ouverture réelle. Une
  // largeur insuffisante (déjà signalée au contrôle 4) rend aussi le
  // passage non réellement utilisable ici — voir le contrôle 5bis
  // transitif, qui exclut ces portes du graphe.
  for (const d of activeDoors) {
    const r = layout.rooms[d.roomIndex];
    if (r === salonRoom) continue;
    const probe = doorOutsideProbe(d);
    if (d.to.kind === "room") {
      const target = layout.rooms[d.to.index];
      // Une pièce voisine mise de côté entre-temps n'est plus réellement là :
      // sa position figée avant rangement ne doit jamais valider par erreur
      // une liaison devenue fictive.
      if (!target || target.parked || !rectsOverlap(probe, roomRect(target))) {
        issues.push({ severity: "error", message: `« ${r.label} ${r.number} » : une porte vers une pièce voisine ne débouche sur aucun espace réellement adjacent.` });
      }
    } else if (d.to.kind === "exterior") {
      if (!openingLeadsOutside(layout, d.roomIndex, d.wall)) {
        issues.push({ severity: "error", message: `« ${r.label} ${r.number} » : une entrée extérieure déclarée ne débouche pas sur un mur extérieur réel.` });
      }
    } else if (d.to.kind === "courtyard") {
      if (!layout.courtyard || !rectsOverlap(probe, layout.courtyard)) {
        issues.push({ severity: "error", message: `« ${r.label} ${r.number} » : une porte vers la cour ne débouche sur aucune cour réelle.` });
      }
    } else {
      const touches = circulationSpaces(layout).some((c) => rectsOverlap(probe, c));
      if (!touches) {
        issues.push({ severity: "error", message: `« ${r.label} ${r.number} » n'est reliée au dégagement par aucune ouverture réelle : accès non garanti.` });
      }
    }
  }

  // Accessibilité TRANSITIVE réelle : une pièce reliée à une AUTRE pièce
  // n'est réellement accessible que si cette autre pièce l'est elle-même
  // depuis l'entrée — un graphe, pas une simple vérification pièce par
  // pièce (sinon deux pièces reliées entre elles mais coupées du reste du
  // logement se déclareraient mutuellement accessibles à tort). Le graphe
  // lui-même (computeReachableRooms) exige déjà une largeur de porte
  // réellement utilisable sur chaque arête — un graphe connecté seul ne
  // suffit jamais ici.
  const reachable = computeReachableRooms(layout);
  for (const r of activeRooms) {
    const i = layout.rooms.indexOf(r);
    if (r === salonRoom || activeDoors.filter((d) => d.roomIndex === i).length === 0) continue;
    if (!reachable.has(i)) {
      issues.push({ severity: "error", message: `« ${r.label} ${r.number} » n'est pas réellement accessible depuis l'entrée (chaîne de portes incomplète, ou largeur de passage insuffisante).` });
    }
  }
  // 6) Accès véhicule pour un garage — un couloir intérieur, même relié,
  // n'est jamais accepté comme substitut. PORTÉE EXACTE de ce contrôle :
  // vérifie qu'un trajet en LIGNE DROITE, dégagé de tout obstacle modélisé
  // (aucune pièce, aucun mur), relie la limite d'accès de l'emprise à la
  // porte du garage, et rapporte la largeur réellement disponible pour ce
  // trajet (r.vehicleDoor.width, plafonnée à la largeur de la pièce). Le
  // dégagement découle de la construction (aucune autre pièce ne peut
  // occuper ce même segment de mur, déjà revérifié par l'absence de
  // chevauchement du contrôle 2) — CE N'EST PAS une simulation de manœuvre
  // automobile (rayon de braquage, pente, obstacles hors du modèle comme un
  // arbre ou un poteau ne sont jamais pris en compte).
  for (const r of activeRooms) {
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

// ---- Éditeur — fonctions pures sur une copie de travail (Layout) ----
// Aucune ne modifie son argument ; chacune renvoie soit une NOUVELLE copie
// (succès), soit `null` (geste refusé — jamais un résultat partiel ou une
// correction silencieuse d'une autre pièce pour "faire rentrer" le geste).

export function cloneLayout(layout: Layout): Layout {
  return JSON.parse(JSON.stringify(layout)) as Layout;
}

// Recalcule le contour bâti (footprint), les espaces extérieurs et les
// surfaces à partir des positions RÉELLES actuelles des pièces — jamais un
// rectangle figé depuis la génération. Utilisé après un déplacement pour
// que la pièce puisse aller au-delà de l'ancien contour, dans le reste de
// l'emprise constructible.
function recomputeDerivedGeometry(layout: Layout): Layout {
  const next = cloneLayout(layout);
  if (!next.corridor) return next;
  // Une pièce mise de côté (parked) n'occupe aucune place réelle : exclue du
  // contour bâti et des surfaces, jamais comptée comme si elle était posée.
  const activeRooms = next.rooms.filter((r) => !r.parked);
  const rects: Rect[] = [next.corridor, ...next.corridorFillers, ...activeRooms.map(roomRect)];
  const minX = Math.min(...rects.map((r) => r.x)) - WALL_EXT;
  const minY = Math.min(...rects.map((r) => r.y)) - WALL_EXT;
  const maxX = Math.max(...rects.map((r) => r.x + r.w)) + WALL_EXT;
  const maxY = Math.max(...rects.map((r) => r.y + r.d)) + WALL_EXT;
  const footprint: Rect = { x: minX, y: minY, w: maxX - minX, d: maxY - minY };
  next.footprint = footprint;
  if (next.emprise) {
    next.exteriorSpaces = computeExteriorSpaces(next.terrain, next.emprise, footprint, next.accessSide);
    next.surfaces = computeSurfaces(next.terrain, next.emprise, footprint, next.corridor, next.corridorFillers, activeRooms, next.courtyard);
  }
  return next;
}

// Un candidat (nouvelle position d'une pièce) rencontre-t-il un obstacle
// réel — corridor, raccord, cour, ou une AUTRE pièce non rangée. Les pièces
// mises de côté ne bloquent jamais un placement : elles ne sont plus sur le
// terrain. Partagé par tryMoveRoom et placeParkedRoom pour ne jamais avoir
// deux définitions de "chevauchement" qui pourraient diverger.
function roomBlocksAt(layout: Layout, excludeIndex: number, candidate: Rect): boolean {
  const blockers: Rect[] = [layout.corridor, layout.courtyard, ...layout.corridorFillers].filter((r): r is Rect => r !== null);
  if (blockers.some((b) => rectsOverlap(candidate, b))) return true;
  for (let i = 0; i < layout.rooms.length; i++) {
    if (i === excludeIndex || layout.rooms[i].parked) continue;
    if (rectsOverlap(candidate, roomRect(layout.rooms[i]))) return true;
  }
  return false;
}

// Déplace une pièce en conservant EXACTEMENT ses dimensions (w, d inchangés)
// et sa porte/fenêtre attachées (translatées avec elle — si la pièce quitte
// son mur d'origine, la vérification indépendante le détectera ensuite,
// jamais corrigé ici). Contrainte à l'EMPRISE constructible entière (pas
// seulement l'ancien contour bâti) : les reculs et la cour, exclus de
// l'emprise ou explicitement réservés, restent protégés. Refuse tout
// chevauchement (pièce, corridor, raccord, cour) — jamais un déplacement
// partiel des autres éléments pour forcer le résultat. Le contour et les
// surfaces sont recalculés après un déplacement réussi.
export function tryMoveRoom(layout: Layout, roomIndex: number, newX: number, newY: number): Layout | null {
  const room = layout.rooms[roomIndex];
  if (!room || !layout.emprise || room.parked) return null;
  const candidate: Rect = { x: newX, y: newY, w: room.w, d: room.d };
  if (!rectWithin(candidate, layout.emprise)) return null;
  if (roomBlocksAt(layout, roomIndex, candidate)) return null;
  const dx = newX - room.x;
  const dy = newY - room.y;
  let next = cloneLayout(layout);
  const r = next.rooms[roomIndex];
  r.x = newX;
  r.y = newY;
  // Les portes/fenêtres de CETTE pièce la suivent (translatées) — si elle
  // quitte son mur d'origine, la vérification indépendante le détectera
  // ensuite, jamais corrigé ici. Les portes d'AUTRES pièces qui la visent
  // (Door.to) ne bougent pas : leur adjacence réelle est revérifiée depuis
  // la nouvelle position de cette pièce, pas depuis un flag mis à jour ici.
  for (const d of next.doors) {
    if (d.roomIndex === roomIndex) {
      d.cx += dx;
      d.cy += dy;
    }
  }
  for (const w of next.windows) {
    if (w.roomIndex === roomIndex) {
      w.cx += dx;
      w.cy += dy;
    }
  }
  if (r.vehicleDoor) {
    r.vehicleDoor.cx += dx;
    r.vehicleDoor.cy += dy;
  }
  next = recomputeDerivedGeometry(next);
  return next;
}

// Recalcule la position d'une ouverture (porte/fenêtre) de CETTE pièce
// après un redimensionnement : son mur reste le même repère relatif (son
// coordonnée fixe suit le bord concerné), sa position le long du mur est
// resserrée dans les nouvelles limites, sa largeur est réduite si le mur
// est devenu trop court pour la contenir telle quelle — jamais supprimée
// silencieusement : une largeur résultante insuffisante reste un défaut
// signalé (contrôle existant), pas masqué ici.
function recalcOpeningForResize<T extends { wall: WallSide; cx: number; cy: number; width: number }>(o: T, room: Rect): T {
  const vertical = o.wall === "left" || o.wall === "right";
  const span = vertical ? room.d : room.w;
  const width = Math.max(0, Math.min(o.width, span));
  const fixedCoord = o.wall === "right" ? room.x + room.w : o.wall === "left" ? room.x : o.wall === "bottom" ? room.y + room.d : room.y;
  const axisMin = (vertical ? room.y : room.x) + width / 2;
  const axisMax = (vertical ? room.y + room.d : room.x + room.w) - width / 2;
  const along = vertical ? o.cy : o.cx;
  const clamped = axisMax < axisMin ? (axisMin + axisMax) / 2 : Math.min(Math.max(along, axisMin), axisMax);
  return { ...o, width, cx: vertical ? fixedCoord : clamped, cy: vertical ? clamped : fixedCoord };
}

// Redimensionne une pièce — même esprit que tryMoveRoom : refuse tout
// (minimums définis à la génération, emprise, chevauchement) ou rien,
// jamais un résultat partiel. Les portes/fenêtres de CETTE pièce sont
// recalculées sur sa nouvelle géométrie (jamais translatées comme pour un
// déplacement, puisque la forme change, pas seulement la position). Les
// portes d'AUTRES pièces qui la visent ne sont jamais touchées ici : leur
// adjacence réelle est revérifiée depuis la nouvelle géométrie par
// independentVerify, qui signale sans jamais corriger silencieusement.
export function resizeRoom(layout: Layout, roomIndex: number, newX: number, newY: number, newW: number, newD: number): Layout | null {
  const room = layout.rooms[roomIndex];
  if (!room || !layout.emprise || room.parked) return null;
  if (newW < room.minW - 1e-6 || newD < room.minD - 1e-6) return null;
  if (newW <= 0 || newD <= 0) return null;
  const candidate: Rect = { x: newX, y: newY, w: newW, d: newD };
  if (!rectWithin(candidate, layout.emprise)) return null;
  if (roomBlocksAt(layout, roomIndex, candidate)) return null;

  const next = cloneLayout(layout);
  const r = next.rooms[roomIndex];
  r.x = newX;
  r.y = newY;
  r.w = newW;
  r.d = newD;
  next.doors = next.doors.map((d) => (d.roomIndex === roomIndex ? recalcOpeningForResize(d, candidate) : d));
  next.windows = next.windows.map((w) => (w.roomIndex === roomIndex ? recalcOpeningForResize(w, candidate) : w));
  if (r.vehicleDoor) {
    r.vehicleDoor = recalcOpeningForResize(r.vehicleDoor, candidate);
  }
  return recomputeDerivedGeometry(next);
}

// Met une pièce de côté (zone de rangement temporaire) : identité, type,
// numéro et dimensions conservés à l'identique, mais la porte est retirée —
// un rattachement à un mur qui n'existe plus une fois la pièce hors du
// terrain serait fictif, jamais conservé. La pièce sort aussitôt des
// surfaces bâties, du contour et du graphe de circulation (recomputeDerived-
// Geometry, independentVerify) sans qu'aucun autre élément du plan ne
// bouge. Toujours réversible via l'historique Annuler/Rétablir, comme
// n'importe quel autre commit de l'éditeur.
export function parkRoom(layout: Layout, roomIndex: number): Layout {
  const next = cloneLayout(layout);
  const r = next.rooms[roomIndex];
  r.parked = true;
  r.vehicleDoor = null;
  // Les portes de CETTE pièce (Door.to) relient un espace réel du terrain :
  // fictives dès que la pièce en sort, donc retirées ici. Une porte d'une
  // AUTRE pièce qui la visait encore n'est PAS supprimée automatiquement :
  // devenue incohérente, elle est signalée comme telle par la vérification
  // indépendante (pièce cible "parked"), jamais corrigée en silence. Les
  // fenêtres restent attachées (pas de liaison à un autre espace) et seront
  // revérifiées sur leur propre mur au retour, jamais recréées ni perdues.
  next.doors = next.doors.filter((d) => d.roomIndex !== roomIndex);
  return recomputeDerivedGeometry(next);
}

// Replace une pièce mise de côté à la position donnée — exactement les
// mêmes contraintes qu'un déplacement normal (emprise constructible,
// chevauchements avec corridor/raccord/cour/autres pièces) : la zone de
// rangement n'est jamais un moyen détourné d'agrandir le terrain
// constructible. Aucune porte n'est recréée automatiquement : la pièce
// redevient "sans porte", à rattacher explicitement à un mur réel, comme
// n'importe quelle pièce nouvellement positionnée.
export function placeParkedRoom(layout: Layout, roomIndex: number, x: number, y: number): Layout | null {
  const room = layout.rooms[roomIndex];
  if (!room || !layout.emprise || !room.parked) return null;
  const candidate: Rect = { x, y, w: room.w, d: room.d };
  if (!rectWithin(candidate, layout.emprise)) return null;
  if (roomBlocksAt(layout, roomIndex, candidate)) return null;
  const dx = x - room.x;
  const dy = y - room.y;
  const next = cloneLayout(layout);
  const r = next.rooms[roomIndex];
  r.parked = false;
  r.x = x;
  r.y = y;
  // Les fenêtres suivent la pièce (translatées) — leur mur reste le même
  // repère relatif, revérifié frais contre le nouveau contour (voir
  // openingLeadsOutside), jamais réputé toujours extérieur sans contrôle.
  for (const w of next.windows) {
    if (w.roomIndex === roomIndex) {
      w.cx += dx;
      w.cy += dy;
    }
  }
  return recomputeDerivedGeometry(next);
}

// Referme réellement l'ouverture (door -> null) : la pièce redevient
// inaccessible tant qu'aucune porte n'est recréée — signalé par le contrôle
// 4 de independentVerify, jamais masqué.
export function removeDoor(layout: Layout, roomIndex: number, wall: WallSide): Layout {
  const next = cloneLayout(layout);
  next.doors = next.doors.filter((d) => !(d.roomIndex === roomIndex && d.wall === wall));
  return next;
}

export function flipDoorSwing(layout: Layout, roomIndex: number, wall: WallSide): Layout {
  const next = cloneLayout(layout);
  const d = next.doors.find((x) => x.roomIndex === roomIndex && x.wall === wall);
  if (d) d.flip = !d.flip;
  return next;
}

export type WallAdjacency = SpaceRef | { kind: "none" };

// Ce qu'il y a RÉELLEMENT de l'autre côté d'un mur donné d'une pièce — jamais
// une hypothèse de topologie. Sonde un petit rectangle juste au-delà du mur
// et regarde ce qu'il touche effectivement (mur extérieur du bâti en
// premier, sinon circulation/raccord, cour, ou une autre pièce précise — le
// salon n'est qu'une pièce de type "salon" comme une autre, aucun cas
// spécial). Une pièce mise de côté n'est jamais un espace réel de ce côté.
export function wallAdjacency(layout: Layout, roomIndex: number, wall: WallSide): WallAdjacency {
  const room = layout.rooms[roomIndex];
  if (!room || !layout.footprint) return { kind: "none" };
  const rect = roomRect(room);
  const fp = layout.footprint;
  const onExterior =
    (wall === "left" && Math.abs(rect.x - fp.x - WALL_EXT) < 1e-2) ||
    (wall === "right" && Math.abs(fp.x + fp.w - (rect.x + rect.w) - WALL_EXT) < 1e-2) ||
    (wall === "top" && Math.abs(rect.y - fp.y - WALL_EXT) < 1e-2) ||
    (wall === "bottom" && Math.abs(fp.y + fp.d - (rect.y + rect.d) - WALL_EXT) < 1e-2);
  if (onExterior) return { kind: "exterior" };

  const probeDepth = ADJACENCY_TOLERANCE;
  let probe: Rect;
  if (wall === "left") probe = { x: rect.x - probeDepth, y: rect.y, w: probeDepth, d: rect.d };
  else if (wall === "right") probe = { x: rect.x + rect.w, y: rect.y, w: probeDepth, d: rect.d };
  else if (wall === "top") probe = { x: rect.x, y: rect.y - probeDepth, w: rect.w, d: probeDepth };
  else probe = { x: rect.x, y: rect.y + rect.d, w: rect.w, d: probeDepth };

  // Un simple chevauchement de boîtes ne suffit pas : le raccord d'une
  // pièce voisine (fillerX/w = gap + WALL_INT, voir placeColumn) déborde de
  // l'épaisseur d'une cloison (WALL_INT) au-delà de sa propre ligne, ce qui
  // peut effleurer la sonde d'une pièce adjacente sur le mur du bas/haut
  // sans que cet espace soit réellement accessible depuis ce mur. On exige
  // un contact continu d'au moins une largeur de porte le long du mur.
  const touches = (target: Rect): boolean => {
    if (!rectsOverlap(probe, target)) return false;
    const along =
      wall === "left" || wall === "right"
        ? Math.min(probe.y + probe.d, target.y + target.d) - Math.max(probe.y, target.y)
        : Math.min(probe.x + probe.w, target.x + target.w) - Math.max(probe.x, target.x);
    return along >= DOOR_WIDTH - 1e-6;
  };

  if (layout.corridor && touches(layout.corridor)) return { kind: "circulation" };
  if (layout.corridorFillers.some(touches)) return { kind: "circulation" };
  if (layout.courtyard && touches(layout.courtyard)) return { kind: "courtyard" };
  for (let i = 0; i < layout.rooms.length; i++) {
    if (i === roomIndex || layout.rooms[i].parked) continue;
    if (touches(roomRect(layout.rooms[i]))) {
      return { kind: "room", index: i };
    }
  }
  return { kind: "none" };
}

// Pose (création ou déplacement, même geste) une porte sur le mur CHOISI de
// la pièce, à la position demandée le long de ce mur, resserrée dans ses
// limites. Refuse si ce mur ne mène nulle part de réel (wallAdjacency
// "none"), ou si le battant qui en résulterait rencontrerait un mur ou un
// autre battant (mêmes contrôles que la vérification indépendante, jamais un
// second calcul séparé). Une porte vers l'extérieur (mur du bâti) est
// distinguée explicitement d'une porte intérieure — jamais confondues.
export function placeDoor(layout: Layout, roomIndex: number, wall: WallSide, alongWallPosition: number): Layout | null {
  const room = layout.rooms[roomIndex];
  if (!room || room.parked) return null;
  const adjacency = wallAdjacency(layout, roomIndex, wall);
  if (adjacency.kind === "none") return null;

  // Ouverture UNIQUE entre deux pièces : si la pièce visée a DÉJÀ une porte
  // qui pointe en retour vers celle-ci, ce mur porte déjà le passage partagé
  // — jamais une seconde porte indépendante et potentiellement contradictoire
  // pour le même passage. Modifiez la porte existante depuis l'une ou
  // l'autre pièce plutôt que d'en recréer une seconde.
  if (adjacency.kind === "room") {
    const alreadyShared = layout.doors.some((d) => d.roomIndex === adjacency.index && d.to.kind === "room" && d.to.index === roomIndex);
    if (alreadyShared) return null;
  }

  const vertical = wall === "left" || wall === "right";
  const span = vertical ? room.d : room.w;
  const width = Math.min(DOOR_WIDTH, span);
  if (width < 1e-6) return null;
  const axisMin = (vertical ? room.y : room.x) + width / 2;
  const axisMax = (vertical ? room.y + room.d : room.x + room.w) - width / 2;
  if (axisMax < axisMin) return null;
  const clamped = Math.min(Math.max(alongWallPosition, axisMin), axisMax);
  const fixedCoord = wall === "right" ? room.x + room.w : wall === "left" ? room.x : wall === "bottom" ? room.y + room.d : room.y;
  const existing = layout.doors.find((d) => d.roomIndex === roomIndex && d.wall === wall);
  const candidateDoor: Door = {
    roomIndex,
    wall,
    cx: vertical ? fixedCoord : clamped,
    cy: vertical ? clamped : fixedCoord,
    width,
    to: adjacency,
    flip: existing?.flip ?? false,
  };

  const swing = doorSwingRect(candidateDoor);
  if (!rectWithin(swing, roomRect(room), 1e-2)) return null;
  for (const other of layout.doors) {
    if (other === existing) continue;
    if (rectsOverlap(swing, doorSwingRect(other))) return null;
  }

  const next = cloneLayout(layout);
  next.doors = next.doors.filter((d) => !(d.roomIndex === roomIndex && d.wall === wall));
  next.doors.push(candidateDoor);
  return next;
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

  // Clé de forme — SANS le numéro (dérivé, non significatif pour l'égalité)
  // et triée (l'ordre des pièces d'un même type est interchangeable). Un
  // second appel avec `mirror` calcule la MÊME clé pour le symétrique
  // gauche-droite de la disposition : une simple symétrie n'est pas une
  // organisation différente et ne doit pas compter comme une variante de
  // plus, contrairement à un vrai changement de regroupement des pièces.
  function layoutKey(layout: Layout, mirror: boolean): string {
    const fp = layout.footprint;
    const items = layout.rooms.map((r) => {
      const x = mirror && fp ? fp.x * 2 + fp.w - (r.x + r.w) : r.x;
      return `${r.type}|${x.toFixed(2)}|${r.y.toFixed(2)}|${r.w.toFixed(2)}|${r.d.toFixed(2)}`;
    });
    items.sort();
    return items.join(";");
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
    const key = layoutKey(layout, false);
    const mirrorKey = layoutKey(layout, true);
    if (seenKeys.has(key) || seenKeys.has(mirrorKey)) return;
    seenKeys.add(key);
    seenKeys.add(mirrorKey);

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
