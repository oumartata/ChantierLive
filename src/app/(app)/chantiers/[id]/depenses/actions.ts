"use server";

import { createHash, randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createClient, requireVerifiedAccount } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

// B031 (M045 ; D183, D184, D187) — dépenses internes. Chaque fonction en
// base revérifie le rôle (entreprise ou chef de chantier actif), l'auteur
// du brouillon et la machine d'états ; tout autre rôle reçoit
// « not_authorized », sans aucune donnée.
//
// B032 (M046 ; D184 F5 C, F6 A) — reçus : compartiment privé dédié
// expense-receipts ; le chemin de stockage est construit par le serveur ;
// le type réel est détecté sur les octets RELUS dans le stockage, jamais sur
// le type déclaré par le navigateur (comme les documents, M039).

export type ExpenseActionState = { error: string } | { ok: true } | null;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function mapExpenseError(code: string | undefined): string {
  switch (code) {
    case "not_authorized":
      return "Action réservée : vérifiez votre rôle sur ce chantier.";
    case "account_provisional":
      return "Vérifiez votre identifiant (e-mail ou téléphone) avant de continuer.";
    case "invalid_amount":
    case "amount_out_of_bounds":
      return "Montant invalide : un nombre entier de FCFA, supérieur à zéro.";
    case "expense_date_required":
      return "Indiquez la date de la dépense.";
    case "category_invalid":
      return "Choisissez une catégorie.";
    case "phase_link_invalid":
      return "Cette étape n'est plus proposée. Choisissez une étape active du plan publié, ou aucune.";
    case "reason_required":
      return "Indiquez le motif (3 caractères au moins).";
    case "revision_conflict":
      return "La dépense a été modifiée entre-temps. Rechargez la page puis recommencez.";
    case "invalid_transition":
      return "Cette action n'est plus possible dans l'état actuel de la dépense.";
    case "no_change":
      return "Aucun changement par rapport à la version en vigueur.";
    case "expense_invalid":
      return "Fournisseur (200 caractères), note ou justification (1 000 caractères) trop longs.";
    case "receipt_justification_required":
      return "Ce chantier exige un reçu ou une justification écrite de son absence (3 caractères au moins).";
    case "receipt_withdrawn":
      return "Ce reçu a déjà été retiré.";
    case "size_required":
      return "Le fichier doit peser 10 Mo au plus.";
    case "mime_type_required":
      return "Formats admis : PDF, JPEG, PNG ou WebP.";
    case "checksum_mismatch":
      return "Le contenu du fichier ne correspond pas à son format déclaré : il a été refusé.";
    case "attempt_expired":
    case "storage_not_verified":
    case "operation_uuid_conflict":
    case "operation_abandoned":
      return "L'envoi n'a pas pu être vérifié. Réessayez.";
    default:
      return "Une erreur est survenue. Réessayez.";
  }
}

function common(formData: FormData) {
  const projectId = formData.get("project_id");
  const expenseId = formData.get("expense_id");
  const revisionRaw = formData.get("expected_revision");
  if (typeof projectId !== "string" || !UUID_RE.test(projectId)) return null;
  const id = typeof expenseId === "string" && expenseId !== "" ? expenseId : null;
  if (id !== null && !UUID_RE.test(id)) return null;
  const revision = typeof revisionRaw === "string" && /^\d{1,9}$/.test(revisionRaw) ? Number(revisionRaw) : null;
  return { projectId, id, revision };
}

function fields(formData: FormData) {
  const date = String(formData.get("expense_date") ?? "");
  const phase = String(formData.get("phase_id") ?? "");
  return {
    amount: String(formData.get("amount") ?? "").replace(/[\s  ]/g, ""),
    date: DATE_RE.test(date) ? date : null,
    category: String(formData.get("category") ?? "") || null,
    supplier: String(formData.get("supplier") ?? ""),
    note: String(formData.get("note") ?? ""),
    phase: UUID_RE.test(phase) ? phase : null,
    justification: String(formData.get("no_receipt_reason") ?? ""),
  };
}

async function done(projectId: string, error: { message: string } | null): Promise<ExpenseActionState> {
  if (error) return { error: mapExpenseError(error.message) };
  revalidatePath(`/chantiers/${projectId}/depenses`);
  return { ok: true };
}

export async function saveExpenseDraftAction(_prev: ExpenseActionState, formData: FormData): Promise<ExpenseActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const c = common(formData);
  if (!c || (c.id !== null && c.revision === null)) return { error: "Requête invalide." };
  const f = fields(formData);
  const supabase = await createClient();
  const { error } = await supabase.rpc("save_expense_draft", {
    p_project_id: c.projectId,
    p_expense_id: c.id,
    p_expected_revision: c.revision,
    p_amount_fcfa: f.amount,
    p_expense_date: f.date,
    p_category: f.category,
    p_supplier: f.supplier,
    p_note: f.note,
    p_phase_id: f.phase,
    p_no_receipt_reason: f.justification,
  });
  return done(c.projectId, error);
}

export async function submitExpenseAction(_prev: ExpenseActionState, formData: FormData): Promise<ExpenseActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const c = common(formData);
  if (!c || !c.id || c.revision === null) return { error: "Requête invalide." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("submit_expense", { p_expense_id: c.id, p_expected_revision: c.revision });
  return done(c.projectId, error);
}

export async function decideExpenseAction(_prev: ExpenseActionState, formData: FormData): Promise<ExpenseActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const c = common(formData);
  const decision = formData.get("decision");
  if (!c || !c.id || c.revision === null || typeof decision !== "string" || !["APPROUVEE", "REFUSEE", "CONTESTEE"].includes(decision)) {
    return { error: "Requête invalide." };
  }
  const reason = formData.get("reason");
  const supabase = await createClient();
  const { error } = await supabase.rpc("decide_expense", {
    p_expense_id: c.id,
    p_expected_revision: c.revision,
    p_decision: decision,
    p_reason: typeof reason === "string" ? reason : null,
  });
  return done(c.projectId, error);
}

