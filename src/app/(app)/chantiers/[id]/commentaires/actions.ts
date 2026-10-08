"use server";

import { revalidatePath } from "next/cache";
import { createClient, requireVerifiedAccount } from "@/lib/supabase/server";

// B023 (M047, D191) — commentaires attribués. Chaque fonction en base
// revérifie que l'appelant voit l'élément commenté (journal publié ou
// incident), qu'il en a le droit (auteur pour corriger et retirer ;
// entreprise et propriétaire principal pour modérer) et que rien n'est
// supprimé.

export type CommentActionState = { error: string } | { ok: true } | null;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECTIONS = new Set(["journal", "incidents"]);

function mapCommentError(code: string | undefined): string {
  switch (code) {
    case "not_authorized":
      return "Action non autorisée sur ce commentaire pour votre rôle.";
    case "account_provisional":
      return "Vérifiez votre identifiant (e-mail ou téléphone) avant de continuer.";
    case "comment_invalid":
      return "Le commentaire doit compter de 1 à 2 000 caractères.";
    case "comment_closed":
      return "Cet élément n'accepte plus de commentaire.";
    case "comment_frozen":
      return "Ce commentaire a déjà été retiré ou modéré.";
    case "reason_required":
      return "Indiquez le motif de la modération (3 caractères au moins).";
    case "revision_conflict":
      return "Le commentaire a changé entre-temps. Rechargez la page puis recommencez.";
    case "no_change":
      return "Le texte est identique au commentaire actuel.";
    default:
      return "Une erreur est survenue. Réessayez.";
  }
}

function context(formData: FormData) {
  const projectId = formData.get("project_id");
  const section = formData.get("section");
  if (typeof projectId !== "string" || !UUID_RE.test(projectId) || typeof section !== "string" || !SECTIONS.has(section)) return null;
  return { projectId, path: `/chantiers/${projectId}/${section}` };
}

function commentRef(formData: FormData) {
  const id = formData.get("comment_id");
  const rev = formData.get("expected_revision");
  if (typeof id !== "string" || !UUID_RE.test(id) || typeof rev !== "string" || !/^\d{1,9}$/.test(rev)) return null;
  return { id, revision: Number(rev) };
}

async function done(path: string, error: { message: string } | null): Promise<CommentActionState> {
  if (error) return { error: mapCommentError(error.message) };
  revalidatePath(path);
  return { ok: true };
}

export async function addCommentAction(_prev: CommentActionState, formData: FormData): Promise<CommentActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const ctx = context(formData);
  const type = formData.get("target_type");
  const targetId = formData.get("target_id");
  if (!ctx || (type !== "DAILY_LOG" && type !== "INCIDENT") || typeof targetId !== "string" || !UUID_RE.test(targetId)) return { error: "Requête invalide." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("add_comment", { p_target_type: type, p_target_id: targetId, p_body: String(formData.get("body") ?? "") });
  return done(ctx.path, error);
}

export async function correctCommentAction(_prev: CommentActionState, formData: FormData): Promise<CommentActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const ctx = context(formData);
  const ref = commentRef(formData);
  if (!ctx || !ref) return { error: "Requête invalide." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("correct_comment", { p_comment_id: ref.id, p_expected_revision: ref.revision, p_body: String(formData.get("body") ?? "") });
  return done(ctx.path, error);
}

export async function retractCommentAction(_prev: CommentActionState, formData: FormData): Promise<CommentActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const ctx = context(formData);
  const ref = commentRef(formData);
  if (!ctx || !ref) return { error: "Requête invalide." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("retract_comment", { p_comment_id: ref.id, p_expected_revision: ref.revision });
  return done(ctx.path, error);
}

export async function moderateCommentAction(_prev: CommentActionState, formData: FormData): Promise<CommentActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };
  const ctx = context(formData);
  const ref = commentRef(formData);
  const reason = formData.get("reason");
  if (!ctx || !ref) return { error: "Requête invalide." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("moderate_comment", { p_comment_id: ref.id, p_expected_revision: ref.revision, p_reason: typeof reason === "string" ? reason : null });
  return done(ctx.path, error);
}
