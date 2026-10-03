import Link from "next/link";
import { redirect } from "next/navigation";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { Card, EmptyState, Button } from "@/components/ui";

// Catalogue de plans — réutilise exactement la requête déjà existante de
// tableau-de-bord/page.tsx (organisations dont le profil est propriétaire,
// RLS organizations_select_owner_or_member, M003) et la page
// organisations/[id]/catalogue (déjà construite, B061) sans aucune
// modification. N'affiche aucune organisation inventée : un CONTRACTOR
// invité sur un chantier sans être propriétaire d'aucune organisation voit
// une explication, jamais une liste vide silencieuse.
export default async function EntrepriseCataloguePage() {
  const user = await getVerifiedUser();
  if (!user) {
    redirect("/connexion");
  }

  const supabase = await createClient();
  const { data: ownedOrganizations } = await supabase
    .from("organizations")
    .select("id, name")
    .eq("owner_profile_id", user.id)
    .is("archived_at", null);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <h1 className="text-h1 font-bold text-ink">Catalogue de plans</h1>
      {!ownedOrganizations || ownedOrganizations.length === 0 ? (
        <EmptyState
          title="Aucune organisation à votre nom"
          description="La gestion du catalogue est réservée au propriétaire de l'organisation. Vous n'en possédez aucune pour l'instant."
        />
      ) : (
        <div className="flex flex-col gap-3">
          {ownedOrganizations.map((org) => (
            <Card key={org.id} className="flex items-center justify-between gap-3 p-5">
              <p className="text-label font-semibold text-ink">{org.name}</p>
              <Link href={`/organisations/${org.id}/catalogue`}>
                <Button variant="secondary" size="compact">
                  Gérer le catalogue
                </Button>
              </Link>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