export async function correctExpenseAction(_prev: ExpenseActionState, formData: FormData): Promise<ExpenseActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const c = common(formData);
  if (!c || !c.id || c.revision === null) return { error: "Requête invalide." };
  const f = fields(formData);
  const reason = formData.get("reason");
  const supabase = await createClient();
  const { error } = await supabase.rpc("correct_expense", {
    p_expense_id: c.id,
    p_expected_revision: c.revision,
    p_reason: typeof reason === "string" ? reason : null,
    p_amount_fcfa: f.amount,
    p_expense_date: f.date,
    p_category: f.category,
    p_supplier: f.supplier,
    p_note: f.note,
    p_phase_id: f.phase,
    p_no_receipt_reason: f.justification,
  });
  return done(c.projectId, error);
}

export async function cancelExpenseAction(_prev: ExpenseActionState, formData: FormData): Promise<ExpenseActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const c = common(formData);
  if (!c || !c.id || c.revision === null) return { error: "Requête invalide." };
  const reason = formData.get("reason");
  const supabase = await createClient();
  const { error } = await supabase.rpc("cancel_expense", {
    p_expense_id: c.id,
    p_expected_revision: c.revision,
    p_reason: typeof reason === "string" ? reason : null,
  });
  return done(c.projectId, error);
}

const RECEIPT_BUCKET = "expense-receipts";
const RECEIPT_ALLOWED = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

function sniffReceiptMimeType(b: Uint8Array): string | null {
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return "application/pdf";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

export async function attachExpenseReceiptAction(_prev: ExpenseActionState, formData: FormData): Promise<ExpenseActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const c = common(formData);
  const file = formData.get("file");
  if (!c || !c.id) return { error: "Requête invalide." };
  if (!(file instanceof File) || file.size === 0) return { error: "Choisissez un fichier." };
  if (file.size > 10485760) return { error: mapExpenseError("size_required") };
  const declared = file.type || "application/octet-stream";
  if (!RECEIPT_ALLOWED.has(declared)) return { error: mapExpenseError("mime_type_required") };

  const bytes = new Uint8Array(await file.arrayBuffer());
  const operationUuid = randomUUID();
  const supabase = await createClient();
  const service = createServiceClient();
  const { data: prepared, error: prepErr } = await supabase.rpc("prepare_expense_receipt_upload", {
    p_operation_uuid: operationUuid,
    p_expense_id: c.id,
    p_expected_checksum: createHash("sha256").update(bytes).digest("hex"),
    p_expected_size_bytes: bytes.length,
    p_expected_mime_type: declared,
  });
  if (prepErr || !prepared) return { error: mapExpenseError(prepErr?.message) };
  const { data: claim, error: claimErr } = await supabase.rpc("claim_upload_attempt", { p_operation_uuid: operationUuid, p_expected_attempt_id: prepared.attempt_id });
  if (claimErr || !claim?.won) return { error: mapExpenseError(claimErr?.message) };
  const { error: writeErr } = await service.storage.from(RECEIPT_BUCKET).upload(claim.candidate_key, bytes, { contentType: declared, upsert: false });
  if (writeErr) return { error: "Échec de l'écriture du fichier. Réessayez." };
  const { data: written, error: rereadErr } = await service.storage.from(RECEIPT_BUCKET).download(claim.candidate_key);
  if (rereadErr || !written) return { error: "Impossible de relire le fichier écrit. Réessayez." };
  const stored = new Uint8Array(await written.arrayBuffer());
  const { error: attestErr } = await service.rpc("attest_storage_verified", {
    p_operation_uuid: operationUuid,
    p_attempt_id: claim.attempt_id,
    p_actual_checksum: createHash("sha256").update(stored).digest("hex"),
    p_actual_size_bytes: stored.length,
    p_actual_mime_type: sniffReceiptMimeType(stored) ?? "application/octet-stream",
  });
  if (attestErr) return { error: mapExpenseError(attestErr.message) };
  const { error: finErr } = await supabase.rpc("finalize_expense_receipt_upload", { p_operation_uuid: operationUuid });
  return done(c.projectId, finErr);
}

export async function withdrawExpenseReceiptAction(_prev: ExpenseActionState, formData: FormData): Promise<ExpenseActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const projectId = formData.get("project_id");
  const receiptId = formData.get("receipt_id");
  const reason = formData.get("reason");
  if (typeof projectId !== "string" || !UUID_RE.test(projectId) || typeof receiptId !== "string" || !UUID_RE.test(receiptId)) return { error: "Requête invalide." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("withdraw_expense_receipt", { p_receipt_id: receiptId, p_reason: typeof reason === "string" ? reason : null });
  return done(projectId, error);
}

// F5 C : réglage du chantier, entreprise seule (revérifié en base).
export async function setReceiptPolicyAction(_prev: ExpenseActionState, formData: FormData): Promise<ExpenseActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const projectId = formData.get("project_id");
  const revisionRaw = formData.get("expected_revision");
  const required = formData.get("required");
  if (typeof projectId !== "string" || !UUID_RE.test(projectId) || typeof revisionRaw !== "string" || !/^\d{1,9}$/.test(revisionRaw) || (required !== "1" && required !== "0")) {
    return { error: "Requête invalide." };
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_expense_receipt_policy", { p_project_id: projectId, p_required: required === "1", p_expected_revision: Number(revisionRaw) });
  return done(projectId, error);
}
