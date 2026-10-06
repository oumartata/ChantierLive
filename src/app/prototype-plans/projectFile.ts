// Document de projet versionné — distinct des exports visuels (SVG/PNG) :
// sérialise la géométrie COMPLÈTE et modifiable (terrain, pièces placées et
// mises de côté, portes, fenêtres) pour la sauvegarde locale et l'échange
// de fichier. Validé structurellement avant tout chargement (voir
// validateProjectFile) — jamais une confiance aveugle dans un JSON externe.
import type { Door, DoorGeometry, Layout, PlacedRoom, Rect, SpaceRef, StoredDimensionAllowance, WallSide, Window } from "./geometry";

// Historique : v1 (pièces/portes/fenêtres indépendantes, zone de rangement,
// redimensionnement) ; v2 ajoute le verrouillage (PlacedRoom.locked) et les
// circulations multiples identifiées (Layout.circulations) ; v3 ajoute
// surfaces.nonAffectee (résiduel non affecté à l'intérieur du contour bâti,
// voir geometry.ts/computeSurfaces) ; v4 ajoute Layout.exteriorPaths (trajet
// extérieur réel reliant l'entrée au bâti, voir buildExteriorPath) et
// surfaces.cheminementExterieur — TOUJOURS de façon additive (champs
// optionnels ou absents par défaut côté version antérieure), donc un
// fichier/brouillon plus ancien reste chargeable tel quel (voir les
// fonctions migrateLayoutV*To V* ci-dessous) : faire évoluer ce format ne
// doit jamais rendre une sauvegarde existante illisible. Une valeur migrée
// à 0/[] est un placeholder honnête (jamais recalculée a posteriori sans
// rouvrir le plan) — rouvrir puis ré-enregistrer le brouillon la met à jour
// avec la vraie valeur.
// v5 ajoute Layout.dimensionAllowances (autorisations F2 d'adaptation des
// dimensions, voir adaptation.ts). Changement de VERSION et non simple champ
// facultatif : validateLayout conserve tel quel un champ inconnu, si bien
// qu'une version antérieure de cet éditeur transporterait des autorisations
// sans les comprendre ni les valider ; elle refuse désormais explicitement un
// fichier v5. La version ÉCRITE dépend du contenu (projectFileVersionFor) :
// un plan SANS autorisation reste écrit en v4, à l'identique — le catalogue
// (validation en base, migration m032b : versions 1 à 4 seulement) et les
// versions antérieures de l'éditeur continuent de l'accepter ; seul un plan
// AVEC autorisations est écrit en v5, et y est alors refusé explicitement.
// Un fichier v1–v4 se lit sans autorisation (aucune adaptation par défaut).
// À la lecture, des autorisations invalides sont ÉCARTÉES avec un avis
// explicite (`notices`) — le plan reste importé, l'adaptation n'est jamais
// activée silencieusement.
export const PROJECT_FILE_VERSION = 5;
const SUPPORTED_VERSIONS = [1, 2, 3, 4, 5];

export function projectFileVersionFor(layout: Layout): number {
  return layout.dimensionAllowances && layout.dimensionAllowances.length > 0 ? 5 : 4;
}

export interface ProjectFile {
  version: number;
  savedAt: string;
  orientation: string;
  layout: Layout;
}

const STORAGE_KEY = "chantierlive:prototype-plans:draft:v1";

export function serializeProject(layout: Layout, orientation: string): ProjectFile {
  return { version: projectFileVersionFor(layout), savedAt: new Date().toISOString(), orientation, layout };
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

export function loadDraftLocally(): { ok: true; value: ProjectFile; notices: string[] } | { ok: false; error: string } | null {
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
    (r.parked === undefined || typeof r.parked === "boolean") &&
    (r.locked === undefined || typeof r.locked === "boolean")
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
  if (!Array.isArray(l.circulations) || !l.circulations.every(isRect)) return { ok: false, error: "Espaces de circulation invalides." };
  if (!Array.isArray(l.exteriorPaths) || !l.exteriorPaths.every(isRect)) return { ok: false, error: "Trajets extérieurs invalides." };
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
  for (const key of ["terrain", "emprise", "cour", "batie", "utileHabitable", "circulation", "cheminementExterieur", "exterieure", "nonAffectee"]) {
    if (!isFiniteNumber(s[key])) return { ok: false, error: `Surface « ${key} » invalide.` };
  }
  if (typeof l.accessSide !== "string" || !ACCESS_SIDES.includes(l.accessSide)) return { ok: false, error: "Façade d'accès invalide." };
  if (typeof l.feasible !== "boolean" || typeof l.rejected !== "boolean") return { ok: false, error: "Indicateurs de faisabilité invalides." };
  if (!Array.isArray(l.failureReasons) || !Array.isArray(l.rejectionReasons)) return { ok: false, error: "Listes de motifs invalides." };
  if (typeof l.variantLabel !== "string") return { ok: false, error: "Nom de variante invalide." };
  return { ok: true, value: l as unknown as Layout };
}

// Migration ADDITIVE uniquement : une sauvegarde v1 n'a jamais connu les
// circulations multiples (Layout.circulations) ni le verrouillage
// (PlacedRoom.locked, déjà optionnel donc lisible tel quel) — on complète
// seulement ce qui manque, jamais une réinterprétation de ce qui existe.
function migrateLayoutV1ToV2(layout: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(layout.circulations)) return layout;
  return { ...layout, circulations: [] };
}

