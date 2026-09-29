"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createClient, requireVerifiedAccount } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

// B033 (M014) — acomptes déclaratifs. Les RPC restent l'autorité : droits
// courants, séquence, idempotence (operation_uuid) et audit côté serveur.
const BUCKET = "advance-receipts";
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODES = ["ORANGE_MONEY", "MOOV_MONEY", "CASH", "BANK", "OTHER"];

function mapAdvanceError(message: string | undefined): string {
  switch (message) {
    case "account_provisional":
      return "Vérifiez votre identifiant (e-mail ou téléphone) avant de continuer.";
    case "not_authorized":
      return "Vous n'êtes pas autorisé à effectuer cette action.";
    case "expected_revision_required":
    case "advance_conflict":
      return "Les acomptes ont été modifiés entre-temps. Rechargez la page puis réessayez.";
    case "operation_conflict":
    case "operation_uuid_conflict":
      return "Cette opération a déjà été utilisée pour une autre demande. Rechargez la page puis réessayez.";
    case "quote_not_accepted":
      return "L'avance ne peut être fixée qu'après acceptation du devis.";
    case "amount_above_contract":
      return "L'avance exigée ne peut pas dépasser le montant contractuel actuel.";
    case "requirement_frozen":
      return "Le démarrage est autorisé : l'avance exigée ne peut plus être modifiée.";
    case "advance_requirement_missing":
      return "L'entreprise doit d'abord fixer le montant de l'avance exigée.";
    case "invalid_amount":
    case "amount_out_of_bounds":
      return "Montant invalide : un nombre entier de FCFA, d'au moins 1 FCFA.";
    case "invalid_payment_date":
      return "Date du versement invalide (pas de date future).";
    case "invalid_mode":
      return "Choisissez un mode de versement.";
    case "invalid_reference":
      return "La référence ne doit pas dépasser 120 caractères.";
    case "disclaimer_required":
      return "Confirmez avoir lu que ChantierLive ne détient ni ne transfère aucun argent.";
    case "self_confirmation_refused":
      return "L'auteur d'une déclaration ne peut pas la confirmer lui-même.";
    case "not_confirming_role":
      return "Seule la partie opposée peut confirmer ce versement.";
    case "not_declarant":
      return "Seul l'auteur de la déclaration peut l'annuler.";
    case "reason_required":
      return "Indiquez un motif (1 à 1 000 caractères).";
    case "invalid_transition":
      return "Cette action n'est plus possible pour ce versement.";
    case "advance_cancelled":
      return "Ce versement est annulé : aucun justificatif ne peut y être joint.";
    case "receipt_already_attached":
      return "Un justificatif est déjà joint à ce versement.";
    case "checksum_mismatch":
    case "storage_not_verified":
      return "Le fichier n'a pas pu être vérifié. Réessayez avec un PDF, JPEG ou PNG valide.";
    case "attempt_expired":
    case "operation_abandoned":
      return "L'envoi a expiré. Recommencez.";
    case "work_start_already_authorized":
      return "Le démarrage des travaux est déjà autorisé pour ce chantier.";
    case "project_status_incompatible":
      return "Le statut actuel du chantier ne permet pas d'autoriser le démarrage.";
    case "plan_divergence":
      return "Le plan retenu ou publié ne correspond plus au plan du devis accepté : démarrage refusé.";
    case "plan_not_validated":
      return "Le plan du devis accepté n'a pas de validation technique.";
    case "advance_not_fully_recognized":
      return "L'avance exigée n'est pas intégralement reconnue.";
    default:
      return "Une erreur est survenue. Réessayez.";
  }
}

export type AdvanceActionState = { error: string } | { ok: true } | null;

const isUuid = (v: FormDataEntryValue | null): v is string => typeof v === "string" && UUID_RE.test(v);
const text = (v: FormDataEntryValue | null) => (typeof v === "string" ? v.trim() : "");
// Montant en TEXTE : espaces (y compris insécables) retirés, jamais converti en nombre.
const amountText = (v: FormDataEntryValue | null) => text(v).replace(/[\s  ]/g, "");
function readRevision(formData: FormData): number | null {
  const raw = formData.get("expected_revision");
  if (typeof raw !== "string" || !/^\d{1,9}$/.test(raw)) return null;
  return Number(raw);
}
const done = (projectId: string): AdvanceActionState => {
  revalidatePath(`/chantiers/${projectId}/acomptes`);
  return { ok: true };
};

