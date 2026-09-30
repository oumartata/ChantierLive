"use client";

import { useMemo, useRef, useState, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  cloneLayout,
  flipDoorSwing,
  independentVerify,
  parkRoom,
  placeDoor,
  placeParkedRoom,
  removeDoor,
  tryMoveRoom,
  wallAdjacency,
  type Layout,
  type PlacedRoom,
  type VerificationIssue,
  type WallSide,
} from "./geometry";
import { escapeXml, renderSvg, STAMP } from "./render";

const SCALE = 26; // px/m — cohérent avec render.ts
const MARGIN = 40;
const GRID_STEP = 0.1; // m — accrochage grille
const ALIGN_THRESHOLD = 0.12; // m — accrochage aux bords d'autres pièces

type Tool = "select" | "move" | "add-door" | "remove-door";

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
  const [tool, setTool] = useState<Tool>("select");
  const [selected, setSelected] = useState<number | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [dragRoomIndex, setDragRoomIndex] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const parkZoneRef = useRef<HTMLDivElement>(null);
  // Détails de glissement lus uniquement dans les gestionnaires d'événements,
  // jamais pendant le rendu (dragRoomIndex, un state, sert au rendu).
  const dragRef = useRef<{ roomIndex: number; startX: number; startY: number; grabDx: number; grabDy: number } | null>(null);

  const current = history[history.length - 1];
  const issues: VerificationIssue[] = useMemo(() => independentVerify(current), [current]);
  const errorCount = issues.filter((i) => i.severity === "error").length;
  // Pièces mises de côté — exclues des surfaces et du graphe de circulation
  // (voir geometry.ts), suivies séparément ici : le plan reste explicitement
  // "incomplet" tant que l'une d'elles n'est pas replacée.
  const parked = current.rooms.map((r, i) => ({ r, i })).filter((x) => x.r.parked);

  // Export — dérivé du MÊME `current` que le dessin interactif ci-dessous et
  // que la vérification : jamais une copie qui pourrait diverger. Les
  // problèmes non résolus et les pièces non placées sont gravés dans
  // l'image exportée elle-même, pas seulement affichés à l'écran.
  const exportSvgMarkup = useMemo(() => {
    const base = renderSvg(current, orientation);
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
  }, [current, orientation, errorCount, parked]);

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

  function commit(next: Layout | null, rejectionMessage: string) {
    if (!next) {
      setFlash(rejectionMessage);
      window.setTimeout(() => setFlash(null), 2500);
      return;
    }
    setHistory((h) => [...h, next]);
    setFuture([]);
  }

  function undo() {
    if (history.length <= 1) return;
    setFuture((f) => [history[history.length - 1], ...f]);
    setHistory((h) => h.slice(0, -1));
  }
  function redo() {
    if (future.length === 0) return;
    setHistory((h) => [...h, future[0]]);
    setFuture((f) => f.slice(1));
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
    if (tool === "remove-door") {
      const room = current.rooms[roomIndex];
      if (!room.door) {
        setFlash(`« ${room.label} ${room.number} » n'a déjà aucune porte.`);
        window.setTimeout(() => setFlash(null), 2000);
        return;
      }
      commit(removeDoor(current, roomIndex), "");
      return;
    }
    if (tool !== "move") return;
    const room = current.rooms[roomIndex];
    const world = clientToWorld(e.clientX, e.clientY);
    dragRef.current = { roomIndex, startX: room.x, startY: room.y, grabDx: world.x - room.x, grabDy: world.y - room.y };
    setDragRoomIndex(roomIndex);
    (e.target as Element).setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: ReactPointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
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
  }

  const [previewState, setPreviewState] = useState<{ x: number; y: number; valid: boolean } | null>(null);

  function handlePointerUp(e: ReactPointerEvent) {
    const drag = dragRef.current;
    dragRef.current = null;
    setDragRoomIndex(null);
    if (!drag) {
      setPreviewState(null);
      return;
    }
    // Relâché au-dessus de la zone de rangement : mise de côté, jamais un
    // déplacement classique — la position visée sur le terrain n'a alors
    // aucun sens et n'est pas utilisée.
    const dropTarget = document.elementFromPoint(e.clientX, e.clientY);
    if (parkZoneRef.current && dropTarget && parkZoneRef.current.contains(dropTarget)) {
      setPreviewState(null);
      commit(parkRoom(current, drag.roomIndex), "");
      return;
    }
    if (!previewState) return;
    const next = tryMoveRoom(current, drag.roomIndex, previewState.x, previewState.y);
    setPreviewState(null);
    commit(next, "Emplacement refusé : hors de l'emprise constructible, chevauchement avec une autre pièce/le corridor, ou empiète sur la cour réservée.");
  }

  function handleParkSelected() {
    if (selected === null) return;
    const room = current.rooms[selected];
    if (!room || room.parked) return;
    commit(parkRoom(current, selected), "");
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
    if (tool !== "add-door") return;
    e.stopPropagation();
    const adjacency = wallAdjacency(current, roomIndex, wall);
    if (adjacency.kind === "none") {
      setFlash("Ce mur ne mène à aucun espace réel : aucune porte possible ici.");
      window.setTimeout(() => setFlash(null), 2000);
      return;
    }
    const world = clientToWorld(e.clientX, e.clientY);
    const along = wall === "left" || wall === "right" ? world.y : world.x;
    const next = placeDoor(current, roomIndex, wall, along);
    commit(next, "Porte impossible ici : espace insuffisant ou battant qui rencontrerait un mur ou une autre porte.");
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
        Brouillon de travail — non enregistré durablement. Il sera perdu à la fermeture ou au rechargement de la page,
        et une nouvelle génération ne l&apos;écrase pas sans confirmation.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {(["select", "move", "add-door", "remove-door"] as Tool[]).map((t) => (
          <button
            key={t}
            onClick={() => setTool(t)}
            className={`rounded border px-3 py-1 text-sm ${tool === t ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300"}`}
          >
            {{ select: "Sélectionner", move: "Déplacer", "add-door": "Ajouter/déplacer une porte", "remove-door": "Supprimer une porte" }[t]}
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
        {tool === "add-door" && "Cliquez un des 4 murs en pointillés : vert = entrée extérieure, violet = porte intérieure vers un espace réel, gris = aucun espace de ce côté."}
        {tool === "remove-door" && "Cliquez une pièce pour refermer sa porte."}
        {selected !== null ? ` Sélection : ${current.rooms[selected].label} ${current.rooms[selected].number}.` : " Aucune sélection."}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {selected !== null && current.rooms[selected].door ? (
          <button
            onClick={() => commit(flipDoorSwing(current, selected), "")}
            className="w-fit rounded border border-slate-400 px-3 py-1 text-sm"
          >
            Changer le sens d&apos;ouverture de la porte
          </button>
        ) : null}
        {selected !== null && !current.rooms[selected].parked ? (
          <button onClick={handleParkSelected} className="w-fit rounded border border-slate-400 px-3 py-1 text-sm">
            Mettre de côté
          </button>
        ) : null}
      </div>
      {parked.length > 0 ? (
        <p className="rounded bg-orange-50 p-2 text-xs font-semibold text-orange-800">
          Plan incomplet — {parked.length} pièce(s) restant à placer : {parked.map(({ r }) => `${r.label} ${r.number}`).join(", ")}.
        </p>
      ) : null}
      {flash ? <p className="rounded bg-red-50 p-2 text-xs text-red-700">{flash}</p> : null}

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
          <text x={w - 24} y={16} fontSize={10} fill="#334155" textAnchor="middle">{orientation}</text>
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

          {current.rooms.map((r, i) => {
            if (r.parked) return null;
            const isPreview = dragRoomIndex === i && previewState;
            const rx = X(isPreview ? previewState!.x : r.x);
            const ry = Y(isPreview ? previewState!.y : r.y);
            const rw = r.w * SCALE, rd = r.d * SCALE;
            const isSelected = selected === i;
            return (
              <g key={i}>
                {isPreview ? (
                  <rect x={X(r.x)} y={Y(r.y)} width={rw} height={rd} fill="none" stroke="#cbd5e1" strokeDasharray="3 3" />
                ) : null}
                <rect
                  x={rx}
                  y={ry}
                  width={rw}
                  height={rd}
                  fill={isPreview ? (previewState!.valid ? "#bbf7d0" : "#fecaca") : isSelected ? "#dbeafe" : "#e2e8f0"}
                  stroke={isSelected ? "#1d4ed8" : "#1e293b"}
                  strokeWidth={isSelected ? 3 : 2}
                  style={{ cursor: tool === "move" ? "grab" : "pointer" }}
                  onPointerDown={(e) => handleRoomPointerDown(e, i)}
                />
                <text x={rx + rw / 2} y={ry + rd / 2 - 4} fontSize={11} fontWeight={600} textAnchor="middle" fill="#0f172a" style={{ pointerEvents: "none" }}>
                  {r.label} {r.number}
                </text>
                <text x={rx + rw / 2} y={ry + rd / 2 + 11} fontSize={9} textAnchor="middle" fill="#334155" style={{ pointerEvents: "none" }}>
                  {r.w.toFixed(2)} × {r.d.toFixed(2)} m
                </text>
                {!r.door ? (
                  <text x={rx + rw / 2} y={ry + rd - 6} fontSize={8} fill="#b91c1c" textAnchor="middle" style={{ pointerEvents: "none" }}>
                    ⚠ aucune porte
                  </text>
                ) : null}
                {/* Les 4 murs, cliquables en mode "ajouter/déplacer" — colorés
                    selon ce qu'ils touchent réellement (wallAdjacency),
                    jamais une supposition de topologie. */}
                {tool === "add-door" && isSelected ? (
                  <WallHandles layout={current} room={r} roomIndex={i} X={X} Y={Y} onPick={(wall, e) => handleWallClick(e, i, wall)} />
                ) : null}
                {r.door ? <DoorGlyph door={r.door} X={X} Y={Y} /> : null}
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

      <div className="flex gap-2">
        <button onClick={handleExportSvg} className="rounded border border-slate-400 px-3 py-1 text-sm">Exporter en SVG</button>
        <button onClick={handleExportPng} className="rounded border border-slate-400 px-3 py-1 text-sm">Exporter en PNG</button>
      </div>
      <canvas ref={canvasRef} className="hidden" />

      <div>
        <h3 className="font-semibold">Vérification indépendante du brouillon</h3>
        {issues.length === 0 ? (
          <p className="text-sm text-green-700">Aucun problème détecté sur ce brouillon.</p>
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

function DoorGlyph({ door, X, Y }: { door: NonNullable<PlacedRoom["door"]>; X: (m: number) => number; Y: (m: number) => number }) {
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
// Vert = deviendrait une entrée EXTÉRIEURE (mur du bâti) ; violet = porte
// intérieure vers un espace adjacent réel (corridor, salon, cour, une autre
// pièce) ; gris = aucun espace réel de ce côté, non cliquable.
const ADJACENCY_COLOR: Record<string, string> = { exterior: "#16a34a", corridor: "#7c3aed", salon: "#7c3aed", room: "#7c3aed", courtyard: "#7c3aed", none: "#cbd5e1" };

function WallHandles({
  layout,
  room,
  roomIndex,
  X,
  Y,
  onPick,
}: {
  layout: Layout;
  room: PlacedRoom;
  roomIndex: number;
  X: (m: number) => number;
  Y: (m: number) => number;
  onPick: (wall: WallSide, e: ReactPointerEvent) => void;
}) {
  return (
    <>
      {WALLS.map((wall) => {
        const adjacency = wallAdjacency(layout, roomIndex, wall);
        let x1: number, y1: number, x2: number, y2: number;
        if (wall === "right") { x1 = x2 = X(room.x + room.w); y1 = Y(room.y); y2 = Y(room.y + room.d); }
        else if (wall === "left") { x1 = x2 = X(room.x); y1 = Y(room.y); y2 = Y(room.y + room.d); }
        else if (wall === "top") { y1 = y2 = Y(room.y); x1 = X(room.x); x2 = X(room.x + room.w); }
        else { y1 = y2 = Y(room.y + room.d); x1 = X(room.x); x2 = X(room.x + room.w); }
        const clickable = adjacency.kind !== "none";
        return (
          <line
            key={wall}
            x1={x1} y1={y1} x2={x2} y2={y2}
            stroke={ADJACENCY_COLOR[adjacency.kind]}
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
