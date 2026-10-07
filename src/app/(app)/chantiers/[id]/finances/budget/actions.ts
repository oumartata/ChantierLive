"use server";

import { revalidatePath } from "next/cache";
import { createClient, requireVerifiedAccount } from "@/lib/supabase/server";

// B030 (M043, D183–D185) — budget prévisionnel interne. La fonction en base
// revérifie que l'appelant est l'entreprise active du chantier ; tout autre
// rôle reçoit « not_authorized », sans aucune donnée.

export type BudgetActionState = { error: string } | { ok: true } | null;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mapBudgetError(code: string | undefined): string {
  switch (code) {
    case "not_authorized":
      return "Le budget interne est réservé à l'entreprise du chantier.";
    case "account_provisional":
      return "Vérifiez votre identifiant (e-mail ou téléphone) avant de continuer.";
    case "invalid_amount":
    case "amount_out_of_bounds":
      return "Montant invalide : un nombre entier de FCFA, supérieur à zéro.";
    case "reason_required":
      return "Indiquez le motif de la révision (3 caractères au moins).";
    case "revision_conflict":
      return "Le budget a été modifié entre-temps. Rechargez la page puis recommencez.";
    case "no_change":
      return "Le montant est identique au budget en vigueur.";
    default:
      return "Une erreur est survenue. Réessayez.";
  }
}

export async function setInternalBudgetAction(_prev: BudgetActionState, formData: FormData): Promise<BudgetActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const projectId = formData.get("project_id");
  const revisionRaw = formData.get("expected_revision");
  const amount = String(formData.get("amount") ?? "").replace(/[\s  ]/g, "");
  const reason = formData.get("reason");
  if (typeof projectId !== "string" || !UUID_RE.test(projectId) || typeof revisionRaw !== "string" || !/^\d{1,9}$/.test(revisionRaw)) {
    return { error: "Requête invalide." };
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_internal_budget", {
    p_project_id: projectId,
    p_amount_fcfa: amount,
    p_reason: typeof reason === "string" ? reason : null,
    p_expected_revision: Number(revisionRaw),
  });
  if (error) return { error: mapBudgetError(error.message) };
  revalidatePath(`/chantiers/${projectId}/finances/budget`);
  return { ok: true };
}
