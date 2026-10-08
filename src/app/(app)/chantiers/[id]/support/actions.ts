"use server";

import { revalidatePath } from "next/cache";
import { createClient, requireVerifiedAccount } from "@/lib/supabase/server";

// B051 (M051 ; D197) — demande d'aide, accord, arrêt et clôture par une
// partie principale. Chaque fonction en base revérifie la partie (entreprise
// ou propriétaire principal) et inscrit l'action au journal d'accès.

export type SupportActionState = { error: string } | { ok: true; message: string } | null;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mapError(code: string | undefined): string {
  switch (code) {
    case "not_authorized":
      return "Réservé à l'entreprise et au propriétaire principal du chantier.";
    case "account_provisional":
      return "Vérifiez votre identifiant (e-mail ou téléphone) avant de continuer.";
    case "description_invalid":
      return "Décrivez le problème en 10 à 1000 caractères.";
    case "category_invalid":
      return "Choisissez une catégorie.";
    case "scope_invalid":
      return "Cochez au moins un module.";
    case "duration_invalid":
      return "Choisissez une durée de 15, 30 ou 60 minutes.";
    case "grant_already_active":
      return "Un accès est déjà ouvert pour cette demande.";
    case "grant_already_revoked":
      return "Cet accès est déjà arrêté.";
    case "grant_expired":
      return "Cet accès a déjà expiré.";
    case "request_closed":
      return "Cette demande est close.";
    default:
      return "Une erreur est survenue. Réessayez.";
  }
}

function readGrant(formData: FormData) {
  const consent = formData.get("consent") === "on";
  const modules = formData.getAll("modules").filter((m): m is string => typeof m === "string");
  const duration = Number(formData.get("duration"));
  return { consent, modules, duration };
}

export async function createSupportRequestAction(_prev: SupportActionState, formData: FormData): Promise<SupportActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const projectId = formData.get("project_id");
  const category = formData.get("category");
  const description = formData.get("description");
  if (typeof projectId !== "string" || !UUID_RE.test(projectId)) return { error: "Requête invalide." };
  const { consent, modules, duration } = readGrant(formData);
  if (consent && modules.length === 0) return { error: mapError("scope_invalid") };
  const supabase = await createClient();
  const { error } = await supabase.rpc("support_create_request", {
    p_project_id: projectId,
    p_category: typeof category === "string" ? category : null,
    p_description: typeof description === "string" ? description : null,
    p_grant_modules: consent ? modules : null,
    p_grant_duration_minutes: consent ? duration : null,
  });
  if (error) return { error: mapError(error.message) };
  revalidatePath(`/chantiers/${projectId}`, "layout");
  return { ok: true, message: consent ? "Demande envoyée ; l'accès en lecture seule est ouvert." : "Demande envoyée, sans accès ouvert." };
}

export async function grantSupportAccessAction(_prev: SupportActionState, formData: FormData): Promise<SupportActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const projectId = formData.get("project_id");
  const requestId = formData.get("request_id");
  if (typeof projectId !== "string" || !UUID_RE.test(projectId) || typeof requestId !== "string" || !UUID_RE.test(requestId)) return { error: "Requête invalide." };
  const { modules, duration } = readGrant(formData);
  if (modules.length === 0) return { error: mapError("scope_invalid") };
  const supabase = await createClient();
  const { error } = await supabase.rpc("support_grant_access", { p_request_id: requestId, p_modules: modules, p_duration_minutes: duration });
  if (error) return { error: mapError(error.message) };
  revalidatePath(`/chantiers/${projectId}`, "layout");
  return { ok: true, message: "Accès ouvert en lecture seule." };
}

export async function revokeSupportAccessAction(_prev: SupportActionState, formData: FormData): Promise<SupportActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const projectId = formData.get("project_id");
  const grantId = formData.get("grant_id");
  if (typeof projectId !== "string" || !UUID_RE.test(projectId) || typeof grantId !== "string" || !UUID_RE.test(grantId)) return { error: "Requête invalide." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("support_revoke_access", { p_grant_id: grantId, p_reason: null });
  if (error) return { error: mapError(error.message) };
  revalidatePath(`/chantiers/${projectId}`, "layout");
  return { ok: true, message: "Accès arrêté." };
}

export async function closeSupportRequestAction(_prev: SupportActionState, formData: FormData): Promise<SupportActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const projectId = formData.get("project_id");
  const requestId = formData.get("request_id");
  if (typeof projectId !== "string" || !UUID_RE.test(projectId) || typeof requestId !== "string" || !UUID_RE.test(requestId)) return { error: "Requête invalide." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("support_close_request", { p_request_id: requestId });
  if (error) return { error: mapError(error.message) };
  revalidatePath(`/chantiers/${projectId}`, "layout");
  return { ok: true, message: "Demande close ; tout accès en cours est arrêté." };
}