// Placeholder honnête (0), jamais recalculé a posteriori sans rouvrir le
// plan — rouvrir puis ré-enregistrer met cette valeur à jour avec le vrai
// résiduel (voir le commentaire sur PROJECT_FILE_VERSION ci-dessus).
function migrateLayoutV2ToV3(layout: Record<string, unknown>): Record<string, unknown> {
  const surfaces = layout.surfaces as Record<string, unknown> | undefined;
  if (surfaces && typeof surfaces.nonAffectee === "number") return layout;
  return { ...layout, surfaces: { ...(surfaces ?? {}), nonAffectee: 0 } };
}

// v3 ne connaissait pas le trajet extérieur (toute la circulation était
// supposée toucher directement le bâti) : [] est un placeholder honnête,
// jamais une affirmation qu'un tel trajet existe ou est inutile — rouvrir
// puis ré-enregistrer le recalcule réellement si besoin.
function migrateLayoutV3ToV4(layout: Record<string, unknown>): Record<string, unknown> {
  const surfaces = layout.surfaces as Record<string, unknown> | undefined;
  const hasPaths = Array.isArray(layout.exteriorPaths);
  const hasSurface = surfaces && typeof surfaces.cheminementExterieur === "number";
  if (hasPaths && hasSurface) return layout;
  return {
    ...layout,
    exteriorPaths: hasPaths ? layout.exteriorPaths : [],
    surfaces: { ...(surfaces ?? {}), cheminementExterieur: hasSurface ? surfaces!.cheminementExterieur : 0 },
  };
}

// Validation STRICTE des autorisations F2 lues d'un fichier ou du brouillon.
// Toute entrée invalide écarte TOUTES les autorisations du fichier (jamais
// une sélection partielle silencieuse) ; le motif est rendu à l'appelant.
// Contrôles : structure, identité de la pièce (index et clé type|libellé|
// numéro), références positives, bornes de réduction (≤ référence, ≥
// minimum du moteur, au moins une), dimensions connues ≤ référence,
// une seule autorisation par pièce, pièce non verrouillée.
function validateStoredAllowances(raw: unknown, rooms: PlacedRoom[]): { ok: true; value: StoredDimensionAllowance[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "liste attendue" };
  const seen = new Set<number>();
  for (const v of raw) {
    if (!v || typeof v !== "object") return { ok: false, error: "entrée non structurée" };
    const a = v as Record<string, unknown>;
    if (!isFiniteNumber(a.roomIndex) || !Number.isInteger(a.roomIndex) || a.roomIndex < 0 || a.roomIndex >= rooms.length) return { ok: false, error: "pièce inexistante" };
    const room = rooms[a.roomIndex];
    const name = `« ${room.label} ${room.number} »`;
    if (seen.has(a.roomIndex)) return { ok: false, error: `${name} autorisée deux fois` };
    seen.add(a.roomIndex);
    if (typeof a.roomKey !== "string" || a.roomKey !== `${room.type}|${room.label}|${room.number}`) return { ok: false, error: `identité de la pièce ${name} différente de celle de l'autorisation` };
    if (room.locked) return { ok: false, error: `${name} est verrouillée` };
    if (!isFiniteNumber(a.referenceW) || a.referenceW <= 0 || !isFiniteNumber(a.referenceD) || a.referenceD <= 0) return { ok: false, error: `référence de ${name} invalide` };
    if (!isFiniteNumber(a.confirmedW) || a.confirmedW <= 0 || !isFiniteNumber(a.confirmedD) || a.confirmedD <= 0) return { ok: false, error: `dimensions connues de ${name} invalides` };
    if (a.confirmedW > a.referenceW + 1e-6 || a.confirmedD > a.referenceD + 1e-6) return { ok: false, error: `dimensions connues de ${name} au-delà de sa référence` };
    if (a.minW === null && a.minD === null) return { ok: false, error: `aucune borne pour ${name}` };
    for (const [bound, ref, engineMin] of [[a.minW, a.referenceW, room.minW], [a.minD, a.referenceD, room.minD]] as const) {
      if (bound === null) continue;
      if (!isFiniteNumber(bound)) return { ok: false, error: `borne de ${name} non numérique` };
      if (bound > (ref as number) + 1e-9) return { ok: false, error: `borne de ${name} supérieure à sa référence (seules les réductions sont permises)` };
      if (bound < engineMin - 1e-9) return { ok: false, error: `borne de ${name} sous le minimum du moteur` };
    }
    if (typeof a.confirmedAt !== "string") return { ok: false, error: `date de l'accord pour ${name} absente` };
  }
  return { ok: true, value: raw as StoredDimensionAllowance[] };
}

