"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createClient, requireVerifiedAccount } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

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

// Dépôt d'une version — flux SIMPLIFIÉ À DESSEIN pour ce lot (un
// seul appel serveur, fichier reçu entièrement en FormData, jamais via URL
// signée côté client), mais CORRIGÉ (revue ciblée, points 1/2) : l'identité
// de l'opération (operation_uuid) est désormais fournie par le CLIENT et
// PERSISTÉE à travers les tentatives pour un même dépôt (voir
// UploadVersionForm) — jamais régénérée à chaque appel. L'état serveur est
// relu AVANT toute nouvelle écriture : une réponse perdue après une
// finalisation déjà réussie restitue la version EXISTANTE, jamais une
// seconde. Le format attesté est désormais celui détecté sur les octets
// RÉELLEMENT relus dans Storage, jamais le type MIME déclaré par le client.
export async function depositCatalogItemVersionAction(formData: FormData): Promise<ActionResult<{ versionId: string }>> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { ok: false, message: guard.message };

  const organizationId = formData.get("organization_id");
  const catalogItemId = formData.get("catalog_item_id");
  const file = formData.get("file");
  const operationUuidRaw = formData.get("operation_uuid");

  if (!requireUuid(organizationId) || !requireUuid(catalogItemId) || !requireUuid(operationUuidRaw)) {
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

  // Point 1 : reprend l'état serveur AVANT toute nouvelle écriture.
  const { data: status, error: statusErr } = await supabase.rpc("get_upload_status", {
    p_operation_uuid: operationUuid,
  });

  let claim: { won: boolean; candidate_key: string; attempt_id: string } | null = null;
  let candidateBytes: Uint8Array | null = null;

  if (!statusErr && status) {
    if (status.entity_type !== "plan_catalog_item_version" || status.organization_id !== organizationId) {
      // Même operation_uuid réutilisé pour un rattachement différent :
      // jamais réinterprété comme la même opération (même principe que
      // prepare_catalog_item_upload).
      return { ok: false, message: "Requête invalide." };
    }

    // CORRIGÉ (revue ciblée) : les court-circuits FINALIZED/FINALIZING
    // ci-dessous contournaient jusqu'ici prepare_catalog_item_upload et sa
    // réconciliation (item cible + paramètres immuables du fichier) — un
    // même operation_uuid réutilisé pour un item ou un contenu DIFFÉRENT
    // aurait pu renvoyer avec succès la version de l'ANCIEN dépôt. Vérifié
    // ICI, avant tout court-circuit, exactement comme prepare_catalog_item_upload
    // le fait pour son propre chemin de réconciliation.
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
      // CORRIGÉ (revue ciblée) : ABANDONED reste un état TERMINAL, jamais
      // implicitement contourné par cette reprise applicative.
      return { ok: false, message: mapCatalogError("operation_abandoned") };
    }

    if (status.status === "FINALIZED") {
      // Réponse perdue après une finalisation déjà réussie : item/paramètres
      // déjà revérifiés ci-dessus. Appelle finalize_catalog_item_upload avec
      // la session UTILISATEUR (jamais une lecture directe service_role, qui
      // contournerait l'autorisation) — la fonction est elle-même idempotente
      // et revalide l'organisation/l'item/le compte AVANT tout retour, y
      // compris ce cas (revue ciblée) ; aucune revérification dupliquée ici.
      const { data: version, error: finErr } = await supabase.rpc("finalize_catalog_item_upload", {
        p_operation_uuid: operationUuid,
      });
      if (finErr) return { ok: false, message: mapCatalogError(finErr.message) };
      return { ok: true, value: { versionId: version.id } };
    }

    // CORRIGÉ (revue ciblée, point 3) : reprise RÉELLE d'une tentative
    // expirée, branchée sur l'action applicative — jamais seulement testée
    // au niveau RPC. Même opération (operation_uuid inchangé), nouvel
    // attempt_id/candidate_key ouverts par recover_media_upload_attempt
    // (générique, entity_type='plan_catalog_item_version'), jamais une
    // réécriture de l'ancienne candidate.
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
      const { data: version, error: finErr } = await supabase.rpc("finalize_catalog_item_upload", {
        p_operation_uuid: operationUuid,
      });
      if (finErr) return { ok: false, message: mapCatalogError(finErr.message) };
      revalidatePath(`/organisations/${organizationId}/catalogue`);
      return { ok: true, value: { versionId: version.id } };
    }
    if (effectiveRow.status === "PENDING" && effectiveRow.write_claimed_at) {
      // Candidate déjà revendiquée par une tentative antérieure (panne après
      // écriture, avant attestation) : jamais réécrite, relue telle quelle.
      // Après une reprise ci-dessus, write_claimed_at est toujours null (la
      // nouvelle candidate n'a encore reçu aucune écriture) : cette branche
      // ne s'applique alors jamais par construction.
      const { data: existingCandidate } = await service.storage.from(BUCKET).download(effectiveRow.candidate_key);
      if (existingCandidate) {
        candidateBytes = new Uint8Array(await existingCandidate.arrayBuffer());
      }
    }
  } else if (statusErr && statusErr.message !== "not_authorized") {
    // "not_authorized" ici couvre le premier dépôt (opération pas encore
    // créée) — toute AUTRE erreur reste incertaine, jamais traitée comme un
    // premier dépôt légitime.
    return { ok: false, message: "Erreur de lecture côté serveur. Réessayez." };
  }

  // PREPARE — idempotent par construction : un rejeu avec les mêmes
  // paramètres (même operation_uuid, même item cible) renvoie la même ligne.
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
  // Capturé dans une const (jamais réassignée) : TypeScript ne propage pas le
  // rétrécissement de `claim` (déclaré `let`) dans le reste de la fonction —
  // même limitation que `wonClaim` dans commitMediaUpload (chantiers/[id]/photos/actions.ts).
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
    // Non gagné et aucune candidate déjà en main (ci-dessus) : relue sans
    // jamais réécrire (même principe que commitMediaUpload).
    const { data: existing, error: dlErr } = await service.storage.from(BUCKET).download(wonClaim.candidate_key);
    if (dlErr || !existing) return { ok: false, message: "Traitement en cours. Réessayez dans un instant." };
    candidateBytes = new Uint8Array(await existing.arrayBuffer());
  }

  // Point 2 : format RÉEL détecté sur les octets RÉELLEMENT relus dans
  // Storage — jamais le type MIME déclaré par le client. Une signature non
  // reconnue retombe sur un type générique : attest_storage_verified refuse
  // alors le fichier (expected vs actual, checksum_mismatch) sans dupliquer
  // la logique de refus — même discipline que commitMediaUpload.
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

  const { data: version, error: finErr } = await supabase.rpc("finalize_catalog_item_upload", {
    p_operation_uuid: operationUuid,
  });
  if (finErr) return { ok: false, message: mapCatalogError(finErr.message) };

  revalidatePath(`/organisations/${organizationId}/catalogue`);
  return { ok: true, value: { versionId: version.id } };
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
