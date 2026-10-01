// Document de projet versionné — distinct des exports visuels (SVG/PNG) :
// sérialise la géométrie COMPLÈTE et modifiable (terrain, pièces placées et
// mises de côté, portes, fenêtres) pour la sauvegarde locale et l'échange
// de fichier. Validé structurellement avant tout chargement (voir
// validateProjectFile) — jamais une confiance aveugle dans un JSON externe.
import type { Door, DoorGeometry, Layout, PlacedRoom, Rect, SpaceRef, WallSide, Window } from "./geometry";

export const PROJECT_FILE_VERSION = 1;

export interface ProjectFile {
  version: number;
  savedAt: string;
  orientation: string;
  layout: Layout;
}

const STORAGE_KEY = "chantierlive:prototype-plans:draft:v1";

export function serializeProject(layout: Layout, orientation: string): ProjectFile {
  return { version: PROJECT_FILE_VERSION, savedAt: new Date().toISOString(), orientation, layout };
}

export type SaveResult = { ok: true } | { ok: false; error: string };

// Sauvegarde locale UNIQUEMENT — reste dans ce navigateur, sur cet appareil,
// jamais transmise ni synchronisée. Un échec (stockage plein, navigation
// privée, quota dépassé) est rapporté explicitement, jamais annoncé comme
// un succès.
export function saveDraftLocally(file: ProjectFile): SaveResult {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(file));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Échec de l'écriture locale (stockage plein ou indisponible)." };
  }
}

export function loadDraftLocally(): { ok: true; value: ProjectFile } | { ok: false; error: string } | null {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Le brouillon enregistré localement est corrompu (JSON invalide)." };
  }
  return validateProjectFile(parsed);
}

export function clearDraftLocally(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Rien à faire : l'absence de stockage n'est pas une erreur à signaler
    // pour un simple nettoyage.
  }
}

// ---- Validation structurelle, référentielle et numérique ----
// Jamais une confiance aveugle dans un fichier importé ou relu du stockage
// local : structure, références (index de pièce dans les portes/fenêtres)
// et valeurs numériques (finies, pas NaN/Infinity) sont vérifiées avant
// qu'un seul champ ne soit utilisé.

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isRect(v: unknown): v is Rect {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return isFiniteNumber(r.x) && isFiniteNumber(r.y) && isFiniteNumber(r.w) && isFiniteNumber(r.d);
}

const WALL_SIDES: WallSide[] = ["left", "right", "top", "bottom"];
function isWallSide(v: unknown): v is WallSide {
  return typeof v === "string" && (WALL_SIDES as string[]).includes(v);
}

function isDoorGeometry(v: unknown): v is DoorGeometry {
  if (!v || typeof v !== "object") return false;
  const d = v as Record<string, unknown>;
  return isWallSide(d.wall) && isFiniteNumber(d.cx) && isFiniteNumber(d.cy) && isFiniteNumber(d.width);
}

function isSpaceRef(v: unknown, roomCount: number): v is SpaceRef {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  if (r.kind === "circulation" || r.kind === "courtyard" || r.kind === "exterior") return true;
  if (r.kind === "room") return isFiniteNumber(r.index) && Number.isInteger(r.index) && r.index >= 0 && r.index < roomCount;
  return false;
}

function isPlacedRoom(v: unknown): v is PlacedRoom {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.type === "string" &&
    typeof r.label === "string" &&
    isFiniteNumber(r.number) &&
    isFiniteNumber(r.x) &&
    isFiniteNumber(r.y) &&
    isFiniteNumber(r.w) &&
    r.w > 0 &&
    isFiniteNumber(r.d) &&
    r.d > 0 &&
    isFiniteNumber(r.minW) &&
    isFiniteNumber(r.minD) &&
    (r.exteriorWall === null || isWallSide(r.exteriorWall)) &&
    (r.vehicleDoor === null || isDoorGeometry(r.vehicleDoor)) &&
    (r.parked === undefined || typeof r.parked === "boolean")
  );
}

function isDoor(v: unknown, roomCount: number): v is Door {
  if (!v || typeof v !== "object") return false;
  const d = v as Record<string, unknown>;
  return (
    isFiniteNumber(d.roomIndex) &&
    Number.isInteger(d.roomIndex) &&
    d.roomIndex >= 0 &&
    d.roomIndex < roomCount &&
    isWallSide(d.wall) &&
    isFiniteNumber(d.cx) &&
    isFiniteNumber(d.cy) &&
    isFiniteNumber(d.width) &&
    isSpaceRef(d.to, roomCount) &&
    (d.flip === undefined || typeof d.flip === "boolean")
  );
}

