"use client";

import { useActionState, useState, useTransition } from "react";
import { AlertBanner, Button, ConfirmDialog, TextField } from "@/components/ui";
import {
  assignIncidentAction,
  correctIncidentAction,
  createIncidentAction,
  transitionIncidentAction,
  type IncidentActionState,
} from "./actions";
import { INCIDENT_TYPES, SEVERITIES, toLocalInput } from "./labels";

export interface IncidentView {
  id: string;
  incident_type: string;
  severity: string;
  occurred_at: string;
  description: string;
  status: string;
  revision: number;
  assignee_profile_id: string | null;
  due_date: string | null;
  can_update: boolean;
  can_close: boolean;
  can_assign: boolean;
}

export interface MemberOption {
  profile_id: string;
  label: string;
}

const FIELD = "w-full rounded-small border border-muted/40 bg-surface px-4 py-2 text-body font-normal text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

function Select({ name, label, options, defaultValue, required }: { name: string; label: string; options: { value: string; label: string }[]; defaultValue?: string; required?: boolean }) {
  return (
    <label className="flex flex-col gap-1 text-label font-semibold text-ink">
      {label}
      <select name={name} defaultValue={defaultValue ?? ""} required={required} className={`${FIELD} h-12`}>
        {required ? null : <option value="">—</option>}
        {required && !defaultValue ? <option value="" disabled>Choisir…</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function TextArea({ name, label, defaultValue, required, minLength, maxLength }: { name: string; label: string; defaultValue?: string; required?: boolean; minLength?: number; maxLength: number }) {
  return (
    <label className="flex flex-col gap-1 text-label font-semibold text-ink">
      {label}
      <textarea name={name} defaultValue={defaultValue} required={required} minLength={minLength} maxLength={maxLength} rows={3} className={FIELD} />
    </label>
  );
}

function Feedback({ state, title }: { state: IncidentActionState; title: string }) {
  if (state && "error" in state) return <AlertBanner variant="error" title={title} explanation={state.error} />;
  return null;
}

function Hidden({ projectId, incident }: { projectId: string; incident: IncidentView }) {
  return (
    <>
      <input type="hidden" name="project_id" value={projectId} />
      <input type="hidden" name="incident_id" value={incident.id} />
      <input type="hidden" name="expected_revision" value={incident.revision} />
    </>
  );
}

function IncidentFields({ incident, now }: { incident?: IncidentView; now: string }) {
  return (
    <>
      <Select name="incident_type" label="Type" options={INCIDENT_TYPES} defaultValue={incident?.incident_type} required />
      <Select name="severity" label="Gravité" options={SEVERITIES} defaultValue={incident?.severity} required />
      <TextField label="Date et heure (UTC, heure de Bamako)" name="occurred_at" type="datetime-local" required max={now} defaultValue={incident ? toLocalInput(incident.occurred_at) : now} />
      <TextArea name="description" label="Description" defaultValue={incident?.description} required minLength={5} maxLength={2000} />
    </>
  );
}

// SCR041 : création directe OUVERT (D161), aucune étape (D166).
export function NewIncidentForm({ projectId, now, closedIncidents, linkedId }: { projectId: string; now: string; closedIncidents: { value: string; label: string }[]; linkedId: string | null }) {
  const [state, formAction, pending] = useActionState<IncidentActionState, FormData>(createIncidentAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-3" data-testid="nouvel-incident">
      <input type="hidden" name="project_id" value={projectId} />
      <IncidentFields now={now} />
      {closedIncidents.length > 0 ? (
        <Select name="linked_incident_id" label="Lié à un incident clos (si le problème revient)" options={closedIncidents} defaultValue={linkedId ?? undefined} />
      ) : null}
      <p className="text-caption text-muted">Un incident urgent est signalé comme tel ; ChantierLive n&apos;alerte aucun service de secours.</p>
      <Feedback state={state} title="Déclaration impossible" />
      <div>
        <Button type="submit" loading={pending}>
          Signaler l&apos;incident
        </Button>
      </div>
    </form>
  );
}

// D164 : correction avec motif, ancienne valeur conservée dans l'historique.
export function CorrectIncidentForm({ projectId, incident, now }: { projectId: string; incident: IncidentView; now: string }) {
  const [state, formAction, pending] = useActionState<IncidentActionState, FormData>(correctIncidentAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <Hidden projectId={projectId} incident={incident} />
      <IncidentFields incident={incident} now={now} />
      <TextField label="Motif de la correction" name="reason" required minLength={3} maxLength={1000} />
      <Feedback state={state} title="Correction impossible" />
      <div>
        <Button type="submit" size="compact" loading={pending}>
          Enregistrer la correction
        </Button>
      </div>
    </form>
  );
}

// D163 : l'entreprise ou le propriétaire principal désigne un membre actif.
export function AssignIncidentForm({ projectId, incident, members }: { projectId: string; incident: IncidentView; members: MemberOption[] }) {
  const [state, formAction, pending] = useActionState<IncidentActionState, FormData>(assignIncidentAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <Hidden projectId={projectId} incident={incident} />
      <Select name="assignee_profile_id" label="Responsable" options={members.map((m) => ({ value: m.profile_id, label: m.label }))} defaultValue={incident.assignee_profile_id ?? undefined} required />
      <TextField label="Échéance (facultative)" name="due_date" type="date" defaultValue={incident.due_date ?? ""} />
      <Feedback state={state} title="Désignation impossible" />
      <div>
        <Button type="submit" size="compact" loading={pending}>
          Enregistrer la désignation
        </Button>
      </div>
    </form>
  );
}

// Changement d'état avec saisie : démarrage (note facultative), résolution
// (texte obligatoire), reprise après résolution ou annulation (motif).
export function TransitionForm({
  projectId,
  incident,
  to,
  field,
  submitLabel,
  hint,
}: {
  projectId: string;
  incident: IncidentView;
  to: "EN_COURS" | "RESOLU" | "ANNULE";
  field: { name: "note" | "resolution"; label: string; required: boolean };
  submitLabel: string;
  hint?: string;
}) {
  const [state, formAction, pending] = useActionState<IncidentActionState, FormData>(transitionIncidentAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <Hidden projectId={projectId} incident={incident} />
      <input type="hidden" name="to_status" value={to} />
      <TextArea name={field.name} label={field.label} required={field.required} minLength={field.required ? 3 : undefined} maxLength={field.name === "note" ? 1000 : 2000} />
      {hint ? <p className="text-caption text-muted">{hint}</p> : null}
      <Feedback state={state} title="Changement d'état impossible" />
      <div>
        <Button type="submit" size="compact" variant={to === "ANNULE" ? "danger" : "primary"} loading={pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

// Clôture (D162) : définitive, confirmée.
export function CloseIncidentButton({ projectId, incident }: { projectId: string; incident: IncidentView }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <>
      <Button type="button" size="compact" loading={pending} onClick={() => setOpen(true)}>
        Clore l&apos;incident
      </Button>
      {error ? <AlertBanner variant="error" title="Clôture impossible" explanation={error} /> : null}
      <ConfirmDialog
        open={open}
        title="Clore cet incident ?"
        consequence="L'incident passe à l'état clos avec sa résolution ; l'historique reste visible par tous les membres du chantier."
        permanence="Un incident clos ne se rouvre pas : si le problème revient, signalez un nouvel incident lié."
        confirmLabel="Clore"
        onCancel={() => setOpen(false)}
        onConfirm={() => {
          setOpen(false);
          const fd = new FormData();
          fd.set("project_id", projectId);
          fd.set("incident_id", incident.id);
          fd.set("expected_revision", String(incident.revision));
          fd.set("to_status", "CLOS");
          startTransition(async () => {
            const result = await transitionIncidentAction(null, fd);
            if (result && "error" in result) setError(result.error);
          });
        }}
      />
    </>
  );
}
