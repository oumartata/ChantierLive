"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createClient, requireVerifiedAccount } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { validateProjectFile } from "@/app/prototype-plans/projectFile";

const BUCKET = "organization-catalog";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Détection du format RÉEL par signature (magic bytes), jamais le type MIME
// déclaré par le client — même discipline que sniffMimeType (B026/B027),
// périmètre propre au bucket organization-catalog (PDF/JPEG/PNG). LIMITE
// EXPLICITE (revue ciblée, point 2) : une signature reconnue prouve le
// CONTENEUR, jamais un décodage complet — un PDF tronqué juste après son
// en-tête passe ce contrôle, comme le sniff mp4/webp existant pour les médias.
function sniffCatalogMimeType(bytes: Uint8Array): string | null {
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

// B061. Traduit les codes d'erreur bruts des RPC
// M019 en texte destiné à l'utilisateur, même principe que
// organisations/[id]/ingenieurs/actions.ts et chantiers/[id]/photos/actions.ts.
function mapCatalogError(message: string | undefined): string {
  switch (message) {
    case "account_provisional":
      return "Vérifiez votre identifiant (e-mail ou téléphone) avant de continuer.";
    case "not_authorized":
      return "Vous n'êtes pas autorisé à effectuer cette action.";
    case "label_required":
      return "Indiquez un nom pour ce modèle.";
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
    case "storage_not_verified":
      return "Le fichier n'a pas pu être vérifié. Réessayez.";
    case "checksum_mismatch":
      return "Le fichier reçu ne correspond pas à un format reconnu ou a été altéré. Réessayez avec un fichier valide.";
    case "already_pending":
      return "Une demande de validation est déjà en cours pour cette version, auprès d'un ingénieur toujours habilité.";
    case "already_decided":
      return "Cette demande a déjà reçu une décision.";
    case "invalid_decision":
      return "Décision invalide.";
    case "version_not_validated":
      return "Cette version doit d'abord être validée techniquement.";
    case "file_not_finalized":
      return "Le fichier de cette version n'est pas encore disponible.";
    case "layout_invalid_format":
    case "layout_invalid_structure":
      return "Fichier de projet invalide. Réessayez avec un fichier exporté depuis le générateur 2D.";
    case "layout_unknown_version":
      return "Version du fichier de projet non reconnue.";
    case "layout_too_large":
      return "Fichier de projet trop volumineux.";
    default:
      return "Une erreur est survenue. Réessayez.";
  }
}

type ActionResult<T> = { ok: true; value: T } | { ok: false; message: string };
export type CatalogueActionState = { error: string } | null;

function requireUuid(value: FormDataEntryValue | null): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export async function createCatalogItemAction(
  _prevState: CatalogueActionState,
  formData: FormData
): Promise<CatalogueActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };

  const organizationId = formData.get("organization_id");
  const label = formData.get("label");
  if (!requireUuid(organizationId) || typeof label !== "string" || label.trim() === "") {
    return { error: "Indiquez un nom pour ce modèle." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("create_catalog_item", {
    p_organization_id: organizationId,
    p_label: label.trim(),
  });
  if (error) return { error: mapCatalogError(error.message) };

  revalidatePath(`/organisations/${organizationId}/catalogue`);
  return null;
}

// Étapes partagées prepare/claim/écriture-Storage/attest, EXTRAITES de
// l'ancienne depositCatalogItemVersionAction (comportement inchangé) pour
// être réutilisées par depositModifiableCatalogItemVersionAction (Lot A,
// PREPARATION_CATALOGUE_MODIFIABLE.md) SANS dupliquer cette logique : seul
// le paramètre p_layout passé au finalize appelé ENSUITE diffère. Ne décide
// PAS quelle variante de finalize appeler ; renvoie `operationUuid` tel
// quel pour que l'appelant l'utilise.
async function ensureReadyToFinalizeCatalog(
  supabase: Awaited<ReturnType<typeof createClient>>,
  service: ReturnType<typeof createServiceClient>,
  organizationId: string,
  catalogItemId: string,
  operationUuid: string,
  bytes: Uint8Array,
  declaredMimeType: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  const checksum = createHash("sha256").update(bytes).digest("hex");

  // Point 1 : reprend l'état serveur AVANT toute nouvelle écriture.
  const { data: status, error: statusErr } = await supabase.rpc("get_upload_status", {
    p_operation_uuid: operationUuid,
  });

  let claim: { won: boolean; candidate_key: string; attempt_id: string } | null = null;
  let candidateBytes: Uint8Array | null = null;

  if (!statusErr && status) {
    if (status.entity_type !== "plan_catalog_item_version" || status.organization_id !== organizationId) {
      return { ok: false, message: "Requête invalide." };
    }

    const { data: target, error: targetErr } = await service
      .from("plan_catalog_item_upload_targets")
      .select("catalog_item_id")
      .eq("private_object_upload_id", status.id)
      .maybeSingle();
    if (targetErr) return { ok: false, message: "Erreur de lecture côté serveur. Réessayez." };
    const paramsMatch =
      target?.catalog_item_id === catalogItemId &&
      status.expected_checksum === checksum &&
      status.expected_size_bytes === bytes.length &&
      status.expected_mime_type === declaredMimeType;
    if (!paramsMatch) {
      return { ok: false, message: mapCatalogError("operation_uuid_conflict") };
    }

    if (status.status === "ABANDONED") {
      return { ok: false, message: mapCatalogError("operation_abandoned") };
    }

    if (status.status === "FINALIZED") {
      // Réponse perdue après une finalisation déjà réussie : le RPC de
      // finalisation de l'appelant (idempotent) revalide tout avant de
      // renvoyer l'état existant.
      return { ok: true };
    }

    let effectiveRow = status;
    const isExpired = !!status.attempt_expires_at && new Date(status.attempt_expires_at).getTime() <= Date.now();
    if ((status.status === "PENDING" || status.status === "FINALIZING") && isExpired) {
      const { data: recovered, error: recoverErr } = await supabase.rpc("recover_media_upload_attempt", {
        p_operation_uuid: operationUuid,
      });
      if (recoverErr) return { ok: false, message: mapCatalogError(recoverErr.message) };
      effectiveRow = recovered;
    }

    if (effectiveRow.status === "FINALIZING") {
      return { ok: true };
    }
    if (effectiveRow.status === "PENDING" && effectiveRow.write_claimed_at) {
      const { data: existingCandidate } = await service.storage.from(BUCKET).download(effectiveRow.candidate_key);
      if (existingCandidate) {
        candidateBytes = new Uint8Array(await existingCandidate.arrayBuffer());
      }
    }
  } else if (statusErr && statusErr.message !== "not_authorized") {
    return { ok: false, message: "Erreur de lecture côté serveur. Réessayez." };
  }

  const { data: prepared, error: prepErr } = await supabase.rpc("prepare_catalog_item_upload", {
    p_operation_uuid: operationUuid,
    p_organization_id: organizationId,
    p_catalog_item_id: catalogItemId,
    p_expected_checksum: checksum,
    p_expected_size_bytes: bytes.length,
    p_expected_mime_type: declaredMimeType,
  });
  if (prepErr || !prepared) return { ok: false, message: mapCatalogError(prepErr?.message) };

  const { data: claimResult, error: claimErr } = await supabase.rpc("claim_upload_attempt", {
    p_operation_uuid: operationUuid,
    p_expected_attempt_id: prepared.attempt_id,
  });
  if (claimErr) return { ok: false, message: "Impossible de démarrer l'envoi. Réessayez." };
  claim = claimResult;
  if (!claim) return { ok: false, message: "Impossible de démarrer l'envoi. Réessayez." };
  const wonClaim = claim;

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
  const actualMimeType = sniffCatalogMimeType(candidateBytes) ?? "application/octet-stream";

  const { error: attestErr } = await service.rpc("attest_storage_verified", {
    p_operation_uuid: operationUuid,
    p_attempt_id: wonClaim.attempt_id,
    p_actual_checksum: actualChecksum,
    p_actual_size_bytes: candidateBytes.length,
    p_actual_mime_type: actualMimeType,
  });
  if (attestErr) return { ok: false, message: mapCatalogError(attestErr.message) };

  return { ok: true };
}

function readCatalogDepositFormData(
  formData: FormData
): { organizationId: string; catalogItemId: string; operationUuid: string; file: File } | { error: string } {
  const organizationId = formData.get("organization_id");
  const catalogItemId = formData.get("catalog_item_id");
  const file = formData.get("file");
  const operationUuidRaw = formData.get("operation_uuid");

  if (!requireUuid(organizationId) || !requireUuid(catalogItemId) || !requireUuid(operationUuidRaw)) {
    return { error: "Requête invalide." };
  }
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Choisissez un fichier à déposer." };
  }
  return { organizationId, catalogItemId, operationUuid: operationUuidRaw, file };
}

