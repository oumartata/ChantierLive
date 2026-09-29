import { redirect } from "next/navigation";
import { getVerifiedUser } from "@/lib/supabase/server";
import { parseInvitationToken, invitationResumePath } from "@/lib/invitationResume";
import { InscriptionForm } from "./InscriptionForm";

// Même garde qu'à /connexion : accès direct avec session valide -> reprise
// de l'invitation en cours si son jeton est encore porté, sinon tableau de
// bord. Jamais de formulaire d'inscription affiché à un compte déjà
// authentifié.
export default async function InscriptionPage({
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
  return <InscriptionForm />;
}
