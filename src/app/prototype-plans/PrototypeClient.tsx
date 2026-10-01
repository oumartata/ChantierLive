"use client";

import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  DEFAULT_PRESETS,
  generateVariants,
  independentVerify,
  type AccessSide,
  type EntryMode,
  type GenerationInput,
  type Layout,
  type RoomConnection,
  type RoomNeed,
  type VerificationIssue,
} from "./geometry";
import { renderSvg, legendFor, STAMP } from "./render";
import { PlanEditor } from "./PlanEditor";
import { clearDraftLocally, loadDraftLocally, type ProjectFile } from "./projectFile";

interface RoomRow extends RoomNeed {
  count: number;
}

// Source externe (localStorage) exposée via useSyncExternalStore plutôt que
// lue dans un effet ou dans l'initialiseur de useState : le serveur n'a pas
// accès à localStorage, donc un initialiseur qui le lisait directement
// renvoyait `null` au rendu serveur mais la vraie valeur dès la première
// passe client — un contenu différent (bannière « brouillon trouvé » contre
// rien) détecté par React comme une erreur d'hydratation. useSyncExternalStore
// est l'API prévue pour ce cas exact : `getServerSnapshot` fige le rendu
// serveur à `null`, `getSnapshot` lit la vraie valeur côté client UNIQUEMENT
// après l'hydratation, sans jamais annoncer un setState dans un effet
// (interdit par la configuration de lint de ce projet). Le cache est
// invalidé explicitement par clearResumableDraft, jamais relu à chaque
// rendu (loadDraftLocally reparse le JSON à chaque appel, une référence
// neuve à chaque fois ferait boucler useSyncExternalStore).
type ResumableState = { file: ProjectFile } | { error: string } | null;
let resumableCache: ResumableState | undefined;
const resumableListeners = new Set<() => void>();

function getResumableSnapshot(): ResumableState {
  if (resumableCache === undefined) {
    const result = loadDraftLocally();
    resumableCache = !result ? null : result.ok ? { file: result.value } : { error: result.error };
  }
  return resumableCache;
}
function getResumableServerSnapshot(): ResumableState {
  return null;
}
function subscribeResumable(listener: () => void) {
  resumableListeners.add(listener);
  return () => resumableListeners.delete(listener);
}
function clearResumableDraft() {
  clearDraftLocally();
  resumableCache = null;
  resumableListeners.forEach((listener) => listener());
}

const DEFAULT_ROWS: RoomRow[] = [
  { ...DEFAULT_PRESETS.chambre, count: 3 },
  { ...DEFAULT_PRESETS.salon, count: 1 },
  { ...DEFAULT_PRESETS.cuisine, count: 1 },
  { ...DEFAULT_PRESETS.sanitaire, count: 2 },
  { ...DEFAULT_PRESETS.garage, count: 0 },
];