// Dépôt d'une version plate (PDF/JPEG/PNG, sans fichier de projet modifiable)
// — comportement INCHANGÉ depuis la revue ciblée B061 (identité d'opération
// fournie par le client, état serveur relu avant toute écriture, format
// attesté sur les octets réellement relus dans Storage).
export async function depositCatalogItemVersionAction(formData: FormData): Promise<ActionResult<{ versionId: string }>> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { ok: false, message: guard.message };

  const parsed = readCatalogDepositFormData(formData);
  if ("error" in parsed) return { ok: false, message: parsed.error };
  const { organizationId, catalogItemId, operationUuid, file } = parsed;

  const bytes = new Uint8Array(await file.arrayBuffer());
  const declaredMimeType = file.type || "application/octet-stream";

  const supabase = await createClient();
  const service = createServiceClient();

  const prep = await ensureReadyToFinalizeCatalog(supabase, service, organizationId, catalogItemId, operationUuid, bytes, declaredMimeType);
  if (!prep.ok) return { ok: false, message: prep.message };

  const { data: version, error: finErr } = await supabase.rpc("finalize_catalog_item_upload", {
    p_operation_uuid: operationUuid,
  });
  if (finErr) return { ok: false, message: mapCatalogError(finErr.message) };

  revalidatePath(`/organisations/${organizationId}/catalogue`);
  return { ok: true, value: { versionId: version.id } };
}

