"use server";

import { revalidatePath } from "next/cache";
import { createClient, requireVerifiedAccount } from "@/lib/supabase/server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// B066. Traduit les codes d'erreur des RPC M022 en texte destiné à l'utilisateur.
function mapChangeOrderError(message: string | undefined): string {
  switch (message) {
    case "account_provisional":
      return "Vérifiez votre identifiant (e-mail ou téléphone) avant de continuer.";
    case "not_authorized":
      return "Vous n'êtes pas autorisé à effectuer cette action.";
    case "expected_revision_required":
    case "change_order_conflict":
      return "L'avenant a été modifié entre-temps. Rechargez la page puis réessayez.";
    case "quote_not_accepted":
      return "Un avenant ne peut être créé qu'après acceptation du devis initial.";
    case "change_order_accepted":
      return "Cet avenant est déjà accepté : toute autre modification passe par un nouvel avenant.";
    case "version_not_estimate":
      return "Seule une estimation peut être proposée.";
    case "version_not_pending":
      return "Cette version n'est plus la proposition en attente.";
    case "change_order_not_accepted":
      return "L'exécution ne peut être autorisée qu'après acceptation de l'avenant.";
    case "execution_already_authorized":
      return "L'exécution de cet avenant est déjà autorisée.";
    case "invalid_title":
      return "Le titre est obligatoire (1 à 200 caractères).";
    case "invalid_reason":
      return "Le motif est obligatoire (1 à 1 000 caractères).";
    case "invalid_lines_count":
      return "Un avenant compte de 1 à 200 lignes.";
    case "invalid_line":
      return "Ligne invalide : libellé et unité obligatoires, quantité avec au plus 3 décimales, prix unitaire en FCFA entiers.";
    case "line_amount_not_positive":
      return "Chaque ligne d'un avenant doit avoir un prix unitaire et un montant d'au moins 1 FCFA.";
    case "amount_out_of_bounds":
      return "Montant hors limites : quantité de 0 à 1 000 000, prix unitaire jusqu'à 10 milliards FCFA, ligne et total jusqu'à 1 000 milliards FCFA.";
    case "invalid_decision":
      return "Décision invalide.";
    default:
      return "Une erreur est survenue. Réessayez.";
  }
}

export type ChangeOrderActionState = { error: string } | null;

function readRevision(formData: FormData): number | null {
  const raw = formData.get("expected_revision");
  if (typeof raw !== "string" || !/^\d{1,9}$/.test(raw)) return null;
  return Number(raw);
}

function isUuid(value: FormDataEntryValue | null): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function text(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

const path = (projectId: string) => `/chantiers/${projectId}/avenants`;

// Nouvel avenant (change_order_id vide, révision 0) ou nouvelle version d'un
// avenant existant (change_order_id transmis). Quantités et prix restent en
// TEXTE : virgule décimale et espaces normalisés sans conversion numérique ;
// format, bornes et D119 vérifiés côté SQL.
export async function createChangeOrderEstimateAction(
  _prev: ChangeOrderActionState,
  formData: FormData
): Promise<ChangeOrderActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };

  const projectId = formData.get("project_id");
  const changeOrderRaw = formData.get("change_order_id");
  const revision = readRevision(formData);
  const linesRaw = formData.get("lines");
  const changeOrderId = changeOrderRaw === null || changeOrderRaw === "" ? null : changeOrderRaw;
  if (!isUuid(projectId) || (changeOrderId !== null && !isUuid(changeOrderId)) || revision === null || typeof linesRaw !== "string") {
    return { error: "Requête invalide." };
  }
  let lines: unknown;
  try {
    lines = JSON.parse(linesRaw);
  } catch {
    return { error: "Requête invalide." };
  }
  if (Array.isArray(lines)) {
    lines = lines.map((line) =>
      line && typeof line === "object"
        ? {
            ...line,
            quantity: typeof line.quantity === "string" ? line.quantity.replace(/\s/g, "").replace(",", ".") : line.quantity,
            unit_price_fcfa: typeof line.unit_price_fcfa === "string" ? line.unit_price_fcfa.replace(/\s/g, "") : line.unit_price_fcfa,
          }
        : line
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("create_change_order_estimate", {
    p_project_id: projectId,
    p_change_order_id: changeOrderId,
    p_title: text(formData.get("title")),
    p_reason: text(formData.get("reason")),
    p_lines: lines,
    p_expected_revision: revision,
  });
  if (error) return { error: mapChangeOrderError(error.message) };

  revalidatePath(path(projectId));
  return null;
}

export async function proposeChangeOrderAction(_prev: ChangeOrderActionState, formData: FormData): Promise<ChangeOrderActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };

  const projectId = formData.get("project_id");
  const versionId = formData.get("version_id");
  const revision = readRevision(formData);
  if (!isUuid(projectId) || !isUuid(versionId) || revision === null) return { error: "Requête invalide." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("propose_change_order_version", { p_version_id: versionId, p_expected_revision: revision });
  if (error) return { error: mapChangeOrderError(error.message) };

  revalidatePath(path(projectId));
  return null;
}

export async function decideChangeOrderAction(_prev: ChangeOrderActionState, formData: FormData): Promise<ChangeOrderActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };

  const projectId = formData.get("project_id");
  const versionId = formData.get("version_id");
  const decision = formData.get("decision");
  const reason = text(formData.get("reason"));
  const revision = readRevision(formData);
  if (!isUuid(projectId) || !isUuid(versionId) || revision === null || (decision !== "ACCEPTED" && decision !== "REFUSED")) {
    return { error: "Requête invalide." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("decide_change_order_version", {
    p_version_id: versionId,
    p_decision: decision,
    p_reason: reason === "" ? null : reason,
    p_expected_revision: revision,
  });
  if (error) return { error: mapChangeOrderError(error.message) };

  revalidatePath(path(projectId));
  return null;
}

export async function authorizeChangeOrderExecutionAction(
  _prev: ChangeOrderActionState,
  formData: FormData
): Promise<ChangeOrderActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };

  const projectId = formData.get("project_id");
  const changeOrderId = formData.get("change_order_id");
  const revision = readRevision(formData);
  if (!isUuid(projectId) || !isUuid(changeOrderId) || revision === null) return { error: "Requête invalide." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("authorize_change_order_execution", { p_change_order_id: changeOrderId, p_expected_revision: revision });
  if (error) return { error: mapChangeOrderError(error.message) };

  revalidatePath(path(projectId));
  return null;
}
