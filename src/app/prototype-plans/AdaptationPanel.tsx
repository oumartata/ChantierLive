"use client";

// F2 — panneau d'autorisation d'adaptation des dimensions (2026-10-06).
// Aucune pièce ni dimension autorisée par défaut : les champs vides valent
// « non autorisée ». Rien n'est enregistré avant « Confirmer ces
// autorisations » ; rien n'est recherché avant « Rechercher des
// dispositions adaptées ». Les minima du moteur sont affichés comme plancher
// technique, jamais comme un accord ni une norme.
import { useState } from "react";
import { allowanceStates, type AllowanceInput } from "./adaptation";
import { ADAPTED_DEFAULT_BUDGET_MILLIS, ADAPTED_MAX_DIMENSION_SETS, type Layout } from "./geometry";

const m = (v: number) => `${v.toFixed(2).replace(".", ",")} m`;

export type AdaptedSearchState =
  | { status: "idle" }
  | { status: "running"; startedAt: number }
  | { status: "cancelled" }
  | { status: "stale" }
  | { status: "error"; message: string };

export function AdaptationPanel({
  layout,
  canSearch,
  search,
  onConfirm,
  onRevoke,
  onSearch,
  onCancelSearch,
  now,
}: {
  layout: Layout;
  canSearch: string | null;
  search: AdaptedSearchState;
  onConfirm: (inputs: AllowanceInput[]) => string | null;
  onRevoke: (roomIndex?: number) => void;
  onSearch: () => void;
  onCancelSearch: () => void;
  now: number;
}) {
  const states = allowanceStates(layout);
  const byRoom = new Map(states.map((s) => [s.entry.roomIndex, s]));
  const rooms = layout.rooms.map((r, i) => ({ r, i })).filter(({ r }) => !r.parked);
  const initial = () =>
    Object.fromEntries(
      rooms.map(({ i }) => {
        const e = byRoom.get(i)?.entry;
        return [i, { w: e?.minW != null ? String(e.minW) : "", d: e?.minD != null ? String(e.minD) : "" }];
      })
    ) as Record<number, { w: string; d: string }>;
  const [fields, setFields] = useState<Record<number, { w: string; d: string }>>(initial);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const valid = states.filter((s) => s.status.kind === "valide").length;
  const running = search.status === "running";

  function parse(v: string): number | null | "invalide" {
    const t = v.trim().replace(",", ".");
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : "invalide";
  }

  function confirm() {
    const inputs: AllowanceInput[] = [];
    for (const { r, i } of rooms) {
      if (r.locked) continue;
      const f = fields[i] ?? { w: "", d: "" };
      const w = parse(f.w);
      const d = parse(f.d);
      if (w === "invalide" || d === "invalide") {
        setMessage({ kind: "error", text: `Valeur non numérique pour « ${r.label} ${r.number} » : rien n'a été enregistré.` });
        return;
      }
      if (w !== null || d !== null) inputs.push({ roomIndex: i, minW: w, minD: d });
    }
    const err = onConfirm(inputs);
    setMessage(err ? { kind: "error", text: `Refusé, rien n'a été enregistré : ${err}` } : { kind: "ok", text: "Autorisations confirmées et enregistrées dans le brouillon (annulable avec Annuler)." });
  }

  return (
    <section data-testid="adaptation-panel" className="flex min-w-0 flex-col gap-3 rounded border-2 border-amber-400 bg-amber-50 p-2 text-sm sm:p-4">
      <h3 className="font-semibold text-amber-950">Autoriser une adaptation des dimensions (expérimental)</h3>
      <p className="text-xs text-amber-900">
        Par défaut, la régénération garde les dimensions de chaque pièce. Ici, vous pouvez autoriser — pièce par pièce, dimension
        par dimension — une <strong>réduction</strong> jusqu&apos;à une borne que vous fixez. Champ vide = dimension non autorisée.
        Aucune pièce n&apos;est autorisée tant que vous ne confirmez pas. Le « minimum technique » est un plancher du moteur, pas un
        accord de votre part ni une norme. Les pièces verrouillées ne sont jamais adaptées.
      </p>
      <ul className="grid grid-cols-1 gap-2 lg:grid-cols-2">
        {rooms.map(({ r, i }) => {
          const st = byRoom.get(i);
          const f = fields[i] ?? { w: "", d: "" };
          return (
            <li key={i} data-testid={`adapt-room-${i}`} className="flex min-w-0 flex-col gap-1 rounded border border-amber-200 bg-white p-2 text-xs">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <strong className="text-sm">
                  {r.label} {r.number}
                </strong>
                <span
                  data-testid={`adapt-status-${i}`}
                  className={
                    r.locked
                      ? "text-slate-600"
                      : !st
                        ? "text-slate-500"
                        : st.status.kind === "valide"
                          ? "text-emerald-700"
                          : "text-red-700"
                  }
                >
                  {r.locked
                    ? "exclue (verrouillée)"
                    : !st
                      ? "non autorisée"
                      : st.status.kind === "valide"
                        ? "autorisation valide"
                        : `${st.status.kind === "exclue" ? "exclue" : "à reconfirmer"} — ${st.status.reason}`}
                </span>
              </div>
              <p>
                Actuelle : {m(r.w)} × {m(r.d)}
                {st ? (
                  <>
                    {" "}
                    — référence autorisée : {m(st.entry.referenceW)} × {m(st.entry.referenceD)}
                  </>
                ) : null}{" "}
                — minimum technique : {m(r.minW)} × {m(r.minD)}
              </p>
              {r.locked ? null : (
                <div className="flex flex-wrap items-end gap-2">
                  <label className="flex flex-col">
                    Largeur minimale autorisée (m)
                    <input
                      inputMode="decimal"
                      value={f.w}
                      placeholder="non autorisée"
                      onChange={(e) => setFields((p) => ({ ...p, [i]: { ...f, w: e.target.value } }))}
                      className="w-32 rounded border border-slate-300 px-2 py-1"
                    />
                  </label>
                  <label className="flex flex-col">
                    Profondeur minimale autorisée (m)
                    <input
                      inputMode="decimal"
                      value={f.d}
                      placeholder="non autorisée"
                      onChange={(e) => setFields((p) => ({ ...p, [i]: { ...f, d: e.target.value } }))}
                      className="w-32 rounded border border-slate-300 px-2 py-1"
                    />
                  </label>
                  {st ? (
                    <button type="button" onClick={() => onRevoke(i)} className="rounded border border-red-300 px-2 py-1 text-red-800">
                      Révoquer
                    </button>
                  ) : null}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={confirm} disabled={running} className="rounded bg-amber-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-40">
          Confirmer ces autorisations
        </button>
        {states.length > 0 ? (
          <button type="button" onClick={() => onRevoke()} disabled={running} className="rounded border border-red-400 bg-white px-3 py-2 text-sm text-red-800 disabled:opacity-40">
            Révoquer toutes les autorisations
          </button>
        ) : null}
      </div>
      {message ? (
        <p role={message.kind === "error" ? "alert" : "status"} data-testid="adapt-message" className={`rounded p-2 text-xs ${message.kind === "error" ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-800"}`}>
          {message.text}
        </p>
      ) : null}
      <div className="flex flex-col gap-2 border-t border-amber-200 pt-2">
        <p className="text-xs text-amber-900">
          Recherche bornée, jamais exhaustive : au plus {ADAPTED_MAX_DIMENSION_SETS} jeux de dimensions (chaque dimension autorisée
          à sa référence ou à sa borne). Elle s&apos;arrête entre deux jeux une fois environ {ADAPTED_DEFAULT_BUDGET_MILLIS / 1000} s écoulées ; un jeu
          commencé va à son terme, la durée réelle peut donc dépasser cette valeur. Les propositions sans réduction sont aussi
          présentées.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onSearch}
            disabled={running || valid === 0 || canSearch !== null}
            className="rounded bg-indigo-800 px-3 py-2 text-sm font-semibold text-white disabled:opacity-40"
          >
            Rechercher des dispositions adaptées ({valid} autorisation(s) valide(s))
          </button>
          {running ? (
            <>
              <span role="status" data-testid="adapt-running" className="text-xs">
                Recherche en cours… {Math.max(0, Math.round((now - search.startedAt) / 1000))} s
              </span>
              <button type="button" onClick={onCancelSearch} className="rounded border border-slate-400 bg-white px-3 py-2 text-sm">
                Annuler la recherche
              </button>
            </>
          ) : null}
        </div>
        {canSearch && valid > 0 ? <p className="text-xs text-slate-600">{canSearch}</p> : null}
        {search.status === "cancelled" ? (
          <p role="status" data-testid="adapt-cancelled" className="text-xs text-slate-700">Recherche annulée : aucun résultat n&apos;est présenté ni appliqué.</p>
        ) : null}
        {search.status === "stale" ? (
          <p role="alert" data-testid="adapt-stale" className="text-xs text-red-700">
            Résultat périmé : le plan a changé pendant la recherche. Il n&apos;est ni présenté ni appliqué — relancez la recherche.
          </p>
        ) : null}
        {search.status === "error" ? <p role="alert" className="text-xs text-red-700">Échec de la recherche : {search.message}</p> : null}
      </div>
    </section>
  );
}
