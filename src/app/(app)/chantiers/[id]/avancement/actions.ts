"use server";

import { revalidatePath } from "next/cache";
import { createClient, requireVerifiedAccount } from "@/lib/supabase/server";
import { isSameStructure, type CurrentPhase } from "./phasePlanDiff";

export type PhaseActionState = { error: string } | { ok: true } | null;

function mapPhaseError(message: string | undefined): string {
  switch (message) {
    case "account_provisional":
      return "Vérifiez votre identifiant (e-mail ou téléphone) avant de continuer.";
    case "not_authorized":
      return "Vous n'êtes pas autorisé à effectuer cette action.";
    case "revision_conflict":
      return "L'avancement a été modifié entre-temps. Rechargez la page puis réessayez.";
    case "plan_already_published":
      return "Le plan des étapes est déjà publié : utilisez la restructuration pour le modifier.";
    case "weight_sum_invalid":
      return "La somme des poids doit être exactement 100 % avant publication.";
    case "progression_out_of_range":
      return "La progression doit être comprise entre 0 et 100 %.";
    case "phase_invalid_label":
      return "Chaque étape doit avoir un intitulé (200 caractères au plus).";
    case "phase_invalid_weight":
      return "Chaque poids doit être compris entre 0 et 100 %.";
    case "phase_invalid_position":
      return "L'ordre des étapes est invalide.";
    case "phase_not_found":
      return "Cette étape n'existe plus pour ce chantier.";
    case "phases_required":
      return "Au moins une étape est nécessaire.";
    case "reason_required":
      return "Un motif est obligatoire pour modifier les étapes ou les poids après publication.";
    case "unauthenticated":
      return "Session expirée. Reconnectez-vous.";
    // M040 (B019/B020, D179).
    case "phase_invalid_dates":
      return "La date de fin prévue doit suivre la date de début prévue.";
    case "phase_validated_immutable":
      return "Cette étape est validée par le propriétaire : elle ne peut plus être modifiée.";
    case "invalid_transition":
      return "Cette action n'est pas possible dans l'état actuel de l'étape.";
    case "progression_incomplete":
      return "Pour déclarer cette étape terminée, sa progression déclarée doit d'abord être de 100 %. Mettez la progression à jour, puis recommencez.";
    case "decision_invalid":
      return "Décision invalide.";
    case "no_change":
      return "Aucune modification à enregistrer.";
    default:
      return "Une erreur est survenue. Réessayez.";
  }
}

const isUuid = (v: FormDataEntryValue | null): v is string =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
function readRevision(formData: FormData): number | null {
  const raw = formData.get("expected_revision");
  if (typeof raw !== "string" || !/^\d{1,9}$/.test(raw)) return null;
  return Number(raw);
}
function readPhases(formData: FormData): unknown {
  const raw = formData.get("phases");
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
const done = (projectId: string): PhaseActionState => {
  revalidatePath(`/chantiers/${projectId}/avancement`);
  return { ok: true };
};

export async function saveDraftAction(_prev: PhaseActionState, formData: FormData): Promise<PhaseActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const projectId = formData.get("project_id");
  const revision = readRevision(formData);
  const phases = readPhases(formData);
  if (!isUuid(projectId) || revision === null || phases === null) return { error: "Requête invalide." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("upsert_phase_plan_draft", {
    p_project_id: projectId,
    p_phases: phases,
    p_expected_revision: revision,
  });
  if (error) return { error: mapPhaseError(error.message) };
  return done(projectId);
}

export async function publishPlanAction(_prev: PhaseActionState, formData: FormData): Promise<PhaseActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const projectId = formData.get("project_id");
  const revision = readRevision(formData);
  const phases = readPhases(formData);
  if (!isUuid(projectId) || revision === null || phases === null) return { error: "Requête invalide." };

  // Publie exactement les étapes affichées : elles sont d'abord enregistrées
  // dans le brouillon (révision attendue revérifiée par le serveur), puis la
  // publication porte sur la révision ainsi obtenue — jamais sur un brouillon
  // antérieur différent de l'écran.
  const supabase = await createClient();
  const saved = await supabase.rpc("upsert_phase_plan_draft", {
    p_project_id: projectId,
    p_phases: phases,
    p_expected_revision: revision,
  });
  if (saved.error) return { error: mapPhaseError(saved.error.message) };
  const savedRow = Array.isArray(saved.data) ? saved.data[0] : saved.data;
  if (typeof savedRow?.revision !== "number") return { error: mapPhaseError(undefined) };

  const { error } = await supabase.rpc("publish_phase_plan", {
    p_project_id: projectId,
    p_expected_revision: savedRow.revision,
  });
  if (error) return { error: mapPhaseError(error.message) };
  return done(projectId);
}

