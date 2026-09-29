"use server";

import { revalidatePath } from "next/cache";
import { createClient, requireVerifiedAccount } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

const BUCKET = "organization-catalog";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mapDecisionError(message: string | undefined): string {
  switch (message) {
    case "account_provisional":
      return "Vérifiez votre identifiant (e-mail ou téléphone) avant de continuer.";
    case "not_authorized":
      return "Vous n'êtes pas autorisé à décider de cette demande.";
    case "already_decided":
      return "Cette demande a déjà reçu une décision.";
    case "invalid_decision":
      return "Décision invalide.";
    case "file_not_finalized":
      return "Le fichier n'est pas encore disponible.";
    case "already_pending":
      return "Une demande est déjà en attente pour ce plan.";
    default:
      return "Une erreur est survenue. Réessayez.";
  }
}

export type ValidationsActionState = { error: string } | null;

function requireUuid(value: FormDataEntryValue | null): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

// Décision de l'ingénieur — habilitation active revérifiée côté serveur par
// decide_catalog_item_validation (M019), jamais déduite de la seule
// apparition de la demande dans cette liste.
export async function decideValidationAction(
  _prevState: ValidationsActionState,
  formData: FormData
): Promise<ValidationsActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };

  const validationId = formData.get("validation_id");
  const decision = formData.get("decision");
  const note = formData.get("note");
  if (!requireUuid(validationId) || (decision !== "VALIDATED" && decision !== "REJECTED")) {
    return { error: "Requête invalide." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("decide_catalog_item_validation", {
    p_validation_id: validationId,
    p_decision: decision,
    p_note: typeof note === "string" && note.trim() !== "" ? note.trim() : null,
  });
  if (error) return { error: mapDecisionError(error.message) };

  revalidatePath("/validations-plans");
  return null;
}

// Accès RÉEL au fichier exact soumis — get_catalog_item_validation_file_key
// (M019) revérifie désignation active + soumission PENDING + fichier
// FINALIZED avant de renvoyer la clé exacte ; l'URL signée elle-même reste
// scopée à cette seule clé, courte expiration. Limite connue conservée
// (voir M019) : une URL déjà signée reste utilisable jusqu'à son expiration
// même si la désignation est révoquée immédiatement après.
export async function getValidationFileUrlAction(
  validationId: string
): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { ok: false, message: guard.message };
  if (!UUID_RE.test(validationId)) return { ok: false, message: "Requête invalide." };

  const supabase = await createClient();
  const { data: storageKey, error } = await supabase.rpc("get_catalog_item_validation_file_key", {
    p_validation_id: validationId,
  });
  if (error || !storageKey) return { ok: false, message: mapDecisionError(error?.message) };

  const service = createServiceClient();
  const { data: signed, error: signError } = await service.storage.from(BUCKET).createSignedUrl(storageKey, 300);
  if (signError || !signed) return { ok: false, message: "Impossible de générer le lien. Réessayez." };

  return { ok: true, url: signed.signedUrl };
}

// B064 — plans de CHANTIER : decide_plan_validation revérifie la désignation
// active, l'organisation actuelle du chantier et le compte vérifié sous
// verrou ; aucune équivalence avec les validations catalogue ci-dessus.
export async function decideProjectValidationAction(
  _prevState: ValidationsActionState,
  formData: FormData
): Promise<ValidationsActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };

  const validationId = formData.get("validation_id");
  const decision = formData.get("decision");
  const note = formData.get("note");
  if (!requireUuid(validationId) || (decision !== "VALIDATED" && decision !== "REJECTED")) {
    return { error: "Requête invalide." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("decide_plan_validation", {
    p_validation_id: validationId,
    p_decision: decision,
    p_note: typeof note === "string" && note.trim() !== "" ? note.trim() : null,
  });
  if (error) return { error: mapDecisionError(error.message) };

  revalidatePath("/validations-plans");
  return null;
}

// Fichier exact soumis (D097) : get_plan_validation_file choisit la clé ET le
// bucket côté serveur selon l'origine de la version (dépôt direct ou catalogue).
export async function getProjectValidationFileUrlAction(
  validationId: string
): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { ok: false, message: guard.message };
  if (!UUID_RE.test(validationId)) return { ok: false, message: "Requête invalide." };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_plan_validation_file", { p_validation_id: validationId });
  const row = Array.isArray(data) ? data[0] : data;
  if (error || !row?.storage_key) return { ok: false, message: mapDecisionError(error?.message) };

  const service = createServiceClient();
  const { data: signed, error: signError } = await service.storage.from(row.bucket).createSignedUrl(row.storage_key, 300);
  if (signError || !signed) return { ok: false, message: "Impossible de générer le lien. Réessayez." };

  return { ok: true, url: signed.signedUrl };
}
