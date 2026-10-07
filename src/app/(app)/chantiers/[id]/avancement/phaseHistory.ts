// B020 — « versions antérieures visibles » : historique d'une étape, état
// précédent -> nouvel état pour chaque modification, reconstruit à partir
// des événements append-only (project_phase_events, M033/M040/M041) tels
// qu'ils sont enregistrés — jamais recalculés ni réécrits. Logique PURE,
// testée par scripts/test-phase-history.mjs.

export interface PhaseEventInput {
  event_seq: number;
  event_type: string;
  phase_id: string | null;
  previous_value: unknown;
  new_value: unknown;
  actor_role: string;
  reason: string | null;
  created_at_server: string;
}

export type HistoryField = "label" | "weight" | "progression" | "status" | "planned_start" | "planned_end" | "position";

export interface HistoryChange {
  field: HistoryField;
  before: string | number | null;
  after: string | number | null;
}

export interface PhaseHistoryEntry {
  seq: number;
  kind: "PUBLICATION" | "AJOUT" | "MODIFICATION" | "RETRAIT" | "PROGRESSION" | "STATUT" | "DATES";
  actorRole: string;
  at: string;
  reason: string | null;
  changes: HistoryChange[];
}

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const asList = (v: unknown): Obj[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Obj[]) : []);
const val = (v: unknown): string | number | null => (v === undefined || v === null || v === "" ? null : typeof v === "number" ? v : String(v));
const same = (a: unknown, b: unknown) => {
  const x = val(a);
  const y = val(b);
  if (typeof x === "number" || typeof y === "number") return x !== null && y !== null ? Number(x) === Number(y) : x === y;
  return x === y;
};

const STRUCTURE_FIELDS: HistoryField[] = ["label", "weight", "position", "progression", "planned_start", "planned_end"];

function pushEntry(map: Map<string, PhaseHistoryEntry[]>, phaseId: string, entry: PhaseHistoryEntry) {
  const list = map.get(phaseId) ?? [];
  list.push(entry);
  map.set(phaseId, list);
}

// Historique par étape, du plus ancien au plus récent.
export function buildPhaseHistories(events: PhaseEventInput[]): Map<string, PhaseHistoryEntry[]> {
  const map = new Map<string, PhaseHistoryEntry[]>();
  for (const e of [...events].sort((a, b) => a.event_seq - b.event_seq)) {
    const base = { seq: e.event_seq, actorRole: e.actor_role, at: e.created_at_server, reason: e.reason };
    if (e.event_type === "PLAN_PUBLISHED") {
      for (const p of asList(e.new_value)) {
        const id = typeof p.phase_id === "string" ? p.phase_id : null;
        if (!id) continue;
        const changes: HistoryChange[] = (["label", "weight", "position", "planned_start", "planned_end"] as HistoryField[])
          .filter((f) => val(p[f]) !== null)
          .map((f) => ({ field: f, before: null, after: val(p[f]) }));
        changes.push({ field: "status", before: "BROUILLON", after: "PUBLIEE" });
        pushEntry(map, id, { ...base, kind: "PUBLICATION", changes });
      }
    } else if (e.event_type === "STRUCTURE_CHANGED") {
      const prev = new Map(asList(e.previous_value).filter((p) => typeof p.phase_id === "string").map((p) => [p.phase_id as string, p]));
      const next = new Map(asList(e.new_value).filter((p) => typeof p.phase_id === "string").map((p) => [p.phase_id as string, p]));
      for (const [id, n] of next) {
        const p = prev.get(id);
        if (!p) {
          const changes = (["label", "weight", "position"] as HistoryField[]).map((f) => ({ field: f, before: null, after: val(n[f]) }));
          pushEntry(map, id, { ...base, kind: "AJOUT", changes });
          continue;
        }
        const changes = STRUCTURE_FIELDS.filter((f) => f in n || f in p).filter((f) => !same(p[f], n[f])).map((f) => ({ field: f, before: val(p[f]), after: val(n[f]) }));
        if (changes.length > 0) pushEntry(map, id, { ...base, kind: "MODIFICATION", changes });
      }
      for (const [id, p] of prev) {
        if (!next.has(id)) {
          pushEntry(map, id, { ...base, kind: "RETRAIT", changes: [{ field: "label", before: val(p.label), after: null }] });
        }
      }
    } else if (e.phase_id) {
      const p = asObj(e.previous_value) ?? {};
      const n = asObj(e.new_value) ?? {};
      const kind = e.event_type === "PROGRESSION_UPDATED" ? "PROGRESSION" : e.event_type === "PHASE_SCHEDULE_CHANGED" ? "DATES" : "STATUT";
      const fields = Array.from(new Set([...Object.keys(p), ...Object.keys(n)])).filter((f): f is HistoryField =>
        (["label", "weight", "progression", "status", "planned_start", "planned_end", "position"] as string[]).includes(f)
      );
      const changes = fields.map((f) => ({ field: f, before: val(p[f]), after: val(n[f]) }));
      pushEntry(map, e.phase_id, { ...base, kind, changes });
    }
  }
  return map;
}

export const FIELD_LABEL: Record<HistoryField, string> = {
  label: "Libellé",
  weight: "Poids",
  progression: "Progression déclarée",
  status: "Statut",
  planned_start: "Début prévu",
  planned_end: "Fin prévue",
  position: "Position",
};

export const KIND_LABEL: Record<PhaseHistoryEntry["kind"], string> = {
  PUBLICATION: "Publication",
  AJOUT: "Étape ajoutée",
  MODIFICATION: "Étape modifiée",
  RETRAIT: "Étape retirée",
  PROGRESSION: "Progression mise à jour",
  STATUT: "Changement de statut",
  DATES: "Dates prévues modifiées",
};

const STATUS_LABEL: Record<string, string> = {
  BROUILLON: "Brouillon",
  PUBLIEE: "Publiée",
  TERMINEE: "Déclarée terminée",
  VALIDEE: "Validée",
  REFUSEE: "Refusée",
};

// Valeur affichée : « — » si absente ; pourcentages et dates en français.
export function formatHistoryValue(field: HistoryField, v: string | number | null): string {
  if (v === null) return "—";
  if (field === "weight" || field === "progression") {
    return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(Number(v))} %`;
  }
  if (field === "status") return STATUS_LABEL[String(v)] ?? String(v);
  if (field === "planned_start" || field === "planned_end") {
    const d = new Date(`${String(v).slice(0, 10)}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString("fr-FR", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });
  }
  return String(v);
}
