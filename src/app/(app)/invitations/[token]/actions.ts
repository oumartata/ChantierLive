"use server";

import { redirect } from "next/navigation";
import { createClient, getVerifiedUser, requireVerifiedAccount } from "@/lib/supabase/server";

export type InvitationDecisionState = { error: string; code?: string } | null;

// Traduit les codes d'erreur bruts de accept_invitation/refuse_invitation
// (M006a) en texte destiné à l'utilisateur. 'invitation_not_available'
// couvre volontairement plusieurs causes indistinctes (inexistante,
// expirée, déjà décidée, émetteur devenu invalide) — jamais de détail qui
// révélerait laquelle avant authentification ou au-delà du nécessaire.
function mapRpcError(message: string | undefined): string {
  switch (message) {
    case "account_provisional":
      return "Vérifiez votre identifiant (e-mail ou téléphone) avant de continuer.";
    case "invitation_not_available":
    case "sender_no_longer_authorized":
      return "Cette invitation n'est plus disponible. Elle a peut-être expiré, été révoquée, ou déjà traitée.";
    case "target_not_controlled":
      return "Cette invitation cible un identifiant que votre compte ne contrôle pas.";
    case "already_member":
      return "Vous êtes déjà membre de ce chantier. Aucun changement de rôle n'a été effectué.";
    case "quota_exceeded":
      return "Le nombre maximal de membres pour ce rôle est déjà atteint sur ce chantier.";
    default:
      return "Une erreur est survenue. Réessayez.";
  }
}

const TOKEN_RE = /^[0-9a-f]{64}$/;

export async function acceptInvitationAction(
  _prevState: InvitationDecisionState,
  formData: FormData
): Promise<InvitationDecisionState> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) {
    return { error: guard.message };
  }

  const token = formData.get("token");
  if (typeof token !== "string" || !TOKEN_RE.test(token)) {
    return { error: "Lien d'invitation invalide." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("accept_invitation", { p_token: token });

  if (error) {
    return { error: mapRpcError(error.message), code: error.message };
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row.project_id !== "string") {
    return { error: "L'invitation a peut-être été acceptée, mais la réponse est invalide." };
  }

  redirect(`/chantiers/${row.project_id}?invitation=acceptee`);
}

export async function refuseInvitationAction(
  _prevState: InvitationDecisionState,
  formData: FormData
): Promise<InvitationDecisionState> {
  // Contrôle volontairement plus léger qu'accepter (contrat B016) :
  // authentification seule requise, PAS requireVerifiedAccount() — refuser
  // ne crée aucune adhésion, un compte provisional peut refuser une
  // invitation qui lui est destinée.
  const user = await getVerifiedUser();
  if (!user) {
    return { error: "Connexion requise." };
  }

  const token = formData.get("token");
  if (typeof token !== "string" || !TOKEN_RE.test(token)) {
    return { error: "Lien d'invitation invalide." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("refuse_invitation", { p_token: token });

  if (error) {
    return { error: mapRpcError(error.message) };
  }

  redirect("/tableau-de-bord?invitation=refusee");
}