// Dépôt d'un modèle MODIFIABLE (Lot A, PREPARATION_CATALOGUE_MODIFIABLE.md) —
// RÉUTILISE les mêmes étapes prepare/claim/écriture/attest que le dépôt
// plat ci-dessus (ensureReadyToFinalizeCatalog, jamais dupliqué). Le PNG
// (aperçu) et le fichier de projet (layout) proviennent du MÊME fichier
// choisi par l'utilisateur : le PNG est rendu côté client depuis ce layout
// (PlanEditor/render.ts), jamais reconstruit ici ni choisi séparément.
// Validation AUTORITAIRE du layout via validateProjectFile (projectFile.ts,
// réutilisé tel quel) AVANT tout appel RPC. Frontière de confiance (M032b,
// corrige un contournement RPC direct confirmé sur M032) : le layout validé
// n'est JAMAIS passé en argument à finalize_catalog_item_upload (appelable
// par tout utilisateur authentifié autorisé) — il transite par
// attest_catalog_item_layout, exécutable UNIQUEMENT par service_role
// (aucun grant à authenticated, même principe que attest_storage_verified),
// que seule cette action serveur peut invoquer.
export async function depositModifiableCatalogItemVersionAction(
  formData: FormData
): Promise<ActionResult<{ versionId: string }>> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { ok: false, message: guard.message };

  const parsed = readCatalogDepositFormData(formData);
  if ("error" in parsed) return { ok: false, message: parsed.error };
  const { organizationId, catalogItemId, operationUuid, file } = parsed;

  const layoutRaw = formData.get("layout");
  if (typeof layoutRaw !== "string") return { ok: false, message: "Fichier de projet manquant." };
  let layout: unknown;
  try {
    layout = JSON.parse(layoutRaw);
  } catch {
    return { ok: false, message: "Fichier de projet illisible (JSON invalide)." };
  }
  const validated = validateProjectFile(layout);
  if (!validated.ok) return { ok: false, message: `Fichier de projet invalide : ${validated.error}` };

  const bytes = new Uint8Array(await file.arrayBuffer());
  const declaredMimeType = file.type || "application/octet-stream";

  const supabase = await createClient();
  const service = createServiceClient();

  const prep = await ensureReadyToFinalizeCatalog(supabase, service, organizationId, catalogItemId, operationUuid, bytes, declaredMimeType);
  if (!prep.ok) return { ok: false, message: prep.message };

  // Frontière de confiance (M032b) : attest_catalog_item_layout n'est
  // exécutable QUE par service_role (aucun grant à authenticated) — un
  // appelant RPC direct, même authentifié avec les bons droits métier, ne
  // peut jamais faire parvenir de layout jusqu'à la version créée. Seule
  // cette action serveur (qui vient de valider le fichier ci-dessus,
  // validateProjectFile autoritaire) détient la clé service_role.
  const { error: attestLayoutErr } = await service.rpc("attest_catalog_item_layout", {
    p_operation_uuid: operationUuid,
    p_layout: validated.value,
  });
  if (attestLayoutErr) return { ok: false, message: mapCatalogError(attestLayoutErr.message) };

  const { data: version, error: finErr } = await supabase.rpc("finalize_catalog_item_upload", {
    p_operation_uuid: operationUuid,
  });
  if (finErr) return { ok: false, message: mapCatalogError(finErr.message) };

  revalidatePath(`/organisations/${organizationId}/catalogue`);
  return { ok: true, value: { versionId: version.id } };
}

