"use server";

import { revalidatePath } from "next/cache";
import { createClient, requireVerifiedAccount } from "@/lib/supabase/server";

// B031 (M045 ; D183, D184, D187) — dépenses internes. Chaque fonction en
// base revérifie le rôle (entreprise ou chef de chantier actif), l'auteur
// du brouillon et la machine d'états ; tout autre rôle reçoit
// « not_authorized », sans aucune donnée.

export type ExpenseActionState = { error: string } | { ok: true } | null;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function mapExpenseError(code: string | undefined): string {
  switch (code) {
    case "not_authorized":
      return "Action réservée : vérifiez votre rôle sur ce chantier.";
    case "account_provisional":
      return "Vérifiez votre identifiant (e-mail ou téléphone) avant de continuer.";
    case "invalid_amount":
    case "amount_out_of_bounds":
      return "Montant invalide : un nombre entier de FCFA, supérieur à zéro.";
    case "expense_date_required":
      return "Indiquez la date de la dépense.";
    case "category_invalid":
      return "Choisissez une catégorie.";
    case "phase_link_invalid":
      return "Cette étape n'est plus proposée. Choisissez une étape active du plan publié, ou aucune.";
    case "reason_required":
      return "Indiquez le motif (3 caractères au moins).";
    case "revision_conflict":
      return "La dépense a été modifiée entre-temps. Rechargez la page puis recommencez.";
    case "invalid_transition":
      return "Cette action n'est plus possible dans l'état actuel de la dépense.";
    case "no_change":
      return "Aucun changement par rapport à la version en vigueur.";
    case "expense_invalid":
      return "Fournisseur (200 caractères) ou note (1 000 caractères) trop longs.";
    default:
      return "Une erreur est survenue. Réessayez.";
  }
}

function common(formData: FormData) {
  const projectId = formData.get("project_id");
  const expenseId = formData.get("expense_id");
  const revisionRaw = formData.get("expected_revision");
  if (typeof projectId !== "string" || !UUID_RE.test(projectId)) return null;
  const id = typeof expenseId === "string" && expenseId !== "" ? expenseId : null;
  if (id !== null && !UUID_RE.test(id)) return null;
  const revision = typeof revisionRaw === "string" && /^\d{1,9}$/.test(revisionRaw) ? Number(revisionRaw) : null;
  return { projectId, id, revision };
}

function fields(formData: FormData) {
  const date = String(formData.get("expense_date") ?? "");
  const phase = String(formData.get("phase_id") ?? "");
  return {
    amount: String(formData.get("amount") ?? "").replace(/[\s  ]/g, ""),
    date: DATE_RE.test(date) ? date : null,
    category: String(formData.get("category") ?? "") || null,
    supplier: String(formData.get("supplier") ?? ""),
    note: String(formData.get("note") ?? ""),
    phase: UUID_RE.test(phase) ? phase : null,
  };
}

async function done(projectId: string, error: { message: string } | null): Promise<ExpenseActionState> {
  if (error) return { error: mapExpenseError(error.message) };
  revalidatePath(`/chantiers/${projectId}/depenses`);
  return { ok: true };
}

export async function saveExpenseDraftAction(_prev: ExpenseActionState, formData: FormData): Promise<ExpenseActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const c = common(formData);
  if (!c || (c.id !== null && c.revision === null)) return { error: "Requête invalide." };
  const f = fields(formData);
  const supabase = await createClient();
  const { error } = await supabase.rpc("save_expense_draft", {
    p_project_id: c.projectId,
    p_expense_id: c.id,
    p_expected_revision: c.revision,
    p_amount_fcfa: f.amount,
    p_expense_date: f.date,
    p_category: f.category,
    p_supplier: f.supplier,
    p_note: f.note,
    p_phase_id: f.phase,
  });
  return done(c.projectId, error);
}

export async function submitExpenseAction(_prev: ExpenseActionState, formData: FormData): Promise<ExpenseActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const c = common(formData);
  if (!c || !c.id || c.revision === null) return { error: "Requête invalide." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("submit_expense", { p_expense_id: c.id, p_expected_revision: c.revision });
  return done(c.projectId, error);
}

export async function decideExpenseAction(_prev: ExpenseActionState, formData: FormData): Promise<ExpenseActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const c = common(formData);
  const decision = formData.get("decision");
  if (!c || !c.id || c.revision === null || typeof decision !== "string" || !["APPROUVEE", "REFUSEE", "CONTESTEE"].includes(decision)) {
    return { error: "Requête invalide." };
  }
  const reason = formData.get("reason");
  const supabase = await createClient();
  const { error } = await supabase.rpc("decide_expense", {
    p_expense_id: c.id,
    p_expected_revision: c.revision,
    p_decision: decision,
    p_reason: typeof reason === "string" ? reason : null,
  });
  return done(c.projectId, error);
}

export async function correctExpenseAction(_prev: ExpenseActionState, formData: FormData): Promise<ExpenseActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const c = common(formData);
  if (!c || !c.id || c.revision === null) return { error: "Requête invalide." };
  const f = fields(formData);
  const reason = formData.get("reason");
  const supabase = await createClient();
  const { error } = await supabase.rpc("correct_expense", {
    p_expense_id: c.id,
    p_expected_revision: c.revision,
    p_reason: typeof reason === "string" ? reason : null,
    p_amount_fcfa: f.amount,
    p_expense_date: f.date,
    p_category: f.category,
    p_supplier: f.supplier,
    p_note: f.note,
    p_phase_id: f.phase,
  });
  return done(c.projectId, error);
}

export async function cancelExpenseAction(_prev: ExpenseActionState, formData: FormData): Promise<ExpenseActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const c = common(formData);
  if (!c || !c.id || c.revision === null) return { error: "Requête invalide." };
  const reason = formData.get("reason");
  const supabase = await createClient();
  const { error } = await supabase.rpc("cancel_expense", {
    p_expense_id: c.id,
    p_expected_revision: c.revision,
    p_reason: typeof reason === "string" ? reason : null,
  });
  return done(c.projectId, error);
}
