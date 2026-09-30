"use client";

import { useMemo, useRef, useState } from "react";
import {
  DEFAULT_PRESETS,
  generateVariants,
  independentVerify,
  type AccessSide,
  type GenerationInput,
  type Layout,
  type RoomNeed,
  type VerificationIssue,
} from "./geometry";
import { renderSvg, STAMP } from "./render";

interface RoomRow extends RoomNeed {
  count: number;
}

const DEFAULT_ROWS: RoomRow[] = [
  { ...DEFAULT_PRESETS.chambre, count: 3 },
  { ...DEFAULT_PRESETS.salon, count: 1 },
  { ...DEFAULT_PRESETS.cuisine, count: 1 },
  { ...DEFAULT_PRESETS.sanitaire, count: 2 },
  { ...DEFAULT_PRESETS.garage, count: 0 },
];

function numberInput(value: number, onChange: (v: number) => void, step = 0.1) {
  return (
    <input
      type="number"
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-20 rounded border border-slate-300 px-2 py-1 text-sm"
    />
  );
}

export function PrototypeClient() {
  const [terrainWidth, setTerrainWidth] = useState(15);
  const [terrainDepth, setTerrainDepth] = useState(20);
  const [front, setFront] = useState(3);
  const [back, setBack] = useState(2);
  const [left, setLeft] = useState(2);
  const [right, setRight] = useState(2);
  const [accessSide, setAccessSide] = useState<AccessSide>("front");
  const [orientation, setOrientation] = useState<"N" | "S" | "E" | "O">("N");
  const [rooms, setRooms] = useState<RoomRow[]>(DEFAULT_ROWS);

  const [variants, setVariants] = useState<Layout[] | null>(null);
  const [failureReasons, setFailureReasons] = useState<string[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement>(null);

  const selected = variants && variants.length > 0 ? variants[selectedIndex] : null;
  const issues: VerificationIssue[] = useMemo(() => (selected ? independentVerify(selected) : []), [selected]);
  const svgMarkup = useMemo(() => (selected ? renderSvg(selected) : ""), [selected]);

  function updateRoom(index: number, patch: Partial<RoomRow>) {
    setRooms((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  function handleGenerate() {
    const input: GenerationInput = {
      terrainWidth,
      terrainDepth,
      setbacks: { front, back, left, right },
      accessSide,
      orientation,
      needs: rooms.filter((r) => r.count > 0),
    };
    const result = generateVariants(input);
    setVariants(result.variants);
    setFailureReasons(result.attemptFailureReasons);
    setSelectedIndex(0);
  }

  function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleExportSvg() {
    if (!svgMarkup) return;
    downloadBlob(new Blob([svgMarkup], { type: "image/svg+xml" }), "avant-projet.svg");
  }

  function handleExportPng() {
    if (!svgMarkup || !canvasRef.current) return;
    const img = new Image();
    const svgBlob = new Blob([svgMarkup], { type: "image/svg+xml" });
    const url = URL.createObjectURL(svgBlob);
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
        if (blob) downloadBlob(blob, "avant-projet.png");
      }, "image/png");
    };
    img.src = url;
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6 text-slate-900">
      <div>
        <h1 className="text-2xl font-bold">Prototype T0 — générateur de plan 2D (avant-projet)</h1>
        <p className="mt-1 text-sm text-slate-600">
          Prototype géométrique isolé — aucune authentification, aucune base de données, aucune persistance.
          Les préréglages de pièces sont des hypothèses de conception modifiables, jamais des normes locales certifiées.
        </p>
      </div>

      <section className="flex flex-col gap-3 rounded border border-slate-300 p-4">
        <h2 className="font-semibold">Terrain</h2>
        <div className="flex flex-wrap gap-4">
          <label className="flex flex-col text-sm">
            Largeur (m)
            {numberInput(terrainWidth, setTerrainWidth, 0.5)}
          </label>
          <label className="flex flex-col text-sm">
            Profondeur (m)
            {numberInput(terrainDepth, setTerrainDepth, 0.5)}
          </label>
          <label className="flex flex-col text-sm">
            Façade d&apos;accès
            <select
              value={accessSide}
              onChange={(e) => setAccessSide(e.target.value as AccessSide)}
              className="rounded border border-slate-300 px-2 py-1 text-sm"
            >
              <option value="front">Avant</option>
              <option value="back">Arrière</option>
              <option value="left">Gauche</option>
              <option value="right">Droite</option>
            </select>
          </label>
          <label className="flex flex-col text-sm">
            Orientation
            <select
              value={orientation}
              onChange={(e) => setOrientation(e.target.value as "N" | "S" | "E" | "O")}
              className="rounded border border-slate-300 px-2 py-1 text-sm"
            >
              <option value="N">Nord</option>
              <option value="S">Sud</option>
              <option value="E">Est</option>
              <option value="O">Ouest</option>
            </select>
          </label>
        </div>

        <h3 className="mt-2 text-sm font-semibold">Reculs (séparés, jamais une valeur unique)</h3>
        <div className="flex flex-wrap gap-4">
          <label className="flex flex-col text-sm">
            Avant (m)
            {numberInput(front, setFront, 0.5)}
          </label>
          <label className="flex flex-col text-sm">
            Arrière (m)
            {numberInput(back, setBack, 0.5)}
          </label>
          <label className="flex flex-col text-sm">
            Gauche (m)
            {numberInput(left, setLeft, 0.5)}
          </label>
          <label className="flex flex-col text-sm">
            Droite (m)
            {numberInput(right, setRight, 0.5)}
          </label>
        </div>
        <p className="text-xs text-slate-500">
          Emprise disponible = terrain − reculs = {Math.max(0, terrainWidth - left - right).toFixed(1)} ×{" "}
          {Math.max(0, terrainDepth - front - back).toFixed(1)} m ={" "}
          {Math.max(0, (terrainWidth - left - right) * (terrainDepth - front - back)).toFixed(1)} m².
        </p>
      </section>

      <section className="flex flex-col gap-3 rounded border border-slate-300 p-4">
        <h2 className="font-semibold">Besoins (pièces)</h2>
        <p className="text-xs text-slate-500">
          Largeur/profondeur minimales ET cibles, éditables — hypothèses de conception, pas une norme.
        </p>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-500">
              <th>Pièce</th>
              <th>Nombre</th>
              <th>Larg. min</th>
              <th>Prof. min</th>
              <th>Larg. cible</th>
              <th>Prof. cible</th>
            </tr>
          </thead>
          <tbody>
            {rooms.map((room, i) => (
              <tr key={room.type}>
                <td className="py-1">{room.label}</td>
                <td>
                  <input
                    type="number"
                    min={0}
                    value={room.count}
                    onChange={(e) => updateRoom(i, { count: Number(e.target.value) })}
                    className="w-16 rounded border border-slate-300 px-2 py-1"
                  />
                </td>
                <td>{numberInput(room.minWidth, (v) => updateRoom(i, { minWidth: v }))}</td>
                <td>{numberInput(room.minDepth, (v) => updateRoom(i, { minDepth: v }))}</td>
                <td>{numberInput(room.targetWidth, (v) => updateRoom(i, { targetWidth: v }))}</td>
                <td>{numberInput(room.targetDepth, (v) => updateRoom(i, { targetDepth: v }))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <button
        onClick={handleGenerate}
        className="w-fit rounded bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700"
      >
        Générer les variantes
      </button>

      {variants && variants.length === 0 ? (
        <section className="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-900">
          <p className="font-semibold">Aucune solution trouvée par ce moteur avec ces paramètres.</p>
          <p className="mt-1 text-xs">
            Ceci ne signifie pas que le projet est architecturalement impossible — seulement que ce moteur, avec cet
            algorithme et ces hypothèses, n&apos;a pas trouvé de disposition valide. Motifs observés lors des tentatives :
          </p>
          <ul className="mt-2 list-disc pl-5">
            {failureReasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {variants && variants.length > 0 ? (
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            {variants.map((v, i) => (
              <button
                key={v.variantLabel}
                onClick={() => setSelectedIndex(i)}
                className={`rounded border px-3 py-1 text-sm ${
                  i === selectedIndex ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300"
                }`}
              >
                {v.variantLabel}
              </button>
            ))}
          </div>

          {selected ? (
            <>
              <div
                className="overflow-x-auto rounded border border-slate-300 bg-white"
                dangerouslySetInnerHTML={{ __html: svgMarkup }}
              />

              <div className="flex gap-2">
                <button onClick={handleExportSvg} className="rounded border border-slate-400 px-3 py-1 text-sm">
                  Exporter en SVG
                </button>
                <button onClick={handleExportPng} className="rounded border border-slate-400 px-3 py-1 text-sm">
                  Exporter en PNG
                </button>
              </div>
              <canvas ref={canvasRef} className="hidden" />

              <div>
                <h3 className="font-semibold">Surfaces (mêmes données que le dessin ci-dessus)</h3>
                <table className="mt-1 w-full text-sm">
                  <tbody>
                    <tr><td>Terrain</td><td>{selected.surfaces.terrain.toFixed(1)} m²</td></tr>
                    <tr><td>Emprise disponible</td><td>{selected.surfaces.emprise.toFixed(1)} m²</td></tr>
                    <tr><td>Surface bâtie (murs compris)</td><td>{selected.surfaces.batie.toFixed(1)} m²</td></tr>
                    <tr><td>Surface utile habitable</td><td>{selected.surfaces.utileHabitable.toFixed(1)} m²</td></tr>
                    <tr><td>Circulation</td><td>{selected.surfaces.circulation.toFixed(1)} m²</td></tr>
                    <tr><td>Espaces extérieurs (dans l&apos;emprise)</td><td>{selected.surfaces.exterieure.toFixed(1)} m²</td></tr>
                  </tbody>
                </table>
              </div>

              <div>
                <h3 className="font-semibold">Vérification indépendante</h3>
                {issues.length === 0 ? (
                  <p className="text-sm text-green-700">Aucun problème détecté par la passe de vérification indépendante.</p>
                ) : (
                  <ul className="mt-1 list-disc pl-5 text-sm">
                    {issues.map((issue, i) => (
                      <li key={i} className={issue.severity === "error" ? "text-red-700" : "text-amber-700"}>
                        {issue.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <p className="text-xs font-semibold text-red-700">{STAMP}</p>
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
