"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient, requireVerifiedAccount } from "@/lib/supabase/server";

// B024 (M038/M038b/M038c, D159–D167) — incidents. Chaque action passe par
// une fonction en base qui revérifie la session, le compte vérifié,
// l'adhésion active et le droit précis (modifier, clore, désigner) ;
// rien n'est déduit du navigateur.

export type IncidentActionState = { error: string } | { ok: true } | null;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

function mapIncidentError(code: string | undefined): string {
  switch (code) {
    case "not_authorized":
      return "Action non autorisée sur cet incident pour votre rôle.";
    case "account_provisional":
      return "Vérifiez votre identifiant (e-mail ou téléphone) avant de continuer.";
    case "revision_conflict":
      return "Cet incident a été modifié entre-temps. Rechargez la page puis recommencez.";
    case "incident_terminal":
      return "Cet incident est clos ou annulé : il ne peut plus évoluer. Signalez un nouvel incident lié si le problème revient.";
    case "invalid_transition":
      return "Ce changement d'état n'est pas possible depuis l'état actuel.";
    case "reason_required":
      return "Indiquez un motif (3 caractères au moins).";
    case "resolution_required":
      return "Décrivez la résolution (3 caractères au moins).";
    case "occurred_at_required":
      return "Indiquez la date et l'heure de l'incident.";
    case "occurred_in_future":
      return "La date de l'incident ne peut pas être dans le futur.";
    case "incident_invalid":
      return "Vérifiez le type, la gravité et la description (5 à 2 000 caractères).";
    case "linked_incident_invalid":
      return "Seul un incident clos de ce chantier peut être lié.";
    case "assignee_not_member":
      return "Le responsable doit être un membre actif du chantier.";
    case "phase_link_invalid":
      return "Cette étape ne peut pas être choisie (étape retirée, plan non publié ou autre chantier). Choisissez une étape active ou aucune.";
    case "no_change":
      return "Aucune modification à enregistrer.";
    default:
      return "Une erreur est survenue. Réessayez.";
  }
}

function text(formData: FormData, name: string): string | null {
  const v = formData.get(name);
  return typeof v === "string" ? v : null;
}

function readInt(formData: FormData, name: string): number | null {
  const raw = formData.get(name);
  return typeof raw === "string" && /^\d{1,9}$/.test(raw) ? Number(raw) : null;
}

// Saisie « date et heure » à l'heure de Bamako (UTC, sans heure d'été).
function readOccurredAt(formData: FormData): string | null {
  const v = text(formData, "occurred_at");
  return v && DATETIME_RE.test(v) ? `${v}:00Z` : null;
}

// D182 : étape facultative ; revérifiée en base (phase_link_check).
function readPhase(formData: FormData): string | null {
  const v = text(formData, "phase_id");
  return v && UUID_RE.test(v) ? v : null;
}

function ids(formData: FormData) {
  const projectId = text(formData, "project_id");
  const incidentId = text(formData, "incident_id");
  const revision = readInt(formData, "expected_revision");
  if (!projectId || !UUID_RE.test(projectId) || !incidentId || !UUID_RE.test(incidentId) || revision === null) return null;
  return { projectId, incidentId, revision };
}

export async function createIncidentAction(_prev: IncidentActionState, formData: FormData): Promise<IncidentActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const projectId = text(formData, "project_id");
  if (!projectId || !UUID_RE.test(projectId)) return { error: "Requête invalide." };
  const occurredAt = readOccurredAt(formData);
  if (!occurredAt) return { error: mapIncidentError("occurred_at_required") };
  const linked = text(formData, "linked_incident_id");
  const supabase = await createClient();
  const { error } = await supabase.rpc("create_incident", {
    p_project_id: projectId,
    p_incident_type: text(formData, "incident_type"),
    p_severity: text(formData, "severity"),
    p_occurred_at: occurredAt,
    p_description: text(formData, "description"),
    p_linked_incident_id: linked && UUID_RE.test(linked) ? linked : null,
    p_phase_id: readPhase(formData),
  });
  if (error) return { error: mapIncidentError(error.message) };
  revalidatePath(`/chantiers/${projectId}/incidents`);
  redirect(`/chantiers/${projectId}/incidents`);
}

export async function correctIncidentAction(_prev: IncidentActionState, formData: FormData): Promise<IncidentActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const k = ids(formData);
  if (!k) return { error: "Requête invalide." };
  const reason = text(formData, "reason");
  if (!reason || reason.trim().length < 3) return { error: mapIncidentError("reason_required") };
  const occurredAt = readOccurredAt(formData);
  if (!occurredAt) return { error: mapIncidentError("occurred_at_required") };
  const supabase = await createClient();
  const { error } = await supabase.rpc("correct_incident", {
    p_incident_id: k.incidentId,
    p_expected_revision: k.revision,
    p_reason: reason,
    p_incident_type: text(formData, "incident_type"),
    p_severity: text(formData, "severity"),
    p_occurred_at: occurredAt,
    p_description: text(formData, "description"),
    p_phase_id: readPhase(formData),
  });
  if (error) return { error: mapIncidentError(error.message) };
  revalidatePath(`/chantiers/${k.projectId}/incidents`);
  return { ok: true };
}

export async function assignIncidentAction(_prev: IncidentActionState, formData: FormData): Promise<IncidentActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const k = ids(formData);
  const assignee = text(formData, "assignee_profile_id");
  const due = text(formData, "due_date");
  if (!k || !assignee || !UUID_RE.test(assignee)) return { error: "Choisissez un responsable." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("assign_incident", {
    p_incident_id: k.incidentId,
    p_expected_revision: k.revision,
    p_assignee_profile_id: assignee,
    p_due_date: due && DATE_RE.test(due) ? due : null,
  });
  if (error) return { error: mapIncidentError(error.message) };
  revalidatePath(`/chantiers/${k.projectId}/incidents`);
  return { ok: true };
}

const TARGETS = new Set(["EN_COURS", "RESOLU", "CLOS", "ANNULE"]);

export async function transitionIncidentAction(_prev: IncidentActionState, formData: FormData): Promise<IncidentActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const k = ids(formData);
  const to = text(formData, "to_status");
  if (!k || !to || !TARGETS.has(to)) return { error: "Requête invalide." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("transition_incident", {
    p_incident_id: k.incidentId,
    p_expected_revision: k.revision,
    p_to_status: to,
    p_note: text(formData, "note"),
    p_resolution: text(formData, "resolution"),
  });
  if (error) return { error: mapIncidentError(error.message) };
  revalidatePath(`/chantiers/${k.projectId}/incidents`);
  return { ok: true };
}
