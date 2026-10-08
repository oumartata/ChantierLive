"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient, requireVerifiedAccount } from "@/lib/supabase/server";

// B051 (M051 ; D197) — prise en charge motivée, arrêt d'un accès et clôture
// par l'administrateur. La base revérifie le rôle et trace chaque action au
// journal d'accès du chantier (et la prise en charge au journal de
// plateforme).

export type AdminSupportState = { error: string } | null;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mapError(code: string | undefined): string {
  switch (code) {
    case "not_authorized":
      return "Action réservée à l'administration de la plateforme.";
    case "reason_required":
      return "Indiquez le motif de la prise en charge (10 à 1000 caractères).";
    case "request_already_taken":
      return "Cette demande est déjà prise en charge.";
    case "request_closed":
      return "Cette demande est close.";
    case "grant_already_revoked":
      return "Cet accès est déjà arrêté.";
    case "grant_expired":
      return "Cet accès a déjà expiré.";
    default:
      return "Une erreur est survenue. Réessayez.";
  }
}

export async function takeSupportRequestAction(_prev: AdminSupportState, formData: FormData): Promise<AdminSupportState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const requestId = formData.get("request_id");
  const reason = formData.get("reason");
  if (typeof requestId !== "string" || !UUID_RE.test(requestId)) return { error: "Requête invalide." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_take_support_request", { p_request_id: requestId, p_reason: typeof reason === "string" ? reason : null });
  if (error) return { error: mapError(error.message) };
  revalidatePath("/admin/support");
  redirect(`/admin/support/${requestId}`);
}

export async function adminRevokeSupportAccessAction(_prev: AdminSupportState, formData: FormData): Promise<AdminSupportState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const requestId = formData.get("request_id");
  const grantId = formData.get("grant_id");
  if (typeof requestId !== "string" || !UUID_RE.test(requestId) || typeof grantId !== "string" || !UUID_RE.test(grantId)) return { error: "Requête invalide." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("support_revoke_access", { p_grant_id: grantId, p_reason: "Arrêté par le support." });
  if (error) return { error: mapError(error.message) };
  revalidatePath(`/admin/support/${requestId}`);
  return null;
}

export async function adminCloseSupportRequestAction(_prev: AdminSupportState, formData: FormData): Promise<AdminSupportState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const requestId = formData.get("request_id");
  if (typeof requestId !== "string" || !UUID_RE.test(requestId)) return { error: "Requête invalide." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("support_close_request", { p_request_id: requestId });
  if (error) return { error: mapError(error.message) };
  revalidatePath("/admin/support");
  revalidatePath(`/admin/support/${requestId}`);
  return null;
}
