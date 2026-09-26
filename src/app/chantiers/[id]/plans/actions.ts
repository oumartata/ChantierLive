"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createClient, requireVerifiedAccount } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

const BUCKET = "project-plans";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Même détection par signature que sniffCatalogMimeType (B061) : périmètre
// PDF/JPEG/PNG du bucket project-plans, jamais le type MIME déclaré par le
// client. Même limite : une signature reconnue prouve le conteneur, jamais
// un décodage complet.
function sniffPlanMimeType(bytes: Uint8Array): string | null {
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) {
    return "application/pdf"; // "%PDF-"
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  return null;
}

// B063. Traduit les codes d'erreur bruts des RPC M020 en texte destiné à
// l'utilisateur, même principe que organisations/[id]/catalogue/actions.ts.
function mapPlanError(message: string | undefined): string {
  switch (message) {
    case "account_provisional":
      return "Vérifiez votre identifiant (e-mail ou téléphone) avant de continuer.";
    case "not_authorized":
      return "Vous n'êtes pas autorisé à effectuer cette action.";
    case "not_readable":
      return "Ce plan ne vous a pas encore été partagé.";
    case "no_organization":
      return "Ce chantier n'est rattaché à aucune organisation : aucun catalogue disponible.";
    case "retained_plan_conflict":
      return "Le chantier a été modifié entre-temps. Rechargez la page puis réessayez.";
    case "checksum_required":
    case "size_required":
    case "mime_type_required":
      return "Fichier invalide. Réessayez.";
    case "operation_uuid_conflict":
      return "Un envoi différent est déjà en cours. Réessayez.";
    case "operation_already_finalized":
      return "Cet envoi est déjà terminé.";
    case "operation_abandoned":
      return "Cet envoi a expiré. Recommencez.";
    case "attempt_expired":
      return "L'envoi a pris trop de temps. Réessayez.";
    case "storage_not_verified":
      return "Le fichier n'a pas pu être vérifié. Réessayez.";
    case "checksum_mismatch":
      return "Le fichier reçu ne correspond pas à un format reconnu ou a été altéré. Réessayez avec un fichier valide.";
    case "file_not_finalized":
      return "Le fichier de ce plan n'est pas encore disponible.";
    default:
      return "Une erreur est survenue. Réessayez.";
  }
}

type ActionResult<T> = { ok: true; value: T } | { ok: false; message: string };
export type PlanActionState = { error: string } | null;

function requireUuid(value: FormDataEntryValue | null): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

