"use server";

import { revalidatePath } from "next/cache";
import { createClient, requireVerifiedAccount } from "@/lib/supabase/server";

// B049 (M049, M049b ; D194) — activation et rejet par l'administrateur de
// plateforme. Chaque fonction en base revérifie que l'appelant est
// administrateur (jamais déduit du navigateur) et trace l'action dans le
// journal de plateforme.

export type AdminLicenseActionState = { error: string } | { ok: true } | null;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mapError(code: string | undefined): string {
  switch (code) {
    case "not_authorized":
      return "Action réservée à l'administration de la plateforme.";
    case "account_provisional":
      return "Vérifiez votre identifiant (e-mail ou téléphone) avant de continuer.";
    case "license_already_active":
      return "La licence de ce chantier est déjà active : rejetez cette déclaration comme doublon.";
    case "renewal_not_supported":
      return "Le renouvellement n'est pas encore pris en charge.";
    case "invalid_transition":
      return "Cette déclaration a déjà été décidée ou annulée.";
    case "reason_required":
      return "Indiquez le motif du rejet (3 caractères au moins).";
    case "note_invalid":
      return "La note de vérification doit compter 3 caractères au moins, ou rester vide.";
    default:
      return "Une erreur est survenue. Réessayez.";
  }
}

export async function activateLicensePaymentAction(_prev: AdminLicenseActionState, formData: FormData): Promise<AdminLicenseActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const paymentId = formData.get("payment_id");
  const note = formData.get("note");
  if (typeof paymentId !== "string" || !UUID_RE.test(paymentId)) return { error: "Requête invalide." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("activate_license_payment", { p_payment_id: paymentId, p_verification_note: typeof note === "string" ? note : null });
  if (error) return { error: mapError(error.message) };
  revalidatePath("/admin/licences");
  return { ok: true };
}

export async function rejectLicensePaymentAction(_prev: AdminLicenseActionState, formData: FormData): Promise<AdminLicenseActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const paymentId = formData.get("payment_id");
  const reason = formData.get("reason");
  if (typeof paymentId !== "string" || !UUID_RE.test(paymentId)) return { error: "Requête invalide." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("reject_license_payment", { p_payment_id: paymentId, p_reason: typeof reason === "string" ? reason : null });
  if (error) return { error: mapError(error.message) };
  revalidatePath("/admin/licences");
  return { ok: true };
}
