"use client";

import { useMemo, useRef, useState, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  cloneLayout,
  doorsOf,
  flipDoorSwing,
  independentVerify,
  lockRoom,
  parkRoom,
  placeDoor,
  placeParkedRoom,
  regenerateUnlocked,
  removeDoor,
  resizeRoom,
  tryMoveRoom,
  unlockRoom,
  wallAdjacency,
  type Door,
  type Layout,
  type PlacedRoom,
  type RegenerationResult,
  type VerificationIssue,
  type WallSide,
} from "./geometry";
import { escapeXml, renderSvg, STAMP } from "./render";
import { saveDraftLocally, serializeProject, validateProjectFile } from "./projectFile";

const SCALE = 26; // px/m — cohérent avec render.ts
const MARGIN = 40;
const GRID_STEP = 0.1; // m — accrochage grille
const ALIGN_THRESHOLD = 0.12; // m — accrochage aux bords d'autres pièces

type Tool = "select" | "move" | "resize" | "add-door" | "remove-door";
type Corner = "nw" | "ne" | "sw" | "se";
const OPPOSITE_CORNER: Record<Corner, Corner> = { nw: "se", ne: "sw", sw: "ne", se: "nw" };

const WALL_LABEL: Record<WallSide, string> = { left: "gauche", right: "droite", top: "haut", bottom: "bas" };
function wallLabel(wall: WallSide): string {
  return WALL_LABEL[wall];
}

function snap(value: number, others: number[]): number {
  const grid = Math.round(value / GRID_STEP) * GRID_STEP;
  for (const o of others) {
    if (Math.abs(grid - o) < ALIGN_THRESHOLD) return o;
  }
  return grid;
}