export async function setAdvanceRequirementAction(_prev: AdvanceActionState, formData: FormData): Promise<AdvanceActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const projectId = formData.get("project_id");
  const operationUuid = formData.get("operation_uuid");
  const revision = readRevision(formData);
  if (!isUuid(projectId) || !isUuid(operationUuid) || revision === null) return { error: "Requête invalide." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("set_advance_requirement", {
    p_operation_uuid: operationUuid,
    p_project_id: projectId,
    p_amount_fcfa: amountText(formData.get("amount")),
    p_expected_revision: revision,
  });
  if (error) return { error: mapAdvanceError(error.message) };
  return done(projectId);
}

// B067 (M027) — autorisation de démarrage : conditions revérifiées sous
// verrou par la RPC (D094, D135-D139) ; rien n'est décidé ici.
export async function authorizeWorkStartAction(_prev: AdvanceActionState, formData: FormData): Promise<AdvanceActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const projectId = formData.get("project_id");
  const operationUuid = formData.get("operation_uuid");
  const revision = readRevision(formData);
  if (!isUuid(projectId) || !isUuid(operationUuid) || revision === null) return { error: "Requête invalide." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("authorize_work_start", {
    p_operation_uuid: operationUuid,
    p_project_id: projectId,
    p_expected_revision: revision,
  });
  if (error) return { error: mapAdvanceError(error.message) };
  revalidatePath(`/chantiers/${projectId}/photos`);
  return done(projectId);
}

export async function declareAdvanceAction(_prev: AdvanceActionState, formData: FormData): Promise<AdvanceActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const projectId = formData.get("project_id");
  const operationUuid = formData.get("operation_uuid");
  const revision = readRevision(formData);
  const date = text(formData.get("payment_date"));
  const mode = text(formData.get("mode"));
  if (!isUuid(projectId) || !isUuid(operationUuid) || revision === null) return { error: "Requête invalide." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: mapAdvanceError("invalid_payment_date") };
  if (!MODES.includes(mode)) return { error: mapAdvanceError("invalid_mode") };

  const supabase = await createClient();
  const { error } = await supabase.rpc("declare_advance_payment", {
    p_operation_uuid: operationUuid,
    p_project_id: projectId,
    p_amount_fcfa: amountText(formData.get("amount")),
    p_payment_date: date,
    p_mode: mode,
    p_reference: text(formData.get("reference")) || null,
    p_disclaimer_ack: formData.get("disclaimer_ack") === "on",
    p_expected_revision: revision,
  });
  if (error) return { error: mapAdvanceError(error.message) };
  return done(projectId);
}

export async function actOnAdvanceAction(_prev: AdvanceActionState, formData: FormData): Promise<AdvanceActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const projectId = formData.get("project_id");
  const advanceId = formData.get("advance_id");
  const operationUuid = formData.get("operation_uuid");
  const command = formData.get("command");
  const revision = readRevision(formData);
  if (!isUuid(projectId) || !isUuid(advanceId) || !isUuid(operationUuid) || revision === null) return { error: "Requête invalide." };

  const supabase = await createClient();
  const base = { p_operation_uuid: operationUuid, p_advance_id: advanceId, p_expected_revision: revision };
  const reason = text(formData.get("reason"));
  const { error } =
    command === "CONFIRM"
      ? await supabase.rpc("confirm_advance_payment", base)
      : command === "DISPUTE"
        ? await supabase.rpc("dispute_advance_payment", { ...base, p_reason: reason })
        : command === "CANCEL"
          ? await supabase.rpc("cancel_advance_payment", { ...base, p_reason: reason })
          : { error: { message: "invalid_command" } };
  if (error) return { error: mapAdvanceError(error.message) };
  return done(projectId);
}

function sniffReceiptMimeType(bytes: Uint8Array): string | null {
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) return "application/pdf";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  return null;
}