export function validateProjectFile(data: unknown): { ok: true; value: ProjectFile; notices: string[] } | { ok: false; error: string } {
  if (!data || typeof data !== "object") return { ok: false, error: "Fichier invalide : structure JSON attendue." };
  const f = data as Record<string, unknown>;
  if (!isFiniteNumber(f.version)) return { ok: false, error: "Fichier invalide : numéro de version manquant." };
  if (!SUPPORTED_VERSIONS.includes(f.version)) {
    return {
      ok: false,
      error: `Version de fichier non prise en charge (${f.version}) — cet éditeur lit les versions ${SUPPORTED_VERSIONS.join(", ")} (courante : ${PROJECT_FILE_VERSION}).`,
    };
  }
  if (typeof f.savedAt !== "string") return { ok: false, error: "Fichier invalide : date d'enregistrement manquante." };
  if (typeof f.orientation !== "string") return { ok: false, error: "Fichier invalide : orientation manquante." };
  if (!f.layout || typeof f.layout !== "object") return { ok: false, error: "Géométrie absente ou invalide." };
  let migratedLayout = f.layout as Record<string, unknown>;
  if (f.version === 1) migratedLayout = migrateLayoutV1ToV2(migratedLayout);
  if (f.version === 1 || f.version === 2) migratedLayout = migrateLayoutV2ToV3(migratedLayout);
  if (f.version === 1 || f.version === 2 || f.version === 3) migratedLayout = migrateLayoutV3ToV4(migratedLayout);
  const layoutResult = validateLayout(migratedLayout);
  if (!layoutResult.ok) return { ok: false, error: `Géométrie invalide : ${layoutResult.error}` };
  const notices: string[] = [];
  let layout = layoutResult.value;
  // Autorisations F2 : uniquement à partir de v5 ; ailleurs, jamais lues.
  if ((layout as unknown as Record<string, unknown>).dimensionAllowances !== undefined) {
    const stripped = { ...layout };
    delete stripped.dimensionAllowances;
    if (f.version !== 5) {
      notices.push("Autorisations d'adaptation des dimensions ignorées : ce fichier antérieur à la version 5 ne peut pas en contenir.");
      layout = stripped;
    } else {
      const allowances = validateStoredAllowances(layout.dimensionAllowances, layout.rooms);
      if (allowances.ok && allowances.value.length === 0) layout = stripped;
      else if (!allowances.ok) {
        notices.push(`Autorisations d'adaptation des dimensions écartées (${allowances.error}) : aucune adaptation n'est active. Le plan lui-même est importé ; reconfirmez les autorisations si besoin.`);
        layout = stripped;
      }
    }
  }
  return { ok: true, value: { version: projectFileVersionFor(layout), savedAt: f.savedAt, orientation: f.orientation, layout }, notices };
}

// ---- Catalogue (option A, décision du 2026-10-06) ----
// Un modèle du catalogue conserve la GÉOMÉTRIE d'un plan issu de F2, jamais
// les autorisations de réduction propres au projet d'origine (le
// consentement appartient à ce projet). Appelée par l'action serveur de dépôt
// APRÈS validateProjectFile ; travaille sur une copie (le fichier reçu n'est
// jamais modifié) ; retire UNIQUEMENT Layout.dimensionAllowances ; produit le
// fichier avec le sérialiseur existant (version déduite du contenu, jamais
// remplacée à la main) ; refuse si le résultat n'est pas un v4 (donnée propre
// à v5 autre que les autorisations : jamais supprimée en silence) ; revalide
// entièrement le fichier obtenu et vérifie que la géométrie est STRICTEMENT
// identique à celle du fichier reçu (hors autorisations). Note :
// serializeProject date le fichier produit (savedAt) au moment de la
// conversion.
export function toCatalogueProjectFile(
  file: ProjectFile
): { ok: true; file: ProjectFile; removedAllowances: number } | { ok: false; error: string } {
  const layout = JSON.parse(JSON.stringify(file.layout)) as Layout;
  const removedAllowances = layout.dimensionAllowances?.length ?? 0;
  delete layout.dimensionAllowances;
  const produced = serializeProject(layout, file.orientation);
  if (produced.version !== 4) {
    return { ok: false, error: `ce plan contient des données de la version ${produced.version} qui ne peuvent pas être conservées dans un modèle du catalogue (version 4).` };
  }
  const revalidated = validateProjectFile(JSON.parse(JSON.stringify(produced)));
  if (!revalidated.ok) return { ok: false, error: `conversion pour le catalogue invalide : ${revalidated.error}` };
  if (revalidated.notices.length > 0 || revalidated.value.version !== 4) {
    return { ok: false, error: "conversion pour le catalogue incohérente (avis de lecture ou version inattendus)." };
  }
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
  const sourceGeometry = { ...file.layout } as Record<string, unknown>;
  delete sourceGeometry.dimensionAllowances;
  if (JSON.stringify(canon(sourceGeometry)) !== JSON.stringify(canon(revalidated.value.layout)) || revalidated.value.orientation !== file.orientation) {
    return { ok: false, error: "conversion pour le catalogue non fidèle : la géométrie aurait changé." };
  }
  return { ok: true, file: revalidated.value, removedAllowances };
}