function isWindow(v: unknown, roomCount: number): v is Window {
  if (!v || typeof v !== "object") return false;
  const w = v as Record<string, unknown>;
  return (
    isFiniteNumber(w.roomIndex) &&
    Number.isInteger(w.roomIndex) &&
    w.roomIndex >= 0 &&
    w.roomIndex < roomCount &&
    isWallSide(w.wall) &&
    isFiniteNumber(w.cx) &&
    isFiniteNumber(w.cy) &&
    isFiniteNumber(w.width)
  );
}

const ACCESS_SIDES = ["front", "back", "left", "right"];

function validateLayout(v: unknown): { ok: true; value: Layout } | { ok: false; error: string } {
  if (!v || typeof v !== "object") return { ok: false, error: "Géométrie absente ou invalide." };
  const l = v as Record<string, unknown>;
  if (!isRect(l.terrain)) return { ok: false, error: "Terrain invalide." };
  if (l.emprise !== null && !isRect(l.emprise)) return { ok: false, error: "Emprise invalide." };
  if (l.footprint !== null && !isRect(l.footprint)) return { ok: false, error: "Contour bâti invalide." };
  if (l.corridor !== null && !isRect(l.corridor)) return { ok: false, error: "Corridor invalide." };
  if (!Array.isArray(l.corridorFillers) || !l.corridorFillers.every(isRect)) return { ok: false, error: "Raccords de circulation invalides." };
  if (l.courtyard !== null && !isRect(l.courtyard)) return { ok: false, error: "Cour invalide." };
  if (l.streetDoor !== null && !isDoorGeometry(l.streetDoor)) return { ok: false, error: "Porte côté rue invalide." };
  if (l.entryDoor !== null && !isDoorGeometry(l.entryDoor)) return { ok: false, error: "Porte d'entrée invalide." };
  if (!Array.isArray(l.rooms) || !l.rooms.every(isPlacedRoom)) return { ok: false, error: "Une ou plusieurs pièces ont une structure invalide." };
  const roomCount = l.rooms.length;
  if (!Array.isArray(l.doors) || !l.doors.every((d) => isDoor(d, roomCount))) {
    return { ok: false, error: "Une ou plusieurs portes référencent une pièce inexistante ou ont une structure invalide." };
  }
  if (!Array.isArray(l.windows) || !l.windows.every((w) => isWindow(w, roomCount))) {
    return { ok: false, error: "Une ou plusieurs fenêtres référencent une pièce inexistante ou ont une structure invalide." };
  }
  if (!Array.isArray(l.exteriorSpaces)) return { ok: false, error: "Espaces extérieurs invalides." };
  if (!l.surfaces || typeof l.surfaces !== "object") return { ok: false, error: "Surfaces invalides." };
  const s = l.surfaces as Record<string, unknown>;
  for (const key of ["terrain", "emprise", "cour", "batie", "utileHabitable", "circulation", "exterieure"]) {
    if (!isFiniteNumber(s[key])) return { ok: false, error: `Surface « ${key} » invalide.` };
  }
  if (typeof l.accessSide !== "string" || !ACCESS_SIDES.includes(l.accessSide)) return { ok: false, error: "Façade d'accès invalide." };
  if (typeof l.feasible !== "boolean" || typeof l.rejected !== "boolean") return { ok: false, error: "Indicateurs de faisabilité invalides." };
  if (!Array.isArray(l.failureReasons) || !Array.isArray(l.rejectionReasons)) return { ok: false, error: "Listes de motifs invalides." };
  if (typeof l.variantLabel !== "string") return { ok: false, error: "Nom de variante invalide." };
  return { ok: true, value: l as unknown as Layout };
}

export function validateProjectFile(data: unknown): { ok: true; value: ProjectFile } | { ok: false; error: string } {
  if (!data || typeof data !== "object") return { ok: false, error: "Fichier invalide : structure JSON attendue." };
  const f = data as Record<string, unknown>;
  if (!isFiniteNumber(f.version)) return { ok: false, error: "Fichier invalide : numéro de version manquant." };
  if (f.version !== PROJECT_FILE_VERSION) {
    return { ok: false, error: `Version de fichier non prise en charge (${f.version}) — cet éditeur lit la version ${PROJECT_FILE_VERSION}.` };
  }
  if (typeof f.savedAt !== "string") return { ok: false, error: "Fichier invalide : date d'enregistrement manquante." };
  if (typeof f.orientation !== "string") return { ok: false, error: "Fichier invalide : orientation manquante." };
  const layoutResult = validateLayout(f.layout);
  if (!layoutResult.ok) return { ok: false, error: `Géométrie invalide : ${layoutResult.error}` };
  return { ok: true, value: { version: f.version, savedAt: f.savedAt, orientation: f.orientation, layout: layoutResult.value } };
}