export function PlanEditor({
  initialLayout,
  orientation,
  onExit,
}: {
  initialLayout: Layout;
  orientation: string;
  onExit: () => void;
}) {
  const [history, setHistory] = useState<Layout[]>([cloneLayout(initialLayout)]);
  const [future, setFuture] = useState<Layout[]>([]);
  // Copie locale, modifiable par un import de fichier de projet (qui peut
  // porter une orientation différente de celle transmise par le parent) —
  // le parent reste la source pour l'ouverture initiale uniquement.
  const [currentOrientation, setCurrentOrientation] = useState(orientation);
  const [tool, setTool] = useState<Tool>("select");
  const [selected, setSelected] = useState<number | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [dragRoomIndex, setDragRoomIndex] = useState<number | null>(null);
  const [resizingRoomIndex, setResizingRoomIndex] = useState<number | null>(null);
  const [resizePreview, setResizePreview] = useState<{ x: number; y: number; w: number; d: number; valid: boolean } | null>(null);
  // Proposition de régénération en cours de comparaison — jamais appliquée
  // au brouillon (history) tant que l'utilisateur ne choisit pas
  // explicitement "Choisir cette disposition" (voir handleAcceptRegeneration).
  const [regen, setRegen] = useState<{ base: Layout; result: RegenerationResult; selectedIndex: number } | null>(null);
  // Sauvegarde locale automatique initiale (à l'ouverture) puis après chaque
  // modification validée (voir saveNow, appelé par commit/undo/redo/import) —
  // jamais un geste séparé à retenir. Un échec (stockage plein, navigation
  // privée) reste affiché tel quel, jamais masqué derrière un "enregistré"
  // trompeur.
  const [saveStatus, setSaveStatus] = useState<"saved" | "error">(() => {
    const result = saveDraftLocally(serializeProject(initialLayout, orientation));
    return result.ok ? "saved" : "error";
  });
  const [saveError, setSaveError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const parkZoneRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  // Détails de glissement lus uniquement dans les gestionnaires d'événements,
  // jamais pendant le rendu (dragRoomIndex, un state, sert au rendu).
  const dragRef = useRef<{ roomIndex: number; startX: number; startY: number; grabDx: number; grabDy: number } | null>(null);
  const resizeRef = useRef<{ roomIndex: number; corner: Corner; anchorX: number; anchorY: number } | null>(null);

  const current = history[history.length - 1];
  const issues: VerificationIssue[] = useMemo(() => independentVerify(current), [current]);
  const errorCount = issues.filter((i) => i.severity === "error").length;

  function saveNow(layout: Layout, orient: string) {
    const result = saveDraftLocally(serializeProject(layout, orient));
    setSaveStatus(result.ok ? "saved" : "error");
    setSaveError(result.ok ? null : result.error);
  }

  // Pièces mises de côté — exclues des surfaces et du graphe de circulation
  // (voir geometry.ts), suivies séparément ici : le plan reste explicitement
  // "incomplet" tant que l'une d'elles n'est pas replacée.
  const parked = current.rooms.map((r, i) => ({ r, i })).filter((x) => x.r.parked);
  const lockedCount = current.rooms.filter((r) => r.locked && !r.parked).length;
  const unlockedCount = current.rooms.filter((r) => !r.locked && !r.parked).length;

  // Export — dérivé du MÊME `current` que le dessin interactif ci-dessous et
  // que la vérification : jamais une copie qui pourrait diverger. Les
  // problèmes non résolus et les pièces non placées sont gravés dans
  // l'image exportée elle-même, pas seulement affichés à l'écran.
  const exportSvgMarkup = useMemo(() => {
    const base = renderSvg(current, currentOrientation);
    if (errorCount === 0 && parked.length === 0) return base;
    const heightMatch = base.match(/height="(\d+(?:\.\d+)?)"/);
    const svgHeight = heightMatch ? parseFloat(heightMatch[1]) : 700;
    const lines: string[] = [];
    if (errorCount > 0) lines.push(`Brouillon non vérifié — ${errorCount} problème(s) non résolu(s)`);
    if (parked.length > 0) {
      const names = parked.map(({ r }) => `${r.label} ${r.number}`).join(", ");
      lines.push(`Plan incomplet — ${parked.length} pièce(s) non placée(s) : ${names}`);
    }
    const warning = lines
      .map(
        (line, i) =>
          `<text x="50%" y="${svgHeight - 30 - i * 14}" font-size="11" fill="#b91c1c" text-anchor="middle" font-weight="700">${escapeXml(line)}</text>`
      )
      .join("");
    return base.replace("</svg>", `${warning}</svg>`);
  }, [current, currentOrientation, errorCount, parked]);

  function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
  function handleExportSvg() {
    downloadBlob(new Blob([exportSvgMarkup], { type: "image/svg+xml" }), "avant-projet-modifie.svg");
  }
  function handleExportPng() {
    if (!canvasRef.current) return;
    const img = new Image();
    const url = URL.createObjectURL(new Blob([exportSvgMarkup], { type: "image/svg+xml" }));
    img.onload = () => {
      const canvas = canvasRef.current!;
      canvas.width = img.width || 900;
      canvas.height = img.height || 700;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => {
        if (blob) downloadBlob(blob, "avant-projet-modifie.png");
      }, "image/png");
    };
    img.src = url;
  }

  // Fichier de projet — document géométrique COMPLET et modifiable, distinct
  // des images SVG/PNG ci-dessus : seul ce format peut être rouvert pour
  // continuer l'édition.
  function handleExportProject() {
    const file = serializeProject(current, currentOrientation);
    downloadBlob(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }), "plan-chantierlive.json");
  }

  function handleImportProjectClick() {
    if (
      !window.confirm(
        "Importer un fichier de projet remplacera le brouillon actuellement ouvert (avec son historique Annuler/Rétablir). Continuer ?"
      )
    ) {
      return;
    }
    importInputRef.current?.click();
  }

  function handleImportProjectFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // permet de réimporter le même fichier ensuite
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(reader.result));
      } catch {
        setImportError("Fichier invalide : JSON illisible. Le brouillon actuel n'a pas été modifié.");
        window.setTimeout(() => setImportError(null), 4000);
        return;
      }
      const result = validateProjectFile(parsed);
      if (!result.ok) {
        setImportError(`Import refusé : ${result.error} Le brouillon actuel n'a pas été modifié.`);
        window.setTimeout(() => setImportError(null), 6000);
        return;
      }
      // Remplace entièrement — nouvel historique, l'ancien n'est plus
      // accessible (l'utilisateur vient de confirmer ce remplacement).
      setCurrentOrientation(result.value.orientation);
      setHistory([cloneLayout(result.value.layout)]);
      setFuture([]);
      setSelected(null);
      setImportError(null);
      saveNow(result.value.layout, result.value.orientation);
    };
    reader.onerror = () => {
      setImportError("Échec de la lecture du fichier. Le brouillon actuel n'a pas été modifié.");
      window.setTimeout(() => setImportError(null), 4000);
    };
    reader.readAsText(file);
  }

  function commit(next: Layout | null, rejectionMessage: string) {
    if (!next) {
      setFlash(rejectionMessage);
      window.setTimeout(() => setFlash(null), 2500);
      return;
    }
    setHistory((h) => [...h, next]);
    setFuture([]);
    saveNow(next, currentOrientation);
  }

  function undo() {
    if (history.length <= 1) return;
    const previous = history[history.length - 2];
    setFuture((f) => [history[history.length - 1], ...f]);
    setHistory((h) => h.slice(0, -1));
    saveNow(previous, currentOrientation);
  }
  function redo() {
    if (future.length === 0) return;
    setHistory((h) => [...h, future[0]]);
    setFuture((f) => f.slice(1));
    saveNow(future[0], currentOrientation);
  }

  function clientToWorld(clientX: number, clientY: number): { x: number; y: number } {
    const svg = svgRef.current!;
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const px = ((clientX - rect.left) / rect.width) * vb.width + vb.x;
    const py = ((clientY - rect.top) / rect.height) * vb.height + vb.y;
    return { x: (px - MARGIN) / SCALE, y: (py - MARGIN) / SCALE };
  }

  function handleRoomPointerDown(e: ReactPointerEvent, roomIndex: number) {
    e.stopPropagation();
    setSelected(roomIndex);
    if (tool !== "move") return;
    const room = current.rooms[roomIndex];
    const world = clientToWorld(e.clientX, e.clientY);
    dragRef.current = { roomIndex, startX: room.x, startY: room.y, grabDx: world.x - room.x, grabDy: world.y - room.y };
    setDragRoomIndex(roomIndex);
    (e.target as Element).setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: ReactPointerEvent) {
    const drag = dragRef.current;
    if (drag) {
      const world = clientToWorld(e.clientX, e.clientY);
      const otherXs = current.rooms.flatMap((r, i) => (i === drag.roomIndex ? [] : [r.x, r.x + r.w]));
      const otherYs = current.rooms.flatMap((r, i) => (i === drag.roomIndex ? [] : [r.y, r.y + r.d]));
      const newX = snap(world.x - drag.grabDx, otherXs);
      const newY = snap(world.y - drag.grabDy, otherYs);
      const preview = tryMoveRoom(current, drag.roomIndex, newX, newY);
      // Aperçu en direct : on affiche la position tentée même si invalide, avec
      // une couleur distincte — jamais validée tant que le pointeur n'est pas
      // relâché sur une position acceptée.
      setPreviewState({ x: newX, y: newY, valid: preview !== null });
      return;
    }
    const resize = resizeRef.current;
    if (resize) {
      const world = clientToWorld(e.clientX, e.clientY);
      const px = snap(world.x, []);
      const py = snap(world.y, []);
      const x = Math.min(resize.anchorX, px);
      const y = Math.min(resize.anchorY, py);
      const w = Math.abs(px - resize.anchorX);
      const d = Math.abs(py - resize.anchorY);
      const valid = w > 0 && d > 0 && resizeRoom(current, resize.roomIndex, x, y, w, d) !== null;
      setResizePreview({ x, y, w, d, valid });
    }
  }

  const [previewState, setPreviewState] = useState<{ x: number; y: number; valid: boolean } | null>(null);

  function handlePointerUp(e: ReactPointerEvent) {
    const drag = dragRef.current;
    if (drag) {
      dragRef.current = null;
      setDragRoomIndex(null);
      // Relâché au-dessus de la zone de rangement : mise de côté, jamais un
      // déplacement classique — la position visée sur le terrain n'a alors
      // aucun sens et n'est pas utilisée.
      const dropTarget = document.elementFromPoint(e.clientX, e.clientY);
      if (parkZoneRef.current && dropTarget && parkZoneRef.current.contains(dropTarget)) {
        setPreviewState(null);
        commit(parkRoom(current, drag.roomIndex), "Pièce verrouillée : déverrouillez-la avant de la mettre de côté.");
        return;
      }
      if (!previewState) return;
      const next = tryMoveRoom(current, drag.roomIndex, previewState.x, previewState.y);
      setPreviewState(null);
      commit(next, "Emplacement refusé : hors de l'emprise constructible, chevauchement avec une autre pièce/le corridor, ou empiète sur la cour réservée.");
      return;
    }
    const resize = resizeRef.current;
    if (resize) {
      resizeRef.current = null;
      setResizingRoomIndex(null);
      const preview = resizePreview;
      setResizePreview(null);
      if (!preview) return;
      const next = resizeRoom(current, resize.roomIndex, preview.x, preview.y, preview.w, preview.d);
      commit(
        next,
        "Redimensionnement refusé : en dessous des dimensions minimales définies, hors de l'emprise constructible, ou chevauchement (pièce, corridor, cour)."
      );
    }
  }

  function handleResizeHandlePointerDown(e: ReactPointerEvent, roomIndex: number, corner: Corner) {
    e.stopPropagation();
    if (tool !== "resize") return;
    setSelected(roomIndex);
    const room = current.rooms[roomIndex];
    const opposite = OPPOSITE_CORNER[corner];
    const anchorX = opposite === "ne" || opposite === "se" ? room.x + room.w : room.x;
    const anchorY = opposite === "sw" || opposite === "se" ? room.y + room.d : room.y;
    resizeRef.current = { roomIndex, corner, anchorX, anchorY };
    setResizingRoomIndex(roomIndex);
    (e.target as Element).setPointerCapture(e.pointerId);
  }

  // Alternative simple au glisser des poignées : champs numériques,
  // appliqués depuis le coin haut-gauche actuel (position inchangée, seules
  // largeur/profondeur varient) — mêmes contrôles que le glissé.
  function handleResizeField(roomIndex: number, field: "w" | "d", value: number) {
    const room = current.rooms[roomIndex];
    if (!room || !Number.isFinite(value) || value <= 0) return;
    const next = resizeRoom(current, roomIndex, room.x, room.y, field === "w" ? value : room.w, field === "d" ? value : room.d);
    commit(
      next,
      "Redimensionnement refusé : en dessous des dimensions minimales définies, hors de l'emprise constructible, ou chevauchement (pièce, corridor, cour)."
    );
  }

  function handleParkSelected() {
    if (selected === null) return;
    const room = current.rooms[selected];
    if (!room || room.parked) return;
    commit(parkRoom(current, selected), "Pièce verrouillée : déverrouillez-la avant de la mettre de côté.");
  }

  function handleToggleLock() {
    if (selected === null) return;
    const room = current.rooms[selected];
    if (!room || room.parked) return;
    commit(room.locked ? unlockRoom(current, selected) : lockRoom(current, selected), "");
  }

  // Lance la régénération des pièces non verrouillées — le brouillon en
  // cours d'édition (history/current) N'EST PAS modifié tant qu'un résultat
  // n'a pas été explicitement choisi : `regen` ne stocke qu'une proposition
  // à comparer, jamais un commit. Recherche bornée (2 ordres d'empilement
  // par colonne au maximum) et synchrone — rien à geler ni à annuler en
  // cours de calcul ; "Annuler" ci-dessous revient simplement au brouillon
  // sans y toucher.
  function handleRegenerate() {
    const result = regenerateUnlocked(current);
    setRegen({ base: current, result, selectedIndex: 0 });
  }

  function handleAcceptRegeneration() {
    if (!regen || regen.result.variants.length === 0) return;
    commit(regen.result.variants[regen.selectedIndex], "");
    setRegen(null);
    setSelected(null);
  }

  function handleCancelRegeneration() {
    setRegen(null);
  }

  // Retour automatique simple (alternative au glisser-déposer) : tente
  // l'ancienne position, puis un quadrillage grossier de l'emprise — un scan
  // simple, pas une recherche exhaustive. En cas d'échec, le glisser-déposer
  // reste le moyen de choisir un emplacement précis.
  function handleReplace(roomIndex: number) {
    const room = current.rooms[roomIndex];
    if (!room || !current.emprise) return;
    const step = GRID_STEP * 5;
    const attempts: Array<[number, number]> = [[room.x, room.y]];
    for (let y = current.emprise.y; y <= current.emprise.y + current.emprise.d - room.d + 1e-6; y += step) {
      for (let x = current.emprise.x; x <= current.emprise.x + current.emprise.w - room.w + 1e-6; x += step) {
        attempts.push([x, y]);
      }
    }
    for (const [x, y] of attempts) {
      const next = placeParkedRoom(current, roomIndex, x, y);
      if (next) {
        commit(next, "");
        return;
      }
    }
    setFlash(`Aucun emplacement libre trouvé automatiquement pour « ${room.label} ${room.number} » — utilisez le glisser-déposer pour choisir un emplacement précis.`);
    window.setTimeout(() => setFlash(null), 3500);
  }

  function handleParkedDragStart(e: ReactDragEvent<HTMLDivElement>, roomIndex: number) {
    e.dataTransfer.setData("text/plain", String(roomIndex));
    e.dataTransfer.effectAllowed = "move";
  }

  function handleSvgDragOver(e: ReactDragEvent<SVGSVGElement>) {
    e.preventDefault();
  }

  function handleSvgDrop(e: ReactDragEvent<SVGSVGElement>) {
    e.preventDefault();
    const idStr = e.dataTransfer.getData("text/plain");
    if (!idStr) return;
    const roomIndex = Number(idStr);
    const room = current.rooms[roomIndex];
    if (!room || !room.parked) return;
    const world = clientToWorld(e.clientX, e.clientY);
    const next = placeParkedRoom(current, roomIndex, world.x, world.y);
    commit(next, `Emplacement refusé pour « ${room.label} ${room.number} » : hors de l'emprise constructible ou chevauchement.`);
  }

  function handleWallClick(e: ReactPointerEvent, roomIndex: number, wall: WallSide) {
    e.stopPropagation();
    if (tool === "remove-door") {
      const exists = doorsOf(current, roomIndex).some((d) => d.wall === wall);
      if (!exists) {
        setFlash("Aucune porte sur ce mur.");
        window.setTimeout(() => setFlash(null), 2000);
        return;
      }
      commit(removeDoor(current, roomIndex, wall), "");
      return;
    }
    if (tool !== "add-door") return;
    const adjacency = wallAdjacency(current, roomIndex, wall);
    if (adjacency.kind === "none") {
      setFlash("Ce mur ne mène à aucun espace réel : aucune porte possible ici.");
      window.setTimeout(() => setFlash(null), 2000);
      return;
    }
    const world = clientToWorld(e.clientX, e.clientY);
    const along = wall === "left" || wall === "right" ? world.y : world.x;
    const next = placeDoor(current, roomIndex, wall, along);
    commit(next, "Porte impossible ici : une porte relie peut-être déjà ces deux espaces, l'espace est insuffisant, ou le battant rencontrerait un mur/une autre porte.");
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (selected === null) return;
    const room = current.rooms[selected];
    if (!room) return;
    const step = e.shiftKey ? GRID_STEP * 5 : GRID_STEP;
    let dx = 0, dy = 0;
    if (e.key === "ArrowLeft") dx = -step;
    else if (e.key === "ArrowRight") dx = step;
    else if (e.key === "ArrowUp") dy = -step;
    else if (e.key === "ArrowDown") dy = step;
    else if ((e.key === "z" || e.key === "Z") && (e.ctrlKey || e.metaKey)) { e.preventDefault(); undo(); return; }
    else if ((e.key === "y" || e.key === "Y") && (e.ctrlKey || e.metaKey)) { e.preventDefault(); redo(); return; }
    else return;
    e.preventDefault();
    if (room.parked) {
      setFlash(`« ${room.label} ${room.number} » est de côté — glissez-la sur le plan ou utilisez « Replacer ».`);
      window.setTimeout(() => setFlash(null), 2500);
      return;
    }
    const next = tryMoveRoom(current, selected, room.x + dx, room.y + dy);
    commit(next, "Déplacement clavier refusé : hors de l'emprise constructible ou chevauchement (pièce, corridor, cour).");
  }

  function handleExit() {
    if (window.confirm("Revenir à la variante d'origine ? Toutes les modifications de ce brouillon seront perdues.")) {
      onExit();
    }
  }

  const w = current.terrain.w * SCALE + MARGIN * 2;
  const h = current.terrain.d * SCALE + MARGIN * 2;
  const X = (m: number) => MARGIN + m * SCALE;
  const Y = (m: number) => MARGIN + m * SCALE;

  return (
    <div className="flex flex-col gap-3 rounded border border-slate-300 p-4" onKeyDown={handleKeyDown} tabIndex={0}>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">Modifier ce plan (brouillon)</h2>
        <button onClick={handleExit} className="rounded border border-slate-400 px-3 py-1 text-sm">
          Retour à la variante d&apos;origine
        </button>
      </div>
      <p className="rounded bg-amber-50 p-2 text-xs text-amber-800">
        Brouillon de travail. Annuler/Rétablir est l&apos;historique de travail de cette session — ce n&apos;est ni une
        sauvegarde durable ni un futur historique de versions métier. Une nouvelle génération ne l&apos;écrase pas sans
        confirmation.
      </p>
      <p className="flex flex-wrap items-center gap-2 rounded bg-slate-50 p-2 text-xs">
        <span className={saveStatus === "saved" ? "font-semibold text-green-700" : "font-semibold text-red-700"}>
          {saveStatus === "saved" ? "✓ Enregistré localement" : `✗ Échec de l'enregistrement local${saveError ? ` (${saveError})` : ""}`}
        </span>
        <span className="text-slate-400">— reste dans ce navigateur, sur cet appareil uniquement.</span>
      </p>
      {importError ? <p className="rounded bg-red-50 p-2 text-xs text-red-700">{importError}</p> : null}

      <div className="flex flex-wrap items-center gap-2">
        {(["select", "move", "resize", "add-door", "remove-door"] as Tool[]).map((t) => (
          <button
            key={t}
            onClick={() => setTool(t)}
            className={`rounded border px-3 py-1 text-sm ${tool === t ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300"}`}
          >
            {{ select: "Sélectionner", move: "Déplacer", resize: "Redimensionner", "add-door": "Ajouter/déplacer une porte", "remove-door": "Supprimer une porte" }[t]}
          </button>
        ))}
        <span className="mx-2 h-5 w-px bg-slate-300" />
        <button onClick={undo} disabled={history.length <= 1} className="rounded border border-slate-400 px-3 py-1 text-sm disabled:opacity-40">
          Annuler
        </button>
        <button onClick={redo} disabled={future.length === 0} className="rounded border border-slate-400 px-3 py-1 text-sm disabled:opacity-40">
          Rétablir
        </button>
        <span className="mx-2 h-5 w-px bg-slate-300" />
        <button onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))} className="rounded border border-slate-400 px-2 py-1 text-sm">−</button>
        <span className="text-sm">{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom((z) => Math.min(3, z + 0.25))} className="rounded border border-slate-400 px-2 py-1 text-sm">+</button>
      </div>

      <p className="text-xs text-slate-600">
        {tool === "select" && "Cliquez une pièce pour la sélectionner."}
        {tool === "move" &&
          "Glissez une pièce pour la déplacer (souris ou doigt), ou jusqu'à « Pièces à replacer » pour la mettre de côté. Flèches clavier pour la pièce sélectionnée."}
        {tool === "resize" && "Sélectionnez une pièce, puis glissez un coin pour la redimensionner, ou utilisez les champs largeur/profondeur ci-dessous."}
        {tool === "add-door" && "Sélectionnez une pièce, puis cliquez un de ses murs en pointillés : vert = entrée extérieure, violet = porte intérieure vers un espace réel, gris = aucun espace de ce côté."}
        {tool === "remove-door" && "Sélectionnez une pièce, puis cliquez un mur en rouge (porte présente) pour la retirer."}
        {selected !== null ? ` Sélection : ${current.rooms[selected].label} ${current.rooms[selected].number}.` : " Aucune sélection."}
      </p>
      {tool === "resize" && selected !== null && !current.rooms[selected].parked ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-1">
            Largeur (m)
            <input
              type="number"
              step={0.1}
              min={current.rooms[selected].minW}
              defaultValue={current.rooms[selected].w.toFixed(2)}
              key={`w-${selected}-${current.rooms[selected].w}`}
              onBlur={(e) => handleResizeField(selected, "w", Number(e.target.value))}
              className="w-20 rounded border border-slate-300 px-2 py-1"
            />
          </label>
          <label className="flex items-center gap-1">
            Profondeur (m)
            <input
              type="number"
              step={0.1}
              min={current.rooms[selected].minD}
              defaultValue={current.rooms[selected].d.toFixed(2)}
              key={`d-${selected}-${current.rooms[selected].d}`}
              onBlur={(e) => handleResizeField(selected, "d", Number(e.target.value))}
              className="w-20 rounded border border-slate-300 px-2 py-1"
            />
          </label>
          <span className="text-slate-500">
            Surface : {(current.rooms[selected].w * current.rooms[selected].d).toFixed(1)} m² — minimum {current.rooms[selected].minW.toFixed(2)} ×{" "}
            {current.rooms[selected].minD.toFixed(2)} m.
          </span>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {selected !== null
          ? doorsOf(current, selected).map((d) => (
              <button
                key={d.wall}
                onClick={() => commit(flipDoorSwing(current, selected, d.wall), "")}
                className="w-fit rounded border border-slate-400 px-3 py-1 text-sm"
              >
                Changer le sens d&apos;ouverture ({wallLabel(d.wall)})
              </button>
            ))
          : null}
        {selected !== null && !current.rooms[selected].parked ? (
          <button
            onClick={handleToggleLock}
            className={`w-fit rounded border px-3 py-1 text-sm ${current.rooms[selected].locked ? "border-amber-600 bg-amber-100 text-amber-900" : "border-slate-400"}`}
          >
            {current.rooms[selected].locked ? "🔒 Déverrouiller" : "Verrouiller (pour une régénération)"}
          </button>
        ) : null}
        {selected !== null && !current.rooms[selected].parked && !current.rooms[selected].locked ? (
          <button onClick={handleParkSelected} className="w-fit rounded border border-slate-400 px-3 py-1 text-sm">
            Mettre de côté
          </button>
        ) : null}
      </div>
      {selected !== null && current.rooms[selected].locked ? (
        <p className="rounded bg-amber-50 p-2 text-xs text-amber-800">
          Ce que verrouille ce bouton : la POSITION (x, y) et les DIMENSIONS (largeur, profondeur) de cette pièce — une
          régénération ne les modifiera jamais, quelle que soit la disposition proposée. Les OUVERTURES (portes,
          fenêtres) actuelles de cette pièce ne sont ni touchées ni supprimées par une régénération non plus — mais le
          verrou ne les fige PAS pour vous : vous pouvez encore en ajouter, déplacer ou retirer manuellement ici tant que
          la pièce reste sélectionnée. Déplacement (glisser-déposer), redimensionnement et mise de côté sont bloqués tant
          qu&apos;elle reste verrouillée.
        </p>
      ) : null}
      {parked.length > 0 ? (
        <p className="rounded bg-orange-50 p-2 text-xs font-semibold text-orange-800">
          Plan incomplet — {parked.length} pièce(s) restant à placer : {parked.map(({ r }) => `${r.label} ${r.number}`).join(", ")}.
        </p>
      ) : null}
      {flash ? <p className="rounded bg-red-50 p-2 text-xs text-red-700">{flash}</p> : null}

      {lockedCount > 0 && unlockedCount > 0 ? (
        <button onClick={handleRegenerate} className="w-fit rounded bg-indigo-700 px-3 py-2 text-sm font-semibold text-white">
          Proposer de nouvelles dispositions pour les {unlockedCount} pièce(s) non verrouillée(s)
        </button>
      ) : null}

      {regen ? (
        <RegenerationPanel
          regen={regen}
          orientation={currentOrientation}
          onSelect={(i) => setRegen((r) => (r ? { ...r, selectedIndex: i } : r))}
          onAccept={handleAcceptRegeneration}
          onCancel={handleCancelRegeneration}
        />
      ) : (
      <div className="flex flex-col gap-3 md:flex-row">
      <div className="overflow-auto rounded border border-slate-300 bg-white" style={{ maxHeight: "70vh" }}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${w} ${h}`}
          width={w * zoom}
          height={h * zoom}
          style={{ touchAction: "none", display: "block" }}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onDragOver={handleSvgDragOver}
          onDrop={handleSvgDrop}
        >
          <rect x={0} y={0} width={w} height={h} fill="#ffffff" />
          <rect x={X(0)} y={Y(0)} width={current.terrain.w * SCALE} height={current.terrain.d * SCALE} fill="none" stroke="#94a3b8" strokeWidth={1.5} strokeDasharray="4 3" />
          <text x={w - 24} y={16} fontSize={10} fill="#334155" textAnchor="middle">{currentOrientation}</text>
          {current.emprise ? (
            <rect x={X(current.emprise.x)} y={Y(current.emprise.y)} width={current.emprise.w * SCALE} height={current.emprise.d * SCALE} fill="none" stroke="#0ea5e9" strokeWidth={1.5} strokeDasharray="6 3" />
          ) : null}
          {current.courtyard ? (
            <rect x={X(current.courtyard.x)} y={Y(current.courtyard.y)} width={current.courtyard.w * SCALE} height={current.courtyard.d * SCALE} fill="#fef3c7" stroke="#d97706" strokeDasharray="3 2" />
          ) : null}
          {current.corridor ? (
            <rect x={X(current.corridor.x)} y={Y(current.corridor.y)} width={current.corridor.w * SCALE} height={current.corridor.d * SCALE} fill="#fef9c3" stroke="#eab308" />
          ) : null}
          {current.corridorFillers.map((f, i) => (
            <rect key={i} x={X(f.x)} y={Y(f.y)} width={f.w * SCALE} height={f.d * SCALE} fill="#fef9c3" stroke="#eab308" strokeWidth={0.5} />
          ))}
          {current.circulations.map((c, i) => (
            <rect key={`circ-${i}`} x={X(c.x)} y={Y(c.y)} width={c.w * SCALE} height={c.d * SCALE} fill="#fef9c3" stroke="#eab308" />
          ))}

          {current.rooms.map((r, i) => {
            if (r.parked) return null;
            const isMovePreview = dragRoomIndex === i && previewState;
            const isResizePreview = resizingRoomIndex === i && resizePreview;
            const rx = X(isMovePreview ? previewState!.x : isResizePreview ? resizePreview!.x : r.x);
            const ry = Y(isMovePreview ? previewState!.y : isResizePreview ? resizePreview!.y : r.y);
            const rw = (isResizePreview ? resizePreview!.w : r.w) * SCALE;
            const rd = (isResizePreview ? resizePreview!.d : r.d) * SCALE;
            const isSelected = selected === i;
            const roomDoors = doorsOf(current, i);
            return (
              <g key={i}>
                {isMovePreview ? (
                  <rect x={X(r.x)} y={Y(r.y)} width={r.w * SCALE} height={r.d * SCALE} fill="none" stroke="#cbd5e1" strokeDasharray="3 3" />
                ) : null}
                <rect
                  x={rx}
                  y={ry}
                  width={rw}
                  height={rd}
                  fill={
                    isMovePreview
                      ? previewState!.valid ? "#bbf7d0" : "#fecaca"
                      : isResizePreview
                        ? resizePreview!.valid ? "#bbf7d0" : "#fecaca"
                        : isSelected ? "#dbeafe" : "#e2e8f0"
                  }
                  stroke={r.locked ? "#b45309" : isSelected ? "#1d4ed8" : "#1e293b"}
                  strokeWidth={r.locked ? 3 : isSelected ? 3 : 2}
                  strokeDasharray={r.locked ? "6 2" : undefined}
                  style={{ cursor: tool === "move" && !r.locked ? "grab" : "pointer" }}
                  onPointerDown={(e) => handleRoomPointerDown(e, i)}
                />
                <text x={rx + rw / 2} y={ry + rd / 2 - 4} fontSize={11} fontWeight={600} textAnchor="middle" fill="#0f172a" style={{ pointerEvents: "none" }}>
                  {r.locked ? "🔒 " : ""}{r.label} {r.number}
                </text>
                <text x={rx + rw / 2} y={ry + rd / 2 + 11} fontSize={9} textAnchor="middle" fill="#334155" style={{ pointerEvents: "none" }}>
                  {(isResizePreview ? resizePreview!.w : r.w).toFixed(2)} × {(isResizePreview ? resizePreview!.d : r.d).toFixed(2)} m
                  {isResizePreview ? ` — ${(resizePreview!.w * resizePreview!.d).toFixed(1)} m²` : ""}
                </text>
                {tool === "resize" && isSelected && !r.parked && !r.locked ? (
                  <ResizeHandles rx={rx} ry={ry} rw={rw} rd={rd} onPick={(corner, e) => handleResizeHandlePointerDown(e, i, corner)} />
                ) : null}
                {roomDoors.length === 0 ? (
                  <text x={rx + rw / 2} y={ry + rd - 6} fontSize={8} fill="#b91c1c" textAnchor="middle" style={{ pointerEvents: "none" }}>
                    ⚠ aucune porte
                  </text>
                ) : null}
                {/* Les 4 murs, cliquables en mode ajout/suppression — colorés
                    selon ce qu'ils touchent réellement (wallAdjacency) ou
                    selon la présence d'une porte, jamais une supposition de
                    topologie. */}
                {(tool === "add-door" || tool === "remove-door") && isSelected ? (
                  <WallHandles layout={current} room={r} roomIndex={i} mode={tool === "add-door" ? "add" : "remove"} X={X} Y={Y} onPick={(wall, e) => handleWallClick(e, i, wall)} />
                ) : null}
                {roomDoors.map((d) => (
                  <DoorGlyph key={d.wall} door={d} X={X} Y={Y} />
                ))}
              </g>
            );
          })}
        </svg>
      </div>

      <div
        ref={parkZoneRef}
        className="flex min-h-[120px] w-full flex-col gap-2 rounded border-2 border-dashed border-slate-300 bg-slate-50 p-3 md:w-64"
      >
        <h3 className="text-sm font-semibold">Pièces à replacer ({parked.length})</h3>
        <p className="text-xs text-slate-600">
          Glissez une pièce du plan ici pour la mettre de côté temporairement, ou utilisez « Mettre de côté ». Glissez une
          carte ci-dessous sur le plan, ou cliquez « Replacer », pour la reposer (contraintes de placement toujours actives).
        </p>
        {parked.length === 0 ? (
          <p className="text-xs italic text-slate-400">Aucune pièce de côté.</p>
        ) : (
          parked.map(({ r, i }) => (
            <div
              key={i}
              draggable
              onDragStart={(e) => handleParkedDragStart(e, i)}
              className="flex cursor-grab items-center justify-between rounded border border-slate-300 bg-white p-2 text-xs"
            >
              <span>
                {r.label} {r.number} — {r.w.toFixed(2)} × {r.d.toFixed(2)} m
              </span>
              <button onClick={() => handleReplace(i)} className="rounded border border-slate-400 px-2 py-0.5">
                Replacer
              </button>
            </div>
          ))
        )}
      </div>
      </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button onClick={handleExportSvg} className="rounded border border-slate-400 px-3 py-1 text-sm">Exporter en SVG</button>
        <button onClick={handleExportPng} className="rounded border border-slate-400 px-3 py-1 text-sm">Exporter en PNG</button>
        <span className="mx-1 h-5 w-px self-center bg-slate-300" />
        <button onClick={handleExportProject} className="rounded border border-slate-400 px-3 py-1 text-sm">
          Exporter le fichier de projet (.json)
        </button>
        <button onClick={handleImportProjectClick} className="rounded border border-slate-400 px-3 py-1 text-sm">
          Importer un fichier de projet
        </button>
        <input ref={importInputRef} type="file" accept="application/json,.json" onChange={handleImportProjectFile} className="hidden" />
      </div>
      <p className="text-xs text-slate-500">
        Le fichier de projet (.json) est le seul format réellement modifiable : il contient la géométrie complète
        (terrain, pièces placées et mises de côté, portes, fenêtres) et peut être réimporté pour continuer l&apos;édition.
        Les exports SVG/PNG sont des images, pas des documents réouvrables.
      </p>
      <canvas ref={canvasRef} className="hidden" />

      <div>
        <h3 className="font-semibold">Surfaces (mêmes données que le dessin et l&apos;export)</h3>
        <table className="mt-1 w-full text-sm">
          <tbody>
            <tr><td>Terrain</td><td>{current.surfaces.terrain.toFixed(1)} m²</td></tr>
            <tr><td>Emprise disponible</td><td>{current.surfaces.emprise.toFixed(1)} m²</td></tr>
            {current.surfaces.cour > 0 ? (
              <tr><td>Cour d&apos;entrée</td><td>{current.surfaces.cour.toFixed(1)} m²</td></tr>
            ) : null}
            <tr><td>Surface bâtie (pièces + circulation réelles)</td><td>{current.surfaces.batie.toFixed(1)} m²</td></tr>
            <tr><td>Surface utile habitable</td><td>{current.surfaces.utileHabitable.toFixed(1)} m²</td></tr>
            <tr><td>Circulation</td><td>{current.surfaces.circulation.toFixed(1)} m²</td></tr>
            {current.surfaces.nonAffectee > 0.05 ? (
              <tr><td>Résiduel non affecté (dans le contour bâti)</td><td>{current.surfaces.nonAffectee.toFixed(1)} m²</td></tr>
            ) : null}
            <tr><td>Espaces extérieurs non bâtis (hors cour)</td><td>{current.surfaces.exterieure.toFixed(1)} m²</td></tr>
          </tbody>
        </table>
        <p className="mt-1 text-xs text-slate-500">
          Cour, bâti (union réelle des pièces et circulations, jamais le rectangle englobant), résiduel non affecté et
          reste de l&apos;emprise sont mutuellement exclusifs : leur somme égale l&apos;emprise disponible, jamais une
          surface comptée deux fois. Recalculées après chaque déplacement, redimensionnement ou régénération — jamais
          figées depuis la génération initiale.
        </p>
      </div>

      <div>
        <h3 className="font-semibold">Anomalies géométriques (pièces placées)</h3>
        {issues.length === 0 ? (
          <p className="text-sm text-green-700">
            Aucune anomalie géométrique détectée sur les pièces placées.
            {parked.length > 0
              ? ` Cela ne signifie PAS que le plan est complet : ${parked.length} pièce(s) restent à placer (voir « Plan incomplet » ci-dessus).`
              : ""}
          </p>
        ) : (
          <ul className="mt-1 list-disc pl-5 text-sm">
            {issues.map((issue, i) => (
              <li key={i} className={issue.severity === "error" ? "text-red-700" : "text-amber-700"}>{issue.message}</li>
            ))}
          </ul>
        )}
      </div>
      {errorCount > 0 ? (
        <p className="text-xs font-semibold text-red-700">
          Ce brouillon contient {errorCount} problème(s) non résolu(s) — l&apos;export les mentionnera, il n&apos;est jamais présenté comme vérifié.
        </p>
      ) : null}
      <p className="text-xs font-semibold text-red-700">{STAMP}</p>
    </div>
  );
}

function RegenerationPanel({
  regen,
  orientation,
  onSelect,
  onAccept,
  onCancel,
}: {
  regen: { base: Layout; result: RegenerationResult; selectedIndex: number };
  orientation: string;
  onSelect: (i: number) => void;
  onAccept: () => void;
  onCancel: () => void;
}) {
  const { result } = regen;
  return (
    <div className="flex flex-col gap-3 rounded border-2 border-indigo-400 bg-indigo-50 p-4">
      <h3 className="font-semibold text-indigo-900">Comparer de nouvelles dispositions</h3>
      <p className="text-xs text-indigo-800">
        Ce calcul (2 ordres de remplissage au maximum) s&apos;est déjà terminé — il n&apos;y a rien en cours à
        interrompre ici. Le brouillon actuel n&apos;est PAS modifié tant que vous n&apos;avez pas cliqué « Choisir cette
        disposition » ; « Fermer sans appliquer » vous y ramène exactement tel quel. Les pièces verrouillées restent
        identiques (position, dimensions, portes, fenêtres existantes) dans chaque proposition ci-dessous.
      </p>
      {result.variants.length === 0 ? (
        <div className="rounded bg-red-50 p-3 text-sm text-red-900">
          <p className="font-semibold">Aucune disposition trouvée respectant toutes les contraintes obligatoires.</p>
          <p className="mt-1 text-xs">
            Ceci ne signifie pas que le projet est architecturalement impossible — seulement que ce moteur, avec cet
            algorithme borné (2 ordres d&apos;empilement explorés au maximum par colonne), n&apos;a pas trouvé de
            disposition satisfaisante pour les pièces non verrouillées, compte tenu des pièces verrouillées conservées
            telles quelles.
          </p>
          {result.failureReasons.length > 0 ? (
            <ul className="mt-2 list-disc pl-5 text-xs">
              {result.failureReasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {result.variants.map((v, i) => (
              <button
                key={i}
                onClick={() => onSelect(i)}
                className={`rounded border px-3 py-1 text-sm ${i === regen.selectedIndex ? "border-indigo-900 bg-indigo-900 text-white" : "border-indigo-400 bg-white"}`}
              >
                {v.variantLabel}
              </button>
            ))}
          </div>
          <p className="text-xs text-slate-700">{result.preferenceNotes[regen.selectedIndex]}</p>
          <div className="overflow-auto rounded border border-slate-300 bg-white p-2" style={{ maxHeight: "60vh" }}>
            <div dangerouslySetInnerHTML={{ __html: renderSvg(result.variants[regen.selectedIndex], orientation) }} />
          </div>
          {result.failureReasons.length > 0 ? (
            <details className="text-xs text-slate-600">
              <summary className="cursor-pointer">{result.failureReasons.length} autre(s) exploration(s) écartée(s) — détails</summary>
              <ul className="mt-1 list-disc pl-5">
                {result.failureReasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
      <div className="flex gap-2">
        {result.variants.length > 0 ? (
          <button onClick={onAccept} className="rounded bg-indigo-900 px-3 py-2 text-sm font-semibold text-white">
            Choisir cette disposition
          </button>
        ) : null}
        <button onClick={onCancel} className="rounded border border-indigo-400 px-3 py-2 text-sm">
          Fermer sans appliquer — garder le brouillon actuel
        </button>
      </div>
    </div>
  );
}

const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];

function ResizeHandles({
  rx,
  ry,
  rw,
  rd,
  onPick,
}: {
  rx: number;
  ry: number;
  rw: number;
  rd: number;
  onPick: (corner: Corner, e: ReactPointerEvent) => void;
}) {
  return (
    <>
      {CORNERS.map((corner) => {
        const cx = corner === "nw" || corner === "sw" ? rx : rx + rw;
        const cy = corner === "nw" || corner === "ne" ? ry : ry + rd;
        return (
          <rect
            key={corner}
            x={cx - 5}
            y={cy - 5}
            width={10}
            height={10}
            fill="#1d4ed8"
            stroke="#ffffff"
            strokeWidth={1.5}
            style={{ cursor: corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize" }}
            onPointerDown={(e) => onPick(corner, e)}
          />
        );
      })}
    </>
  );
}

function DoorGlyph({ door, X, Y }: { door: Door; X: (m: number) => number; Y: (m: number) => number }) {
  const half = (door.width * SCALE) / 2;
  const cx = X(door.cx), cy = Y(door.cy);
  const vertical = door.wall === "left" || door.wall === "right";
  return vertical ? (
    <line x1={cx} y1={cy - half} x2={cx} y2={cy + half} stroke="#ffffff" strokeWidth={3} />
  ) : (
    <line x1={cx - half} y1={cy} x2={cx + half} y2={cy} stroke="#ffffff" strokeWidth={3} />
  );
}

const WALLS: WallSide[] = ["left", "right", "top", "bottom"];
// Mode "add" : vert = deviendrait une entrée EXTÉRIEURE (mur du bâti),
// violet = porte intérieure vers un espace adjacent réel (circulation, cour,
// une autre pièce), gris = aucun espace réel de ce côté, non cliquable.
const ADJACENCY_COLOR: Record<string, string> = { exterior: "#16a34a", circulation: "#7c3aed", room: "#7c3aed", courtyard: "#7c3aed", none: "#cbd5e1" };

function WallHandles({
  layout,
  room,
  roomIndex,
  mode,
  X,
  Y,
  onPick,
}: {
  layout: Layout;
  room: PlacedRoom;
  roomIndex: number;
  mode: "add" | "remove";
  X: (m: number) => number;
  Y: (m: number) => number;
  onPick: (wall: WallSide, e: ReactPointerEvent) => void;
}) {
  const existingWalls = new Set(doorsOf(layout, roomIndex).map((d) => d.wall));
  return (
    <>
      {WALLS.map((wall) => {
        let x1: number, y1: number, x2: number, y2: number;
        if (wall === "right") { x1 = x2 = X(room.x + room.w); y1 = Y(room.y); y2 = Y(room.y + room.d); }
        else if (wall === "left") { x1 = x2 = X(room.x); y1 = Y(room.y); y2 = Y(room.y + room.d); }
        else if (wall === "top") { y1 = y2 = Y(room.y); x1 = X(room.x); x2 = X(room.x + room.w); }
        else { y1 = y2 = Y(room.y + room.d); x1 = X(room.x); x2 = X(room.x + room.w); }
        // Mode "remove" : rouge = une porte est là (cliquable pour la
        // retirer), gris = aucune porte sur ce mur. Mode "add" : couleur
        // selon ce que wallAdjacency trouve réellement de ce côté.
        const hasDoor = existingWalls.has(wall);
        const color = mode === "remove" ? (hasDoor ? "#dc2626" : "#cbd5e1") : ADJACENCY_COLOR[wallAdjacency(layout, roomIndex, wall).kind];
        const clickable = mode === "remove" ? hasDoor : wallAdjacency(layout, roomIndex, wall).kind !== "none";
        return (
          <line
            key={wall}
            x1={x1} y1={y1} x2={x2} y2={y2}
            stroke={color}
            strokeWidth={6}
            strokeDasharray="2 4"
            style={{ cursor: clickable ? "pointer" : "not-allowed" }}
            onPointerDown={(e) => onPick(wall, e)}
          />
        );
      })}
    </>
  );
}

// Réexport pour la légende (mêmes petites pièces qu'en mode génération).
export type { Layout };
