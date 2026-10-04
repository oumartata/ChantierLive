"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { Button, AlertBanner, TextField } from "@/components/ui";
import { saveDraftAction, publishPlanAction, updateProgressAction, restructurePlanAction, type PhaseActionState } from "./actions";
import { formatPercent } from "./phasePlanDiff";

type Action = (prev: PhaseActionState, formData: FormData) => Promise<PhaseActionState>;

function useOp(action: Action) {
  const [state, formAction, pending] = useActionState<PhaseActionState, FormData>(action, null);
  return { state, formAction, pending, error: state && "error" in state ? state.error : null };
}

interface Row {
  phaseId: string | null;
  label: string;
  weight: string;
  progression: number;
}

const DEFAULT_ROWS: Row[] = [
  { phaseId: null, label: "Préparation du chantier", weight: "", progression: 0 },
  { phaseId: null, label: "Fondations", weight: "", progression: 0 },
  { phaseId: null, label: "Gros œuvre", weight: "", progression: 0 },
  { phaseId: null, label: "Toiture / étanchéité", weight: "", progression: 0 },
  { phaseId: null, label: "Second œuvre", weight: "", progression: 0 },
  { phaseId: null, label: "Finitions", weight: "", progression: 0 },
];

function sumWeights(rows: Row[]): number {
  return rows.reduce((acc, r) => acc + (Number(r.weight) || 0), 0);
}

function toPhasesJson(rows: Row[], includeProgression: boolean) {
  return JSON.stringify(
    rows.map((r, i) => ({
      ...(r.phaseId ? { phase_id: r.phaseId } : {}),
      position: i + 1,
      label: r.label,
      weight: Number(r.weight) || 0,
      ...(includeProgression ? { progression: r.progression } : {}),
    }))
  );
}

function RowEditor({ rows, setRows }: { rows: Row[]; setRows: (rows: Row[]) => void }) {
  const sum = sumWeights(rows);
  return (
    <div className="flex flex-col gap-3">
      {rows.map((row, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-small border border-sand p-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <TextField
              label={`Étape ${i + 1}`}
              value={row.label}
              onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, label: e.target.value } : r)))}
              maxLength={200}
              required
            />
          </div>
          <div className="w-full sm:w-32">
            <TextField
              label="Poids (%)"
              type="number"
              min={0}
              max={100}
              value={row.weight}
              onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, weight: e.target.value } : r)))}
              required
            />
          </div>
          <div className="flex gap-1">
            <Button type="button" variant="ghost" size="compact" disabled={i === 0} onClick={() => setRows(rows.map((r, j) => (j === i - 1 ? rows[i] : j === i ? rows[i - 1] : r)))}>
              ↑
            </Button>
            <Button type="button" variant="ghost" size="compact" disabled={i === rows.length - 1} onClick={() => setRows(rows.map((r, j) => (j === i + 1 ? rows[i] : j === i ? rows[i + 1] : r)))}>
              ↓
            </Button>
            <Button type="button" variant="ghost" size="compact" onClick={() => setRows(rows.filter((_, j) => j !== i))} disabled={rows.length <= 1}>
              Retirer
            </Button>
          </div>
        </div>
      ))}
      <Button type="button" variant="secondary" size="compact" onClick={() => setRows([...rows, { phaseId: null, label: "", weight: "", progression: 0 }])}>
        Ajouter une étape
      </Button>
      <p className={`text-caption font-semibold ${sum === 100 ? "text-success" : "text-attention"}`} data-testid="weight-sum">
        Somme des poids : {sum} % {sum === 100 ? "" : "— doit être exactement 100 % avant publication"}
      </p>
    </div>
  );
}

export function DraftEditor({ projectId, expectedRevision, initialRows }: { projectId: string; expectedRevision: number; initialRows: Row[] }) {
  const [rows, setRows] = useState<Row[]>(initialRows.length > 0 ? initialRows : DEFAULT_ROWS);
  const save = useOp(saveDraftAction);
  const publish = useOp(publishPlanAction);
  const sum = sumWeights(rows);

  return (
    <div className="flex flex-col gap-4">
      {save.error ? <AlertBanner variant="error" title="Enregistrement impossible" explanation={save.error} /> : null}
      {publish.error ? <AlertBanner variant="error" title="Publication impossible" explanation={publish.error} /> : null}
      {save.state && "ok" in save.state && !save.pending ? (
        <AlertBanner variant="information" title="Brouillon enregistré" explanation="Les étapes et les poids affichés sont enregistrés. Ils ne sont pas encore visibles par le propriétaire." />
      ) : null}
      <RowEditor rows={rows} setRows={setRows} />
      <form action={save.formAction}>
        <input type="hidden" name="project_id" value={projectId} />
        <input type="hidden" name="expected_revision" value={expectedRevision} />
        <input type="hidden" name="phases" value={toPhasesJson(rows, false)} />
        <Button type="submit" variant="secondary" loading={save.pending}>
          Enregistrer le brouillon
        </Button>
      </form>
      <form action={publish.formAction}>
        <input type="hidden" name="project_id" value={projectId} />
        <input type="hidden" name="expected_revision" value={expectedRevision} />
        <input type="hidden" name="phases" value={toPhasesJson(rows, false)} />
        <Button type="submit" loading={publish.pending} disabled={sum !== 100}>
          Publier (verrouille les poids, démarre l&apos;avancement)
        </Button>
      </form>
    </div>
  );
}

