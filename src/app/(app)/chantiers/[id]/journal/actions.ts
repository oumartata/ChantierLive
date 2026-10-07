"use server";

import { revalidatePath } from "next/cache";
import { createClient, requireVerifiedAccount } from "@/lib/supabase/server";

// B021 (M036, D144–D150) — brouillon de journal quotidien. Chaque action
// passe par une fonction en base qui revérifie la session, le compte
// vérifié, l'adhésion active (entreprise ou chef de chantier) et l'auteur ;
// rien n'est déduit du navigateur.

export type JournalActionState = { error: string } | { ok: true } | null;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function mapJournalError(code: string | undefined): string {
  switch (code) {
    case "not_authorized":
      return "Action non autorisée sur ce brouillon (réservé à son auteur, entreprise ou chef de chantier actif).";
    case "account_provisional":
      return "Vérifiez votre identifiant (e-mail ou téléphone) avant de continuer.";
    case "daily_log_draft_exists":
      return "Vous avez déjà un brouillon pour cette date sur ce chantier. Modifiez-le, ou archivez-le avant d'en créer un autre.";
    case "revision_conflict":
      return "Ce brouillon a été modifié entre-temps. Rechargez la page puis recommencez.";
    case "log_date_required":
      return "Choisissez la date du journal.";
    case "daily_log_invalid":
      return "Texte trop long (4 000 caractères au plus par rubrique, 1 000 pour le motif).";
    case "daily_log_already_published":
      return "Vous avez déjà publié un journal pour cette date sur ce chantier. Corrigez le journal publié au lieu d'en créer un autre.";
    case "daily_log_empty":
      return "Remplissez au moins une rubrique avant de publier.";
    case "phase_link_invalid":
      return "Cette étape ne peut pas être choisie (étape retirée, plan non publié ou autre chantier). Choisissez une étape active ou aucune.";
    case "reason_required":
      return "Indiquez le motif de la correction (3 caractères au moins).";
    default:
      return "Une erreur est survenue. Réessayez.";
  }
}

function text(formData: FormData, name: string): string | null {
  const v = formData.get(name);
  return typeof v === "string" ? v : null;
}

function readFields(formData: FormData) {
  const logDate = text(formData, "log_date");
  return {
    logDate: logDate && DATE_RE.test(logDate) ? logDate : null,
    works: text(formData, "works_done"),
    difficulties: text(formData, "difficulties"),
    team: text(formData, "team"),
    next: text(formData, "next_actions"),
    // D182 : étape facultative ; revérifiée en base (phase_link_check).
    phase: (() => {
      const v = text(formData, "phase_id");
      return v && UUID_RE.test(v) ? v : null;
    })(),
  };
}

function readRevision(formData: FormData): number | null {
  const raw = formData.get("expected_revision");
  return typeof raw === "string" && /^\d{1,9}$/.test(raw) ? Number(raw) : null;
}

export async function createDailyLogDraftAction(_prev: JournalActionState, formData: FormData): Promise<JournalActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const projectId = text(formData, "project_id");
  const f = readFields(formData);
  if (!projectId || !UUID_RE.test(projectId)) return { error: "Requête invalide." };
  if (!f.logDate) return { error: mapJournalError("log_date_required") };
  const supabase = await createClient();
  const { error } = await supabase.rpc("create_daily_log_draft", {
    p_project_id: projectId,
    p_log_date: f.logDate,
    p_works_done: f.works,
    p_difficulties: f.difficulties,
    p_team: f.team,
    p_next_actions: f.next,
    p_phase_id: f.phase,
  });
  if (error) return { error: mapJournalError(error.message) };
  revalidatePath(`/chantiers/${projectId}/journal`);
  return { ok: true };
}

export async function updateDailyLogDraftAction(_prev: JournalActionState, formData: FormData): Promise<JournalActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const projectId = text(formData, "project_id");
  const logId = text(formData, "log_id");
  const revision = readRevision(formData);
  const f = readFields(formData);
  if (!projectId || !UUID_RE.test(projectId) || !logId || !UUID_RE.test(logId) || revision === null) return { error: "Requête invalide." };
  if (!f.logDate) return { error: mapJournalError("log_date_required") };
  const supabase = await createClient();
  const { error } = await supabase.rpc("update_daily_log_draft", {
    p_log_id: logId,
    p_expected_revision: revision,
    p_log_date: f.logDate,
    p_works_done: f.works,
    p_difficulties: f.difficulties,
    p_team: f.team,
    p_next_actions: f.next,
    p_phase_id: f.phase,
  });
  if (error) return { error: mapJournalError(error.message) };
  revalidatePath(`/chantiers/${projectId}/journal`);
  return { ok: true };
}

export async function archiveDailyLogDraftAction(projectId: string, logId: string, revision: number): Promise<JournalActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  if (!UUID_RE.test(projectId) || !UUID_RE.test(logId) || !Number.isInteger(revision) || revision < 0) return { error: "Requête invalide." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("archive_daily_log_draft", { p_log_id: logId, p_expected_revision: revision });
  if (error) return { error: mapJournalError(error.message) };
  revalidatePath(`/chantiers/${projectId}/journal`);
  return { ok: true };
}

// B022 (M037, D151–D156) — publication par l'auteur ; la version publiée
// est le contenu ENREGISTRÉ du brouillon (révision attendue).
export async function publishDailyLogDraftAction(projectId: string, logId: string, revision: number): Promise<JournalActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  if (!UUID_RE.test(projectId) || !UUID_RE.test(logId) || !Number.isInteger(revision) || revision < 0) return { error: "Requête invalide." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("publish_daily_log_draft", { p_log_id: logId, p_expected_revision: revision });
  if (error) return { error: mapJournalError(error.message) };
  revalidatePath(`/chantiers/${projectId}/journal`);
  return { ok: true };
}

// Correction : nouvelle version liée, publiée immédiatement, motif
// obligatoire (auteur, ou entreprise sur tous les journaux du chantier).
export async function correctDailyLogAction(_prev: JournalActionState, formData: FormData): Promise<JournalActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const projectId = text(formData, "project_id");
  const logId = text(formData, "log_id");
  const raw = formData.get("expected_version");
  const version = typeof raw === "string" && /^\d{1,9}$/.test(raw) ? Number(raw) : null;
  const reason = text(formData, "reason");
  const f = readFields(formData);
  if (!projectId || !UUID_RE.test(projectId) || !logId || !UUID_RE.test(logId) || version === null) return { error: "Requête invalide." };
  if (!reason || reason.trim().length < 3) return { error: mapJournalError("reason_required") };
  const supabase = await createClient();
  const { error } = await supabase.rpc("correct_daily_log", {
    p_log_id: logId,
    p_expected_version_number: version,
    p_reason: reason,
    p_works_done: f.works,
    p_difficulties: f.difficulties,
    p_team: f.team,
    p_next_actions: f.next,
    p_phase_id: f.phase,
  });
  if (error) return { error: mapJournalError(error.message) };
  revalidatePath(`/chantiers/${projectId}/journal`);
  return { ok: true };
}
