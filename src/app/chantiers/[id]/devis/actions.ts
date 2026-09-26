"use server";

import { revalidatePath } from "next/cache";
import { createClient, requireVerifiedAccount } from "@/lib/supabase/server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// B065. Traduit les codes d'erreur des RPC M021 en texte destiné à l'utilisateur.
function mapQuoteError(message: string | undefined): string {
  switch (message) {
    case "account_provisional":
      return "Vérifiez votre identifiant (e-mail ou téléphone) avant de continuer.";
    case "not_authorized":
      return "Vous n'êtes pas autorisé à effectuer cette action.";
    case "expected_revision_required":
    case "quote_conflict":
      return "Le devis a été modifié entre-temps. Rechargez la page puis réessayez.";
    case "no_retained_plan":
      return "Le propriétaire doit d'abord retenir un plan pour ce chantier.";
    case "plan_not_retained_and_published":
      return "Le plan de cette estimation doit être à la fois retenu et publié pour la proposer.";
    case "plan_changed":
      return "Le plan retenu ou publié a changé depuis la proposition. L'entrepreneur doit faire une nouvelle proposition.";
    case "quote_accepted":
      return "Le devis est déjà accepté : toute modification passe par un avenant.";
    case "version_not_estimate":
      return "Seule une estimation peut être proposée.";
    case "version_not_pending":
      return "Cette version n'est plus la proposition en attente.";
    case "quote_total_zero":
      return "Un devis proposé doit avoir un montant supérieur à zéro.";
    case "invalid_lines_count":
      return "Un devis compte de 1 à 200 lignes.";
    case "invalid_line":
      return "Ligne invalide : libellé et unité obligatoires, quantité avec au plus 3 décimales, prix unitaire en FCFA entiers.";
    case "amount_out_of_bounds":
      return "Montant hors limites : quantité de 0 à 1 000 000, prix unitaire jusqu'à 10 milliards FCFA, ligne et total jusqu'à 1 000 milliards FCFA.";
    case "invalid_decision":
    case "invalid_reason":
      return "Décision invalide.";
    default:
      return "Une erreur est survenue. Réessayez.";
  }
}

export type QuoteActionState = { error: string } | null;

function readRevision(formData: FormData): number | null {
  const raw = formData.get("expected_revision");
  const n = typeof raw === "string" ? Number(raw) : NaN;
  return Number.isInteger(n) ? n : null;
}

function isUuid(value: FormDataEntryValue | null): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

// Les lignes sont transmises en texte (quantité et prix) : aucune conversion
// en nombre flottant ici, le serveur vérifie les formats avant conversion.
export async function createEstimateAction(_prev: QuoteActionState, formData: FormData): Promise<QuoteActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };

  const projectId = formData.get("project_id");
  const revision = readRevision(formData);
  const linesRaw = formData.get("lines");
  if (!isUuid(projectId) || revision === null || typeof linesRaw !== "string") return { error: "Requête invalide." };
  let lines: unknown;
  try {
    lines = JSON.parse(linesRaw);
  } catch {
    return { error: "Requête invalide." };
  }

  // Saisie francophone : virgule décimale et espaces de milliers normalisés
  // en TEXTE uniquement (aucune conversion numérique) ; le format strict est
  // ensuite vérifié côté SQL, sans arrondi.
  if (Array.isArray(lines)) {
    lines = lines.map((line) =>
      line && typeof line === "object"
        ? {
            ...line,
            quantity: typeof line.quantity === "string" ? line.quantity.replace(/\s/g, "").replace(",", ".") : line.quantity,
            unit_price_fcfa:
              typeof line.unit_price_fcfa === "string" ? line.unit_price_fcfa.replace(/\s/g, "") : line.unit_price_fcfa,
          }
        : line
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("create_quote_estimate", {
    p_project_id: projectId,
    p_lines: lines,
    p_expected_revision: revision,
  });
  if (error) return { error: mapQuoteError(error.message) };

  revalidatePath(`/chantiers/${projectId}/devis`);
  return null;
}

export async function proposeQuoteAction(_prev: QuoteActionState, formData: FormData): Promise<QuoteActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };

  const projectId = formData.get("project_id");
  const versionId = formData.get("version_id");
  const revision = readRevision(formData);
  if (!isUuid(projectId) || !isUuid(versionId) || revision === null) return { error: "Requête invalide." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("propose_quote_version", { p_version_id: versionId, p_expected_revision: revision });
  if (error) return { error: mapQuoteError(error.message) };

  revalidatePath(`/chantiers/${projectId}/devis`);
  return null;
}

export async function decideQuoteAction(_prev: QuoteActionState, formData: FormData): Promise<QuoteActionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { error: guard.message };

  const projectId = formData.get("project_id");
  const versionId = formData.get("version_id");
  const decision = formData.get("decision");
  const reason = formData.get("reason");
  const revision = readRevision(formData);
  if (!isUuid(projectId) || !isUuid(versionId) || revision === null || (decision !== "ACCEPTED" && decision !== "REFUSED")) {
    return { error: "Requête invalide." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("decide_quote_version", {
    p_version_id: versionId,
    p_decision: decision,
    p_reason: typeof reason === "string" && reason.trim() !== "" ? reason.trim() : null,
    p_expected_revision: revision,
  });
  if (error) return { error: mapQuoteError(error.message) };

  revalidatePath(`/chantiers/${projectId}/devis`);
  return null;
}
