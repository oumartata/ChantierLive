"use server";

import { createHash, randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createClient, requireVerifiedAccount } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

// B048 (M048 ; D193, D004) — déclaration de paiement de licence.
// ChantierLive ne détient ni ne transfère d'argent : la déclaration enregistre
// une référence externe et une preuve, au statut PENDING_REVIEW. Chaque étape
// passe par une fonction en base qui revérifie le déclarant (propriétaire
// principal ou entreprise actif). La preuve va dans le compartiment privé
// license-proofs ; son type réel est détecté sur les octets RELUS.

export type LicenseActionState = { error: string } | { ok: true } | null;

const BUCKET = "license-proofs";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ALLOWED = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

function sniff(b: Uint8Array): string | null {
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return "application/pdf";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

function mapLicenseError(code: string | undefined): string {
  switch (code) {
    case "not_authorized":
      return "Seuls le propriétaire principal et l'entreprise du chantier déclarent un paiement de licence.";
    case "account_provisional":
      return "Vérifiez votre identifiant (e-mail ou téléphone) avant de continuer.";
    case "disclaimer_required":
      return "Cochez la case confirmant avoir lu l'avertissement.";
    case "invalid_amount":
    case "amount_out_of_bounds":
      return "Montant invalide : un nombre entier de FCFA, supérieur à zéro.";
    case "operator_invalid":
      return "Choisissez le moyen de paiement utilisé.";
    case "reference_invalid":
      return "La référence du paiement doit compter 4 à 120 caractères.";
    case "sensitive_data_refused":
      return "Ne saisissez ni numéro de téléphone, ni numéro de carte ou de compte : indiquez seulement la référence de la transaction.";
    case "paid_on_invalid":
      return "La date de paiement ne peut pas être dans le futur.";
    case "license_offer_unavailable":
      return "La formule de licence n'est pas disponible pour l'instant.";
    case "size_required":
      return "La preuve doit peser 10 Mo au plus.";
    case "mime_type_required":
      return "Formats admis pour la preuve : PDF, JPEG, PNG ou WebP.";
    case "checksum_mismatch":
      return "Le contenu du fichier ne correspond pas à son format déclaré : il a été refusé.";
    case "reason_required":
      return "Indiquez le motif de l'annulation (3 caractères au moins).";
    case "invalid_transition":
      return "Cette déclaration n'est plus en attente.";
    case "attempt_expired":
    case "storage_not_verified":
    case "operation_uuid_conflict":
    case "operation_abandoned":
      return "L'envoi n'a pas pu être vérifié. Réessayez.";
    default:
      return "Une erreur est survenue. Réessayez.";
  }
}

export async function declareLicensePaymentAction(_prev: LicenseActionState, formData: FormData): Promise<LicenseActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const projectId = formData.get("project_id");
  const file = formData.get("proof");
  const paidOn = String(formData.get("paid_on") ?? "");
  if (typeof projectId !== "string" || !UUID_RE.test(projectId)) return { error: "Requête invalide." };
  if (!DATE_RE.test(paidOn)) return { error: mapLicenseError("paid_on_invalid") };
  if (!(file instanceof File) || file.size === 0) return { error: "Joignez la preuve du paiement." };
  if (file.size > 10485760) return { error: mapLicenseError("size_required") };
  const declared = file.type || "application/octet-stream";
  if (!ALLOWED.has(declared)) return { error: mapLicenseError("mime_type_required") };

  const bytes = new Uint8Array(await file.arrayBuffer());
  const operationUuid = randomUUID();
  const supabase = await createClient();
  const service = createServiceClient();
  const { data: prepared, error: prepErr } = await supabase.rpc("prepare_license_payment_upload", {
    p_operation_uuid: operationUuid,
    p_project_id: projectId,
    p_amount_fcfa: String(formData.get("amount") ?? "").replace(/[\s  ]/g, ""),
    p_operator: String(formData.get("operator") ?? ""),
    p_payment_reference: String(formData.get("reference") ?? ""),
    p_paid_on: paidOn,
    p_payer_name: String(formData.get("payer_name") ?? ""),
    p_disclaimer_ack: formData.get("disclaimer_ack") === "on",
    p_expected_checksum: createHash("sha256").update(bytes).digest("hex"),
    p_expected_size_bytes: bytes.length,
    p_expected_mime_type: declared,
  });
  if (prepErr || !prepared) return { error: mapLicenseError(prepErr?.message) };
  const { data: claim, error: claimErr } = await supabase.rpc("claim_upload_attempt", { p_operation_uuid: operationUuid, p_expected_attempt_id: prepared.attempt_id });
  if (claimErr || !claim?.won) return { error: mapLicenseError(claimErr?.message) };
  const { error: writeErr } = await service.storage.from(BUCKET).upload(claim.candidate_key, bytes, { contentType: declared, upsert: false });
  if (writeErr) return { error: "Échec de l'écriture de la preuve. Réessayez." };
  const { data: written, error: rereadErr } = await service.storage.from(BUCKET).download(claim.candidate_key);
  if (rereadErr || !written) return { error: "Impossible de relire la preuve écrite. Réessayez." };
  const stored = new Uint8Array(await written.arrayBuffer());
  const { error: attestErr } = await service.rpc("attest_storage_verified", {
    p_operation_uuid: operationUuid,
    p_attempt_id: claim.attempt_id,
    p_actual_checksum: createHash("sha256").update(stored).digest("hex"),
    p_actual_size_bytes: stored.length,
    p_actual_mime_type: sniff(stored) ?? "application/octet-stream",
  });
  if (attestErr) return { error: mapLicenseError(attestErr.message) };
  const { error: finErr } = await supabase.rpc("finalize_license_payment_upload", { p_operation_uuid: operationUuid });
  if (finErr) return { error: mapLicenseError(finErr.message) };
  revalidatePath(`/chantiers/${projectId}/licence`);
  return { ok: true };
}

export async function cancelLicensePaymentAction(_prev: LicenseActionState, formData: FormData): Promise<LicenseActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const projectId = formData.get("project_id");
  const paymentId = formData.get("payment_id");
  const reason = formData.get("reason");
  if (typeof projectId !== "string" || !UUID_RE.test(projectId) || typeof paymentId !== "string" || !UUID_RE.test(paymentId)) return { error: "Requête invalide." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("cancel_license_payment", { p_payment_id: paymentId, p_reason: typeof reason === "string" ? reason : null });
  if (error) return { error: mapLicenseError(error.message) };
  revalidatePath(`/chantiers/${projectId}/licence`);
  return { ok: true };
}