// Dépôt direct d'un plan candidat (OWNER/PRIMARY ou CONTRACTOR, D101) — même
// flux que depositCatalogItemVersionAction (B061) : operation_uuid fourni par
// le client et persisté entre tentatives, état serveur relu AVANT toute
// écriture, format attesté sur les octets réellement relus dans Storage.
export async function depositProjectPlanAction(formData: FormData): Promise<ActionResult<{ versionId: string }>> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { ok: false, message: guard.message };

  const projectId = formData.get("project_id");
  const file = formData.get("file");
  const operationUuidRaw = formData.get("operation_uuid");

  if (!requireUuid(projectId) || !requireUuid(operationUuidRaw)) {
    return { ok: false, message: "Requête invalide." };
  }
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: "Choisissez un fichier à déposer." };
  }
  const operationUuid = operationUuidRaw;

  const bytes = new Uint8Array(await file.arrayBuffer());
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const declaredMimeType = file.type || "application/octet-stream";

  const supabase = await createClient();
  const service = createServiceClient();

  const { data: status, error: statusErr } = await supabase.rpc("get_upload_status", {
    p_operation_uuid: operationUuid,
  });

  let candidateBytes: Uint8Array | null = null;

  if (!statusErr && status) {
    // Réconciliation AVANT tout court-circuit (même principe que B061) : un
    // operation_uuid réutilisé pour un autre chantier ou un autre contenu
    // n'est jamais réinterprété comme la même opération.
    const paramsMatch =
      status.entity_type === "project_plan_version" &&
      status.project_id === projectId &&
      status.expected_checksum === checksum &&
      status.expected_size_bytes === bytes.length &&
      status.expected_mime_type === declaredMimeType;
    if (!paramsMatch) {
      return { ok: false, message: mapPlanError("operation_uuid_conflict") };
    }

    if (status.status === "ABANDONED") {
      return { ok: false, message: mapPlanError("operation_abandoned") };
    }

    if (status.status === "FINALIZED") {
      // Réponse perdue après une finalisation réussie : finalize_project_plan_upload
      // est idempotente et revalide les droits avant de renvoyer la version existante.
      const { data: version, error: finErr } = await supabase.rpc("finalize_project_plan_upload", {
        p_operation_uuid: operationUuid,
      });
      if (finErr) return { ok: false, message: mapPlanError(finErr.message) };
      return { ok: true, value: { versionId: version.id } };
    }

    let effectiveRow = status;
    const isExpired = !!status.attempt_expires_at && new Date(status.attempt_expires_at).getTime() <= Date.now();
    if ((status.status === "PENDING" || status.status === "FINALIZING") && isExpired) {
      const { data: recovered, error: recoverErr } = await supabase.rpc("recover_media_upload_attempt", {
        p_operation_uuid: operationUuid,
      });
      if (recoverErr) return { ok: false, message: mapPlanError(recoverErr.message) };
      effectiveRow = recovered;
    }

    if (effectiveRow.status === "FINALIZING") {
      const { data: version, error: finErr } = await supabase.rpc("finalize_project_plan_upload", {
        p_operation_uuid: operationUuid,
      });
      if (finErr) return { ok: false, message: mapPlanError(finErr.message) };
      revalidatePath(`/chantiers/${projectId}/plans`);
      return { ok: true, value: { versionId: version.id } };
    }
    if (effectiveRow.status === "PENDING" && effectiveRow.write_claimed_at) {
      const { data: existingCandidate } = await service.storage.from(BUCKET).download(effectiveRow.candidate_key);
      if (existingCandidate) {
        candidateBytes = new Uint8Array(await existingCandidate.arrayBuffer());
      }
    }
  } else if (statusErr && statusErr.message !== "not_authorized") {
    // "not_authorized" couvre le premier dépôt (opération pas encore créée).
    return { ok: false, message: "Erreur de lecture côté serveur. Réessayez." };
  }

  const { data: prepared, error: prepErr } = await supabase.rpc("prepare_project_plan_upload", {
    p_operation_uuid: operationUuid,
    p_project_id: projectId,
    p_expected_checksum: checksum,
    p_expected_size_bytes: bytes.length,
    p_expected_mime_type: declaredMimeType,
  });
  if (prepErr || !prepared) return { ok: false, message: mapPlanError(prepErr?.message) };

  const { data: claim, error: claimErr } = await supabase.rpc("claim_upload_attempt", {
    p_operation_uuid: operationUuid,
    p_expected_attempt_id: prepared.attempt_id,
  });
  if (claimErr || !claim) return { ok: false, message: "Impossible de démarrer l'envoi. Réessayez." };
  const wonClaim: { won: boolean; candidate_key: string; attempt_id: string } = claim;

  if (wonClaim.won) {
    const { error: writeError } = await service.storage
      .from(BUCKET)
      .upload(wonClaim.candidate_key, bytes, { contentType: declaredMimeType, upsert: false });
    if (writeError) return { ok: false, message: "Échec de l'écriture serveur. Réessayez." };

    const { data: writtenFile, error: rereadError } = await service.storage.from(BUCKET).download(wonClaim.candidate_key);
    if (rereadError || !writtenFile) return { ok: false, message: "Impossible de relire le fichier écrit. Réessayez." };
    candidateBytes = new Uint8Array(await writtenFile.arrayBuffer());
  } else if (!candidateBytes) {
    const { data: existing, error: dlErr } = await service.storage.from(BUCKET).download(wonClaim.candidate_key);
    if (dlErr || !existing) return { ok: false, message: "Traitement en cours. Réessayez dans un instant." };
    candidateBytes = new Uint8Array(await existing.arrayBuffer());
  }

  const actualChecksum = createHash("sha256").update(candidateBytes).digest("hex");
  const actualMimeType = sniffPlanMimeType(candidateBytes) ?? "application/octet-stream";

  const { error: attestErr } = await service.rpc("attest_storage_verified", {
    p_operation_uuid: operationUuid,
    p_attempt_id: wonClaim.attempt_id,
    p_actual_checksum: actualChecksum,
    p_actual_size_bytes: candidateBytes.length,
    p_actual_mime_type: actualMimeType,
  });
  if (attestErr) return { ok: false, message: mapPlanError(attestErr.message) };

  const { data: version, error: finErr } = await supabase.rpc("finalize_project_plan_upload", {
    p_operation_uuid: operationUuid,
  });
  if (finErr) return { ok: false, message: mapPlanError(finErr.message) };

  revalidatePath(`/chantiers/${projectId}/plans`);
  return { ok: true, value: { versionId: version.id } };
}

// Rattachement depuis le catalogue (D107) : attach_catalog_plan_to_project
// vérifie séparément l'habilitation chantier ET l'accès catalogue, et fige la
// version publiée au moment de l'appel.
export async function attachCatalogPlanAction(
  _prevState: PlanActionState,
  formData: FormData
): Promise<PlanActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };

  const projectId = formData.get("project_id");
  const catalogItemId = formData.get("catalog_item_id");
  if (!requireUuid(projectId) || !requireUuid(catalogItemId)) {
    return { error: "Choisissez un modèle du catalogue." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("attach_catalog_plan_to_project", {
    p_project_id: projectId,
    p_catalog_item_id: catalogItemId,
  });
  if (error) return { error: mapPlanError(error.message) };

  revalidatePath(`/chantiers/${projectId}/plans`);
  return null;
}

// Partage explicite CONTRACTOR -> OWNER/PRIMARY (D104), réservé au déposant.
export async function shareProjectPlanAction(
  _prevState: PlanActionState,
  formData: FormData
): Promise<PlanActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };

  const projectId = formData.get("project_id");
  const versionId = formData.get("version_id");
  if (!requireUuid(projectId) || !requireUuid(versionId)) {
    return { error: "Requête invalide." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("share_project_plan_version_with_owner", { p_version_id: versionId });
  if (error) return { error: mapPlanError(error.message) };

  revalidatePath(`/chantiers/${projectId}/plans`);
  return null;
}

// Désignation du retenu (D103), réservée à OWNER/PRIMARY, avec la révision
// lue à l'affichage : un changement intermédiaire est refusé sans écriture.
export async function setRetainedPlanAction(
  _prevState: PlanActionState,
  formData: FormData
): Promise<PlanActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };

  const projectId = formData.get("project_id");
  const versionId = formData.get("version_id");
  const expectedRevisionRaw = formData.get("expected_revision");
  const expectedRevision = typeof expectedRevisionRaw === "string" ? Number(expectedRevisionRaw) : NaN;
  if (!requireUuid(projectId) || !requireUuid(versionId) || !Number.isInteger(expectedRevision)) {
    return { error: "Requête invalide." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("set_retained_project_plan_version", {
    p_project_id: projectId,
    p_version_id: versionId,
    p_expected_revision: expectedRevision,
  });
  if (error) return { error: mapPlanError(error.message) };

  revalidatePath(`/chantiers/${projectId}/plans`);
  return null;
}