export async function updateProgressAction(_prev: PhaseActionState, formData: FormData): Promise<PhaseActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const projectId = formData.get("project_id");
  const phaseId = formData.get("phase_id");
  const revision = readRevision(formData);
  const progressionRaw = formData.get("progression");
  const progression = typeof progressionRaw === "string" && progressionRaw.trim() !== "" ? Number(progressionRaw) : NaN;
  if (!isUuid(projectId) || !isUuid(phaseId) || revision === null || Number.isNaN(progression)) {
    return { error: "Requête invalide." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("update_phase_progress", {
    p_project_id: projectId,
    p_phase_id: phaseId,
    p_progression: progression,
    p_expected_revision: revision,
  });
  if (error) return { error: mapPhaseError(error.message) };
  return done(projectId);
}

// M040 — déclaration « terminée » (entreprise), décision du propriétaire
// principal (motif obligatoire pour un refus), dates prévues après
// publication (motif). Droits revérifiés en base (D179).
export async function declarePhaseAction(_prev: PhaseActionState, formData: FormData): Promise<PhaseActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const projectId = formData.get("project_id");
  const phaseId = formData.get("phase_id");
  const revision = readRevision(formData);
  if (!isUuid(projectId) || !isUuid(phaseId) || revision === null) return { error: "Requête invalide." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("declare_phase_complete", { p_project_id: projectId, p_phase_id: phaseId, p_expected_revision: revision });
  if (error) return { error: mapPhaseError(error.message) };
  return done(projectId);
}

export async function decidePhaseAction(_prev: PhaseActionState, formData: FormData): Promise<PhaseActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const projectId = formData.get("project_id");
  const phaseId = formData.get("phase_id");
  const revision = readRevision(formData);
  const decision = formData.get("decision");
  const reason = formData.get("reason");
  if (!isUuid(projectId) || !isUuid(phaseId) || revision === null || (decision !== "VALIDEE" && decision !== "REFUSEE")) {
    return { error: "Requête invalide." };
  }
  if (decision === "REFUSEE" && (typeof reason !== "string" || reason.trim().length < 3)) {
    return { error: "Indiquez le motif du refus (3 caractères au moins)." };
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("decide_phase", {
    p_project_id: projectId,
    p_phase_id: phaseId,
    p_decision: decision,
    p_reason: typeof reason === "string" ? reason.trim() : null,
    p_expected_revision: revision,
  });
  if (error) return { error: error.message === "reason_required" ? "Indiquez le motif du refus (3 caractères au moins)." : mapPhaseError(error.message) };
  return done(projectId);
}

export async function updateScheduleAction(_prev: PhaseActionState, formData: FormData): Promise<PhaseActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const projectId = formData.get("project_id");
  const phaseId = formData.get("phase_id");
  const revision = readRevision(formData);
  const reason = formData.get("reason");
  const date = (name: string) => {
    const v = formData.get(name);
    return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  };
  if (!isUuid(projectId) || !isUuid(phaseId) || revision === null) return { error: "Requête invalide." };
  if (typeof reason !== "string" || reason.trim().length < 1) return { error: "Un motif est obligatoire pour modifier les dates prévues après publication." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("update_phase_schedule", {
    p_project_id: projectId,
    p_phase_id: phaseId,
    p_planned_start: date("planned_start"),
    p_planned_end: date("planned_end"),
    p_reason: reason.trim(),
    p_expected_revision: revision,
  });
  if (error) return { error: mapPhaseError(error.message) };
  return done(projectId);
}

export async function restructurePlanAction(_prev: PhaseActionState, formData: FormData): Promise<PhaseActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const projectId = formData.get("project_id");
  const revision = readRevision(formData);
  const phases = readPhases(formData);
  const reason = formData.get("reason");
  if (!isUuid(projectId) || revision === null || phases === null || typeof reason !== "string" || reason.trim().length < 1) {
    return { error: "Requête invalide." };
  }

  const supabase = await createClient();
  const current = await supabase.rpc("list_project_phases", { p_project_id: projectId });
  if (current.error) return { error: mapPhaseError(current.error.message) };
  if (isSameStructure(phases, (current.data ?? []) as CurrentPhase[])) {
    return { error: "Aucune modification : les étapes et les poids sont identiques à ceux en vigueur." };
  }
  const { error } = await supabase.rpc("restructure_phase_plan", {
    p_project_id: projectId,
    p_phases: phases,
    p_reason: reason.trim(),
    p_expected_revision: revision,
  });
  if (error) return { error: mapPhaseError(error.message) };
  return done(projectId);
}