function numberInput(value: number, onChange: (v: number) => void, step = 0.1, disabled = false) {
  return (
    <input
      type="number"
      step={step}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-20 rounded border border-slate-300 px-2 py-1 text-sm disabled:bg-slate-100 disabled:text-slate-400"
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

  const [entryMode, setEntryMode] = useState<EntryMode>("direct");
  const [courtyardDepth, setCourtyardDepth] = useState(3);
  const [centralSalon, setCentralSalon] = useState(false);
  const [roomsConnectVia, setRoomsConnectVia] = useState<RoomConnection>("corridor");
  const [sanitaireConnectVia, setSanitaireConnectVia] = useState<RoomConnection>("corridor");

  const [variants, setVariants] = useState<Layout[] | null>(null);
  const [rejectedVariants, setRejectedVariants] = useState<Layout[]>([]);
  const [failureReasons, setFailureReasons] = useState<string[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [draft, setDraft] = useState<Layout | null>(null);
  // Brouillon enregistré localement (navigateur/appareil courant) lors d'une
  // session précédente — proposé explicitement, jamais rouvert sans action
  // de l'utilisateur. null = aucun, undefined-like "corrupted" géré via le
  // champ error. Voir getResumableSnapshot/getResumableServerSnapshot
  // ci-dessus pour pourquoi ceci passe par useSyncExternalStore plutôt
  // qu'un useState initialisé depuis localStorage.
  const resumable = useSyncExternalStore(subscribeResumable, getResumableSnapshot, getResumableServerSnapshot);

  const canvasRef = useRef<HTMLCanvasElement>(null);

  const selected = variants && variants.length > 0 ? variants[selectedIndex] : null;
  const issues: VerificationIssue[] = useMemo(() => (selected ? independentVerify(selected) : []), [selected]);
  const svgMarkup = useMemo(() => (selected ? renderSvg(selected, orientation) : ""), [selected, orientation]);
  const legend = useMemo(() => (selected ? legendFor(selected) : []), [selected]);

  function updateRoom(index: number, patch: Partial<RoomRow>) {
    setRooms((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  function handleGenerate() {
    if (draft && !window.confirm("Générer de nouvelles variantes ? Le brouillon en cours d'édition sera perdu.")) {
      return;
    }
    setDraft(null);
    const input: GenerationInput = {
      terrainWidth,
      terrainDepth,
      setbacks: { front, back, left, right },
      accessSide,
      orientation,
      needs: rooms.filter((r) => r.count > 0),
      entryMode,
      courtyardDepth,
      centralSalon,
      roomsConnectVia,
      sanitaireConnectVia,
    };
    const result = generateVariants(input);
    setVariants(result.variants);
    setRejectedVariants(result.rejectedVariants);
    setFailureReasons(result.attemptFailureReasons);
    setSelectedIndex(0);
    setZoom(1);
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
          Règle de ce prototype (pas une norme réglementaire) : une chambre ou un salon sans ouverture extérieure
          représentée est écarté des propositions satisfaisantes ; un garage sans accès véhicule direct depuis la
          façade d&apos;accès aussi (un couloir intérieur ne suffit pas).
        </p>
      </div>

      {resumable && "file" in resumable && !draft ? (
        <section className="flex flex-wrap items-center gap-3 rounded border border-sky-300 bg-sky-50 p-3 text-sm">
          <span>
            Brouillon enregistré localement trouvé (le {new Date(resumable.file.savedAt).toLocaleString("fr-FR")}, sur cet
            appareil/navigateur).
          </span>
          <button
            onClick={() => {
              setOrientation(resumable.file.orientation as "N" | "S" | "E" | "O");
              setDraft(resumable.file.layout);
            }}
            className="rounded bg-sky-700 px-3 py-1 text-xs font-semibold text-white"
          >
            Reprendre ce brouillon
          </button>
          <button
            onClick={clearResumableDraft}
            className="rounded border border-sky-400 px-3 py-1 text-xs"
          >
            Ignorer et effacer
          </button>
        </section>
      ) : null}
      {resumable && "error" in resumable ? (
        <section className="rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
          Un brouillon local existait mais n&apos;a pas pu être relu ({resumable.error}). Il n&apos;a pas été modifié ;
          vous pouvez <button onClick={clearResumableDraft} className="underline">l&apos;effacer</button>.
        </section>
      ) : null}

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
            <select value={accessSide} onChange={(e) => setAccessSide(e.target.value as AccessSide)} className="rounded border border-slate-300 px-2 py-1 text-sm">
              <option value="front">Avant</option>
              <option value="back">Arrière</option>
              <option value="left">Gauche</option>
              <option value="right">Droite</option>
            </select>
          </label>
          <label className="flex flex-col text-sm">
            Orientation
            <select value={orientation} onChange={(e) => setOrientation(e.target.value as "N" | "S" | "E" | "O")} className="rounded border border-slate-300 px-2 py-1 text-sm">
              <option value="N">Nord</option>
              <option value="S">Sud</option>
              <option value="E">Est</option>
              <option value="O">Ouest</option>
            </select>
          </label>
        </div>
        {(accessSide === "left" || accessSide === "right") && (
          <p className="text-xs text-amber-700">
            Limite connue : pour un accès latéral, la distribution intérieure reste organisée comme pour un accès
            frontal ; seule la porte d&apos;entrée est déplacée sur le mur latéral. La cour d&apos;entrée et le salon
            central (ci-dessous) ne sont pris en charge que pour un accès avant.
          </p>
        )}

        <h3 className="mt-2 text-sm font-semibold">Reculs (séparés, jamais une valeur unique)</h3>
        <div className="flex flex-wrap gap-4">
          <label className="flex flex-col text-sm">Avant (m){numberInput(front, setFront, 0.5)}</label>
          <label className="flex flex-col text-sm">Arrière (m){numberInput(back, setBack, 0.5)}</label>
          <label className="flex flex-col text-sm">Gauche (m){numberInput(left, setLeft, 0.5)}</label>
          <label className="flex flex-col text-sm">Droite (m){numberInput(right, setRight, 0.5)}</label>
        </div>
        <p className="text-xs text-slate-500">
          Emprise disponible = terrain − reculs = {Math.max(0, terrainWidth - left - right).toFixed(1)} ×{" "}
          {Math.max(0, terrainDepth - front - back).toFixed(1)} m ={" "}
          {Math.max(0, (terrainWidth - left - right) * (terrainDepth - front - back)).toFixed(1)} m².
        </p>
      </section>

      <section className="flex flex-col gap-3 rounded border border-slate-300 p-4">
        <h2 className="font-semibold">Organisation (parcours rue → logement)</h2>
        <p className="text-xs text-slate-500">
          Deux pièces qui se touchent ne sont pas nécessairement communicantes : ces choix décident explicitement par
          quelle porte chaque pièce est reliée. Le déplacement libre des pièces à la souris n&apos;est pas encore
          proposé — cette organisation guidée prépare seulement la structure pour cette tranche ultérieure.
        </p>
        <label className="flex flex-col text-sm">
          Entrée
          <select value={entryMode} onChange={(e) => setEntryMode(e.target.value as EntryMode)} className="rounded border border-slate-300 px-2 py-1 text-sm">
            <option value="direct">Directement dans le logement</option>
            <option value="courtyard">Par une cour d&apos;entrée dimensionnée</option>
          </select>
        </label>
        {entryMode === "courtyard" ? (
          <label className="flex flex-col text-sm">
            Profondeur de la cour (m)
            {numberInput(courtyardDepth, setCourtyardDepth, 0.5)}
          </label>
        ) : null}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={centralSalon} onChange={(e) => setCentralSalon(e.target.checked)} />
          Salon central souhaité
        </label>
        {centralSalon ? (
          <>
            <label className="flex flex-col text-sm">
              Accès aux chambres et à la cuisine
              <select value={roomsConnectVia} onChange={(e) => setRoomsConnectVia(e.target.value as RoomConnection)} className="rounded border border-slate-300 px-2 py-1 text-sm">
                <option value="corridor">Depuis un dégagement (couloir)</option>
                <option value="salon">Depuis le salon (une pièce au plus dans cette version)</option>
              </select>
            </label>
            <label className="flex flex-col text-sm">
              Accès aux sanitaires
              <select value={sanitaireConnectVia} onChange={(e) => setSanitaireConnectVia(e.target.value as RoomConnection)} className="rounded border border-slate-300 px-2 py-1 text-sm">
                <option value="corridor">Par un dégagement (couloir)</option>
                <option value="salon">Accès direct depuis le salon (une pièce au plus dans cette version)</option>
              </select>
            </label>
            <p className="text-xs text-amber-700">
              Limite connue : au plus une pièce de chaque côté du salon peut lui être directement reliée dans cette
              version ; les pièces supplémentaires demandées en accès direct restent reliées par le dégagement — signalé
              explicitement, jamais ignoré.
            </p>
          </>
        ) : null}
      </section>

      <section className="flex flex-col gap-3 rounded border border-slate-300 p-4">
        <h2 className="font-semibold">Besoins (pièces)</h2>
        <p className="text-xs text-slate-500">
          Dimensions cibles respectées en priorité (élongation maximale ±25% au-delà de la cible, jamais un
          remplissage automatique de l&apos;emprise) — hypothèses de conception, pas une norme. À 0, une pièce est
          exclue du calcul et ses dimensions sont désactivées.
        </p>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-500">
              <th>Pièce</th>
              <th>Nombre</th>
              <th>Largeur minimale (m)</th>
              <th>Profondeur minimale (m)</th>
              <th>Largeur cible (m)</th>
              <th>Profondeur cible (m)</th>
            </tr>
          </thead>
          <tbody>
            {rooms.map((room, i) => {
              const disabled = room.count === 0;
              return (
                <tr key={room.type} className={disabled ? "opacity-60" : ""}>
                  <td className="py-1">{room.label}</td>
                  <td><input type="number" min={0} value={room.count} onChange={(e) => updateRoom(i, { count: Number(e.target.value) })} className="w-16 rounded border border-slate-300 px-2 py-1" /></td>
                  <td>{numberInput(room.minWidth, (v) => updateRoom(i, { minWidth: v }), 0.1, disabled)}</td>
                  <td>{numberInput(room.minDepth, (v) => updateRoom(i, { minDepth: v }), 0.1, disabled)}</td>
                  <td>{numberInput(room.targetWidth, (v) => updateRoom(i, { targetWidth: v }), 0.1, disabled)}</td>
                  <td>{numberInput(room.targetDepth, (v) => updateRoom(i, { targetDepth: v }), 0.1, disabled)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <button onClick={handleGenerate} className="w-fit rounded bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700">
        Générer les variantes
      </button>

      {draft ? (
        <PlanEditor initialLayout={draft} orientation={orientation} onExit={() => setDraft(null)} />
      ) : (
      <>
      {variants && variants.length === 0 ? (
        <section className="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-900">
          <p className="font-semibold">Aucune solution trouvée par ce moteur avec ces paramètres.</p>
          <p className="mt-1 text-xs">
            Ceci ne signifie pas que le projet est architecturalement impossible — seulement que ce moteur, avec cet
            algorithme et ces hypothèses, n&apos;a pas trouvé de disposition satisfaisante. Aucun minimum ni aucune
            pièce demandée n&apos;a été réduit ou supprimé pour arriver à ce constat.
          </p>
          {failureReasons.length > 0 || rejectedVariants.length > 0 ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs font-semibold">Détails techniques ({failureReasons.length + rejectedVariants.length} motif(s))</summary>
              {failureReasons.length > 0 ? <ul className="mt-2 list-disc pl-5 text-xs">{failureReasons.map((r) => <li key={r}>{r}</li>)}</ul> : null}
              {rejectedVariants.length > 0 ? (
                <>
                  <p className="mt-2 text-xs font-semibold">
                    {rejectedVariants.length} disposition(s) géométriquement construite(s) mais écartée(s) (règle fenêtre, accès véhicule ou accès non garanti) :
                  </p>
                  <ul className="mt-1 list-disc pl-5 text-xs">
                    {rejectedVariants.slice(0, 5).map((v, i) => (
                      <li key={i}>{v.rejectionReasons.join(" ")}</li>
                    ))}
                  </ul>
                </>
              ) : null}
            </details>
          ) : null}
        </section>
      ) : null}

      {variants && variants.length > 0 ? (
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            {variants.map((v, i) => (
              <button key={v.variantLabel} onClick={() => { setSelectedIndex(i); setZoom(1); }} className={`rounded border px-3 py-1 text-sm ${i === selectedIndex ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300"}`}>
                {v.variantLabel}
              </button>
            ))}
          </div>
          {rejectedVariants.length > 0 ? (
            <details className="text-xs text-slate-500">
              <summary className="cursor-pointer">{rejectedVariants.length} autre(s) disposition(s) trouvée(s) mais écartée(s) des propositions — détails</summary>
              <ul className="mt-1 list-disc pl-5">
                {rejectedVariants.slice(0, 5).map((v, i) => (
                  <li key={i}>{v.rejectionReasons.join(" ")}</li>
                ))}
              </ul>
            </details>
          ) : null}

          {selected ? (
            <>
              <div className="flex items-center gap-2">
                <button onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))} className="rounded border border-slate-400 px-2 py-1 text-sm">−</button>
                <span className="text-sm">{Math.round(zoom * 100)}%</span>
                <button onClick={() => setZoom((z) => Math.min(3, z + 0.25))} className="rounded border border-slate-400 px-2 py-1 text-sm">+</button>
                <button onClick={() => setZoom(1)} className="rounded border border-slate-400 px-2 py-1 text-sm">Réinitialiser</button>
                <button onClick={() => setDraft(selected)} className="ml-auto rounded bg-slate-900 px-3 py-1 text-sm font-semibold text-white">
                  Modifier ce plan
                </button>
              </div>
              <div className="overflow-auto rounded border border-slate-300 bg-white p-2" style={{ maxHeight: "70vh" }}>
                <div style={{ width: `${zoom * 100}%` }} dangerouslySetInnerHTML={{ __html: svgMarkup }} />
              </div>

              {legend.length > 0 ? (
                <div>
                  <h3 className="font-semibold">Légende (petites pièces numérotées sur le plan)</h3>
                  <ul className="mt-1 text-sm">
                    {legend.map((e) => (
                      <li key={e.key}>
                        <strong>{e.key.split("-")[1]}</strong> — {e.label} : {e.w.toFixed(2)} × {e.d.toFixed(2)} m ({e.area.toFixed(1)} m²)
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="flex gap-2">
                <button onClick={handleExportSvg} className="rounded border border-slate-400 px-3 py-1 text-sm">Exporter en SVG</button>
                <button onClick={handleExportPng} className="rounded border border-slate-400 px-3 py-1 text-sm">Exporter en PNG</button>
              </div>
              <canvas ref={canvasRef} className="hidden" />

              <div>
                <h3 className="font-semibold">Surfaces (mêmes données que le dessin ci-dessus)</h3>
                <table className="mt-1 w-full text-sm">
                  <tbody>
                    <tr><td>Terrain</td><td>{selected.surfaces.terrain.toFixed(1)} m²</td></tr>
                    <tr><td>Emprise disponible</td><td>{selected.surfaces.emprise.toFixed(1)} m²</td></tr>
                    {selected.footprint ? (
                      <tr>
                        <td>Contour englobant (rectangle, {selected.footprint.w.toFixed(1)}×{selected.footprint.d.toFixed(1)} m)</td>
                        <td>{(selected.footprint.w * selected.footprint.d).toFixed(1)} m²</td>
                      </tr>
                    ) : null}
                    {selected.surfaces.cour > 0 ? (
                      <tr><td>Cour d&apos;entrée</td><td>{selected.surfaces.cour.toFixed(1)} m²</td></tr>
                    ) : null}
                    <tr><td>Union pièces + circulations (hors murs)</td><td>{selected.surfaces.batie.toFixed(1)} m²</td></tr>
                    <tr><td>Surface utile habitable</td><td>{selected.surfaces.utileHabitable.toFixed(1)} m²</td></tr>
                    <tr><td>Circulation (union réelle)</td><td>{selected.surfaces.circulation.toFixed(1)} m²</td></tr>
                    {selected.surfaces.nonAffectee > 0.05 ? (
                      <tr><td>Résiduel non affecté (dans le contour englobant)</td><td>{selected.surfaces.nonAffectee.toFixed(1)} m²</td></tr>
                    ) : null}
                    <tr><td>Espaces extérieurs hors contour (hors cour)</td><td>{selected.surfaces.exterieure.toFixed(1)} m²</td></tr>
                  </tbody>
                </table>
                <p className="mt-1 text-xs text-slate-500">
                  Le « contour englobant » est le plus petit rectangle qui contient toutes les pièces et circulations — pas une mesure de compacité en soi, juste sa taille. « Union pièces + circulations » est l&apos;union géométrique réelle des pièces et des circulations à l&apos;intérieur de ce contour (jamais un chevauchement compté deux fois) — elle ne compte PAS l&apos;épaisseur des murs et n&apos;est donc pas une surface bâtie complète au sens réglementaire. Cour, cette union, résiduel non affecté et espaces extérieurs sont mutuellement exclusifs : leur somme égale l&apos;emprise disponible.
                </p>
              </div>

              <div>
                <h3 className="font-semibold">Vérification indépendante</h3>
                {issues.length === 0 ? (
                  <p className="text-sm text-green-700">Aucun problème détecté par la passe de vérification indépendante (chevauchements, limites, portes, accès depuis l&apos;entrée, ouvertures extérieures, accès véhicule).</p>
                ) : (
                  <ul className="mt-1 list-disc pl-5 text-sm">
                    {issues.map((issue, i) => (
                      <li key={i} className={issue.severity === "error" ? "text-red-700" : "text-amber-700"}>{issue.message}</li>
                    ))}
                  </ul>
                )}
              </div>

              <p className="text-xs font-semibold text-red-700">{STAMP}</p>
            </>
          ) : null}
        </section>
      ) : null}
      </>
      )}
    </div>
  );
}