// Aperçu (URL signée, jamais la clé Storage brute exposée au client) ET
// fichier modifiable (layout, null pour un ancien modèle) — mêmes droits
// que get_catalog_item_version_file (M032) : propriétaire de l'organisation
// uniquement, aucune permission de lecture nouvelle.
export async function getCatalogItemVersionFileAction(
  versionId: string
): Promise<ActionResult<{ previewUrl: string | null; layout: unknown }>> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { ok: false, message: guard.message };
  if (!UUID_RE.test(versionId)) return { ok: false, message: "Requête invalide." };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_catalog_item_version_file", { p_version_id: versionId });
  if (error) return { ok: false, message: mapCatalogError(error.message) };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { ok: false, message: mapCatalogError("file_not_finalized") };

  const service = createServiceClient();
  const { data: signed } = await service.storage.from(row.bucket).createSignedUrl(row.storage_key, 300);
  return { ok: true, value: { previewUrl: signed?.signedUrl ?? null, layout: row.layout } };
}

export async function submitForValidationAction(
  _prevState: CatalogueActionState,
  formData: FormData
): Promise<CatalogueActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };

  const organizationId = formData.get("organization_id");
  const versionId = formData.get("version_id");
  const designationId = formData.get("designation_id");
  if (!requireUuid(organizationId) || !requireUuid(versionId) || !requireUuid(designationId)) {
    return { error: "Requête invalide." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("submit_catalog_item_version_for_validation", {
    p_version_id: versionId,
    p_designation_id: designationId,
  });
  if (error) return { error: mapCatalogError(error.message) };

  revalidatePath(`/organisations/${organizationId}/catalogue`);
  return null;
}

export async function publishCatalogItemVersionAction(
  _prevState: CatalogueActionState,
  formData: FormData
): Promise<CatalogueActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };

  const organizationId = formData.get("organization_id");
  const versionId = formData.get("version_id");
  if (!requireUuid(organizationId) || !requireUuid(versionId)) {
    return { error: "Requête invalide." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("publish_catalog_item_version", { p_version_id: versionId });
  if (error) return { error: mapCatalogError(error.message) };

  revalidatePath(`/organisations/${organizationId}/catalogue`);
  return null;
}