// Justificatif (D134) : même pipeline que les plans (B026/B063) — préparation
// liée au versement, revendication, écriture serveur de la candidate, relecture
// des octets RÉELLEMENT stockés, attestation (service_role), finalisation
// atomique. Toute reprise passe d'abord par la vérification de la cible et
// des paramètres liés à l'opération.
export async function attachAdvanceReceiptAction(_prev: AdvanceActionState, formData: FormData): Promise<AdvanceActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const projectId = formData.get("project_id");
  const advanceId = formData.get("advance_id");
  const operationUuid = formData.get("operation_uuid");
  const file = formData.get("file");
  if (!isUuid(projectId) || !isUuid(advanceId) || !isUuid(operationUuid)) return { error: "Requête invalide." };
  if (!(file instanceof File) || file.size === 0) return { error: "Choisissez un fichier." };
  if (file.size > MAX_RECEIPT_BYTES) return { error: "Le justificatif ne doit pas dépasser 10 Mo." };

  const bytes = new Uint8Array(await file.arrayBuffer());
  const mimeType = sniffReceiptMimeType(bytes);
  if (!mimeType) return { error: "Format non accepté : PDF, JPEG ou PNG uniquement." };
  const checksum = createHash("sha256").update(bytes).digest("hex");

  const supabase = await createClient();
  const service = createServiceClient();

  // 1. Cible et paramètres immuables vérifiés côté serveur AVANT tout retour
  // ou reprise : prepare_advance_receipt_upload refuse le même operation_uuid
  // avec un autre versement ou un autre contenu (operation_uuid_conflict),
  // sans mutation, et renvoie sinon la ligne existante, quel que soit son état.
  const { data: prepared, error: prepErr } = await supabase.rpc("prepare_advance_receipt_upload", {
    p_operation_uuid: operationUuid,
    p_advance_id: advanceId,
    p_expected_checksum: checksum,
    p_expected_size_bytes: bytes.length,
    p_expected_mime_type: mimeType,
  });
  if (prepErr || !prepared) return { error: mapAdvanceError(prepErr?.message) };

  // FINALIZED légitime : résultat existant (finalisation idempotente).
  if (prepared.status === "FINALIZED") {
    const { error } = await supabase.rpc("finalize_advance_receipt_upload", { p_operation_uuid: operationUuid });
    if (error) return { error: mapAdvanceError(error.message) };
    return done(projectId);
  }

  // 2. Tentative expirée (PENDING ou FINALIZING) : reprise prévue AVANT toute
  // finalisation — même operation_uuid, nouvelle tentative et nouvelle
  // candidate ; l'ancienne candidate n'est jamais réécrite (tracée pour nettoyage).
  let attemptId: string = prepared.attempt_id;
  if (new Date(prepared.attempt_expires_at).getTime() <= Date.now()) {
    const { data: recovered, error: recoverErr } = await supabase.rpc("recover_media_upload_attempt", { p_operation_uuid: operationUuid });
    if (recoverErr || !recovered) return { error: mapAdvanceError(recoverErr?.message) };
    if (recovered.status === "FINALIZED") {
      const { error } = await supabase.rpc("finalize_advance_receipt_upload", { p_operation_uuid: operationUuid });
      if (error) return { error: mapAdvanceError(error.message) };
      return done(projectId);
    }
    attemptId = recovered.attempt_id;
  } else if (prepared.status === "FINALIZING") {
    // Tentative encore valide déjà attestée : finalisation directe.
    const { error } = await supabase.rpc("finalize_advance_receipt_upload", { p_operation_uuid: operationUuid });
    if (error) return { error: mapAdvanceError(error.message) };
    return done(projectId);
  }

  const { data: claim, error: claimErr } = await supabase.rpc("claim_upload_attempt", {
    p_operation_uuid: operationUuid,
    p_expected_attempt_id: attemptId,
  });
  if (claimErr || !claim) return { error: mapAdvanceError(claimErr?.message) };
  if (claim.status === "FINALIZING") {
    // Attestée entre-temps par un envoi concurrent : finalisation idempotente.
    const { error } = await supabase.rpc("finalize_advance_receipt_upload", { p_operation_uuid: operationUuid });
    if (error) return { error: mapAdvanceError(error.message) };
    return done(projectId);
  }

  if (claim.won) {
    const { error: writeError } = await service.storage.from(BUCKET).upload(claim.candidate_key, bytes, { contentType: mimeType, upsert: false });
    if (writeError) return { error: "Échec de l'écriture du justificatif. Réessayez." };
  }
  const { data: stored, error: rereadError } = await service.storage.from(BUCKET).download(claim.candidate_key);
  if (rereadError || !stored) return { error: "Envoi en cours de traitement. Réessayez dans un instant." };
  const storedBytes = new Uint8Array(await stored.arrayBuffer());

  const { error: attestErr } = await service.rpc("attest_storage_verified", {
    p_operation_uuid: operationUuid,
    p_attempt_id: claim.attempt_id,
    p_actual_checksum: createHash("sha256").update(storedBytes).digest("hex"),
    p_actual_size_bytes: storedBytes.length,
    p_actual_mime_type: sniffReceiptMimeType(storedBytes) ?? "application/octet-stream",
  });
  if (attestErr) return { error: mapAdvanceError(attestErr.message) };

  const { error: finErr } = await supabase.rpc("finalize_advance_receipt_upload", { p_operation_uuid: operationUuid });
  if (finErr) return { error: mapAdvanceError(finErr.message) };
  return done(projectId);
}
