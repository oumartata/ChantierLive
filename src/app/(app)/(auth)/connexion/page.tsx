import { redirect } from "next/navigation";
import { getVerifiedUser } from "@/lib/supabase/server";
import { parseInvitationToken, invitationResumePath } from "@/lib/invitationResume";
import { ConnexionForm } from "./ConnexionForm";

// Accès direct avec une session déjà valide : redirige immédiatement, sans
// jamais afficher le formulaire à un compte déjà connecté. Reprend
// l'invitation en cours si son jeton est encore porté ici (même mécanisme
// dédié que postAuthRedirectPath, voir (auth)/actions.ts) — jamais perdue.
// Ne boucle pas : /invitations/<jeton> et /tableau-de-bord ne redirigent
// jamais vers /connexion pour un utilisateur authentifié.
export default async function ConnexionPage({
  searchParams,
}: {
  searchParams: Promise<{ invitation?: string }>;
}) {
  const { invitation } = await searchParams;
  const user = await getVerifiedUser();
  if (user) {
    const token = parseInvitationToken(invitation ?? null);
    redirect(token ? invitationResumePath(token) : "/tableau-de-bord");
  }
  return <ConnexionForm />;
}
