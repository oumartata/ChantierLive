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

  // B062 : point d'entrée minimal vers la gestion des ingénieurs habilités —
  // uniquement les organisations dont l'utilisateur est PROPRIÉTAIRE
  // (organizations.owner_profile_id), lues via RLS (organizations_select_owner_or_member,
  // M003), jamais un annuaire des organisations d'autrui.
  const { data: ownedOrganizations } = await supabase
    .from("organizations")
    .select("id, name")
    .eq("owner_profile_id", user.id)
    .is("archived_at", null);

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
        {(ownedOrganizations ?? []).map((org) => (
          <Link
            key={org.id}
            href={`/organisations/${org.id}/ingenieurs`}
            className="text-label font-semibold text-primary"
          >
            Ingénieurs habilités — {org.name}
          </Link>
        ))}
        {/* B061 : catalogue par agence, même périmètre propriétaire que
            ci-dessus ; parcours ingénieur (validations-plans) toujours
            affiché, sans dépendre d'une désignation connue ici (la page gère
            elle-même l'absence de demande en attente). */}
        {(ownedOrganizations ?? []).map((org) => (
          <Link
            key={`catalogue-${org.id}`}
            href={`/organisations/${org.id}/catalogue`}
            className="text-label font-semibold text-primary"
          >
            Catalogue de plans — {org.name}
          </Link>
        ))}
        <Link href="/validations-plans" className="text-label font-semibold text-primary">
          Plans à valider (ingénieur)
        </Link>
        <LogoutButton />
      </Card>
    </div>
  );
}
