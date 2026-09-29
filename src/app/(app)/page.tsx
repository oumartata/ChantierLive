import { redirect } from "next/navigation";
import { getVerifiedUser } from "@/lib/supabase/server";
import { parseInvitationToken, invitationResumePath } from "@/lib/invitationResume";

// "/" n'affiche plus la galerie de composants (déplacée vers
// /dev-composants, hors navigation) : une session valide va directement au
// tableau de bord — reprend une invitation en cours si son jeton est encore
// porté ici, jamais un "next" arbitraire (même mécanisme que connexion/
// inscription, voir src/lib/invitationResume.ts). Sans session, direction
// naturelle vers la connexion plutôt qu'une page d'accueil publique non
// encore définie.
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ invitation?: string }>;
}) {
  const { invitation } = await searchParams;
  const user = await getVerifiedUser();
  const token = parseInvitationToken(invitation ?? null);

  if (user) {
    redirect(token ? invitationResumePath(token) : "/tableau-de-bord");
  }
  redirect(token ? `/connexion?invitation=${token}` : "/connexion");
}