export function RestructureEditor({ projectId, expectedRevision, initialRows, onCancel }: { projectId: string; expectedRevision: number; initialRows: Row[]; onCancel: () => void }) {
  const [rows, setRows] = useState<Row[]>(initialRows);
  const [reason, setReason] = useState("");
  const op = useOp(restructurePlanAction);
  const sum = sumWeights(rows);
  // Fermeture après succès : laisser le formulaire ouvert, motif conservé,
  // permettait un second envoi identique enregistré comme une nouvelle
  // modification dans l'historique.
  useEffect(() => {
    if (op.state && "ok" in op.state) onCancel();
  }, [op.state, onCancel]);
  const impact = useMemo(() => {
    const total = rows.reduce((acc, r) => acc + (Number(r.weight) || 0) * r.progression, 0);
    return Math.round((total / 100) * 100) / 100;
  }, [rows]);

  return (
    <div className="flex flex-col gap-4 rounded-small border border-attention p-4">
      <AlertBanner
        variant="warning"
        title="Modification des étapes après démarrage"
        explanation="Les progressions déjà déclarées sont conservées. Cette modification sera historisée avec le motif indiqué — elle ne peut jamais être annulée ni recalculée après coup."
      />
      {op.error ? <AlertBanner variant="error" title="Restructuration impossible" explanation={op.error} /> : null}
      <RowEditor rows={rows} setRows={setRows} />
      <TextField label="Motif de la modification" value={reason} onChange={(e) => setReason(e.target.value)} required />
      <p className="text-label font-semibold text-ink" data-testid="restructure-impact">
        Impact immédiat sur l&apos;avancement global après confirmation : {formatPercent(impact)}
      </p>
      <form action={op.formAction} className="flex gap-3">
        <input type="hidden" name="project_id" value={projectId} />
        <input type="hidden" name="expected_revision" value={expectedRevision} />
        <input type="hidden" name="phases" value={toPhasesJson(rows, false)} />
        <input type="hidden" name="reason" value={reason} />
        <Button type="submit" loading={op.pending} disabled={sum !== 100 || reason.trim().length < 1}>
          Confirmer la modification ({sum} %)
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Annuler
        </Button>
      </form>
    </div>
  );
}

export function ProgressForm({ projectId, phaseId, label, expectedRevision, initialProgression, canEdit }: { projectId: string; phaseId: string; label: string; expectedRevision: number; initialProgression: number; canEdit: boolean }) {
  const [value, setValue] = useState(String(initialProgression));
  const op = useOp(updateProgressAction);
  if (!canEdit) {
    return (
      <div className="flex items-center justify-between gap-3">
        <span className="text-body text-ink">{label}</span>
        <span className="shrink-0 whitespace-nowrap text-body font-semibold text-ink">{formatPercent(initialProgression)}</span>
      </div>
    );
  }
  return (
    <form action={op.formAction} className="flex flex-col gap-1">
      {op.error ? <AlertBanner variant="error" title="Mise à jour impossible" explanation={op.error} /> : null}
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <TextField label={label} type="number" min={0} max={100} name="progression" value={value} onChange={(e) => setValue(e.target.value)} />
        </div>
        <input type="hidden" name="project_id" value={projectId} />
        <input type="hidden" name="phase_id" value={phaseId} />
        <input type="hidden" name="expected_revision" value={expectedRevision} />
        <Button type="submit" size="compact" loading={op.pending}>
          Mettre à jour
        </Button>
      </div>
    </form>
  );
}

export function RestructureToggle({ projectId, expectedRevision, initialRows }: { projectId: string; expectedRevision: number; initialRows: Row[] }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button type="button" variant="ghost" size="compact" onClick={() => setOpen(true)}>
        Modifier les étapes ou les poids
      </Button>
    );
  }
  return <RestructureEditor projectId={projectId} expectedRevision={expectedRevision} initialRows={initialRows} onCancel={() => setOpen(false)} />;
}

export { DEFAULT_ROWS };
export type { Row };
