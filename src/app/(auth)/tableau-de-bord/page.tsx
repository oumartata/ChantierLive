import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Card, AlertBanner } from "@/components/ui";
import { createClient, getVerifiedUser } from "@/lib/supabase/server";
import { LogoutButton } from "./LogoutButton";

// Route protégée : revérifie l'identité côté serveur (getUser, pas
// getSession) avant tout rendu. FR008 : l'état provisional lu ici ne remplace
// pas les contrôles serveur de chaque action sensible future.
export default async function TableauDeBordPage() {
  const user = await getVerifiedUser();
  if (!user) {
    redirect("/connexion");
  }

  const supabase = await createClient();
  const { data: provisional, error: provisionalError } = await supabase.rpc(
    "is_account_provisional"
  );

  // Seul data === false SANS erreur permet "Compte vérifié". Une erreur RPC
  // ou un résultat null/undefined ne doit jamais être traité comme "vérifié"
  // ni comme "provisoire" — l'information est simplement indisponible.
  let banner: ReactNode;
  if (provisionalError || provisional === null || provisional === undefined) {
    banner = (
      <AlertBanner
        variant="warning"
        title="Vérification indisponible"
        explanation="L'état du compte n'a pas pu être vérifié pour l'instant. Réessayez plus tard."
      />
    );
  } else if (provisional === false) {
    banner = (
      <AlertBanner
        variant="information"
        title="Compte vérifié"
        explanation="Au moins un identifiant vérifié est associé à ce compte."
      />
    );
  } else {
    banner = (
      <AlertBanner
        variant="warning"
        title="Compte provisoire"
        explanation="Aucun identifiant vérifié pour l'instant. Certaines actions resteront indisponibles tant qu'un e-mail ou un téléphone n'est pas confirmé."
      />
    );
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-title font-bold text-ink">Tableau de bord</h1>
      <Card className="flex flex-col gap-4 p-6">
        {banner}
        <Link href="/chantiers/nouveau" className="text-label font-semibold text-primary">
          Créer un chantier
        </Link>
        <LogoutButton />
      </Card>
    </div>
  );
}
