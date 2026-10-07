"use server";

import { createHash, randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createClient, requireVerifiedAccount } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

// B028 (M039, D169–D176) — documents et versions. Chaque étape passe par une
// fonction en base qui revérifie session, compte vérifié, adhésion active et
// partie de dépôt ; le chemin de stockage est construit par le serveur ; le
// type réel est détecté sur les octets RELUS dans le stockage, jamais sur le
// type déclaré par le navigateur (D176). Aucun antivirus.

const BUCKET = "project-documents";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

export type DocumentActionState = { error: string } | { ok: true } | null;

function sniffDocumentMimeType(b: Uint8Array): string | null {
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return "application/pdf";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

function mapDocumentError(code: string | undefined): string {
  switch (code) {
    case "not_authorized":
      return "Action non autorisée sur ce document pour votre rôle.";
    case "account_provisional":
      return "Vérifiez votre identifiant (e-mail ou téléphone) avant de continuer.";
    case "visibility_not_allowed":
      return "Cette visibilité n'est pas permise pour votre rôle.";
    case "document_type_invalid":
      return "Choisissez le type du document.";
    case "document_invalid":
      return "Le titre doit compter 3 à 120 caractères, la description 500 au plus.";
    case "size_required":
      return "Le fichier doit peser 20 Mo au plus.";
    case "mime_type_required":
      return "Formats admis : PDF, JPEG, PNG ou WebP.";
    case "checksum_mismatch":
      return "Le contenu du fichier ne correspond pas à son format déclaré : il a été refusé.";
    case "revision_conflict":
      return "Ce document a été modifié entre-temps. Rechargez la page puis recommencez.";
    case "reason_required":
      return "Indiquez le motif (3 caractères au moins).";
    case "document_archived":
      return "Ce document est déjà archivé.";
    case "attempt_expired":
    case "storage_not_verified":
    case "operation_uuid_conflict":
    case "operation_abandoned":
      return "L'envoi n'a pas pu être vérifié. Réessayez.";
    default:
      return "Une erreur est survenue. Réessayez.";
  }
}

const text = (fd: FormData, name: string) => {
  const v = fd.get(name);
  return typeof v === "string" ? v : null;
};

// Dépôt d'un document (document_id absent) ou d'une nouvelle version.
export async function depositDocumentAction(_prev: DocumentActionState, formData: FormData): Promise<DocumentActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const projectId = text(formData, "project_id");
  const documentIdRaw = text(formData, "document_id");
  const documentId = documentIdRaw && UUID_RE.test(documentIdRaw) ? documentIdRaw : null;
  const file = formData.get("file");
  if (!projectId || !UUID_RE.test(projectId)) return { error: "Requête invalide." };
  if (!(file instanceof File) || file.size === 0) return { error: "Choisissez un fichier." };
  if (file.size > 20971520) return { error: mapDocumentError("size_required") };
  const declared = file.type || "application/octet-stream";
  if (!ALLOWED.has(declared)) return { error: mapDocumentError("mime_type_required") };

  const bytes = new Uint8Array(await file.arrayBuffer());
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const operationUuid = randomUUID();
  const supabase = await createClient();
  const service = createServiceClient();

  const { data: prepared, error: prepErr } = await supabase.rpc("prepare_document_upload", {
    p_operation_uuid: operationUuid,
    p_project_id: projectId,
    p_document_id: documentId,
    p_document_type: documentId ? null : text(formData, "document_type"),
    p_title: documentId ? null : text(formData, "title"),
    p_description: documentId ? null : text(formData, "description"),
    p_visibility: documentId ? null : text(formData, "visibility"),
    p_expected_checksum: checksum,
    p_expected_size_bytes: bytes.length,
    p_expected_mime_type: declared,
  });
  if (prepErr || !prepared) return { error: mapDocumentError(prepErr?.message) };

  const { data: claim, error: claimErr } = await supabase.rpc("claim_upload_attempt", {
    p_operation_uuid: operationUuid,
    p_expected_attempt_id: prepared.attempt_id,
  });
  if (claimErr || !claim?.won) return { error: mapDocumentError(claimErr?.message) };

  const { error: writeErr } = await service.storage.from(BUCKET).upload(claim.candidate_key, bytes, { contentType: declared, upsert: false });
  if (writeErr) return { error: "Échec de l'écriture du fichier. Réessayez." };
  const { data: written, error: rereadErr } = await service.storage.from(BUCKET).download(claim.candidate_key);
  if (rereadErr || !written) return { error: "Impossible de relire le fichier écrit. Réessayez." };
  const stored = new Uint8Array(await written.arrayBuffer());

  const { error: attestErr } = await service.rpc("attest_storage_verified", {
    p_operation_uuid: operationUuid,
    p_attempt_id: claim.attempt_id,
    p_actual_checksum: createHash("sha256").update(stored).digest("hex"),
    p_actual_size_bytes: stored.length,
    p_actual_mime_type: sniffDocumentMimeType(stored) ?? "application/octet-stream",
  });
  if (attestErr) return { error: mapDocumentError(attestErr.message) };

  const { error: finErr } = await supabase.rpc("finalize_document_upload", { p_operation_uuid: operationUuid });
  if (finErr) return { error: mapDocumentError(finErr.message) };
  revalidatePath(`/chantiers/${projectId}/documents`);
  return { ok: true };
}

export async function publishDocumentAction(projectId: string, documentId: string, revision: number): Promise<DocumentActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  if (!UUID_RE.test(projectId) || !UUID_RE.test(documentId) || !Number.isInteger(revision) || revision < 0) return { error: "Requête invalide." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("publish_document", { p_document_id: documentId, p_expected_revision: revision });
  if (error) return { error: mapDocumentError(error.message) };
  revalidatePath(`/chantiers/${projectId}/documents`);
  return { ok: true };
}

export async function archiveDocumentAction(_prev: DocumentActionState, formData: FormData): Promise<DocumentActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const projectId = text(formData, "project_id");
  const documentId = text(formData, "document_id");
  const revisionRaw = text(formData, "expected_revision");
  const reason = text(formData, "reason");
  if (!projectId || !UUID_RE.test(projectId) || !documentId || !UUID_RE.test(documentId) || !revisionRaw || !/^\d{1,9}$/.test(revisionRaw)) {
    return { error: "Requête invalide." };
  }
  if (!reason || reason.trim().length < 3) return { error: mapDocumentError("reason_required") };
  const supabase = await createClient();
  const { error } = await supabase.rpc("archive_document", { p_document_id: documentId, p_expected_revision: Number(revisionRaw), p_reason: reason });
  if (error) return { error: mapDocumentError(error.message) };
  revalidatePath(`/chantiers/${projectId}/documents`);
  return { ok: true };
}
