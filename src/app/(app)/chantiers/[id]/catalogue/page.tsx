import { redirect } from "next/navigation";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { AlertBanner } from "@/components/ui";

function Unavailable({ title, explanation }: { title: string; explanation: string }) {
  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-h1 font-bold text-ink">Catalogue</h1>
      <AlertBanner variant="warning" title={title} explanation={explanation} />
    </div>
  );
}

// Consultation du catalogue par le propriétaire du chantier — fonctionnalité
// PROPOSÉE (PREPARATION_CATALOGUE_MODIFIABLE.md §8) mais non implémentée :
// le lien chantier -> organisation n'est pas déterminable aujourd'hui pour
// un chantier créé par son propriétaire (projects.organization_id reste
// NULL, voir §8.1), donc aucune RPC de lecture n'a été créée. Cette page
// donne au menu propriétaire une destination réelle (maquette fondateur
// 2026-10-03) sans jamais lire ni afficher de modèle, en attendant la
// décision du fondateur sur la résolution organisation <-> chantier.
export default async function ChantierCataloguePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getVerifiedUser();
  if (!user) {
    redirect("/connexion");
  }

  const supabase = await createClient();
  const [{ data: project }, { data: membership }] = await Promise.all([
    supabase.from("projects").select("id, name").eq("id", id).maybeSingle(),
    supabase
      .from("project_memberships")
      .select("role")
      .eq("project_id", id)
      .eq("profile_id", user.id)
      .is("revoked_at", null)
      .maybeSingle(),
  ]);

  if (!project || !membership) {
    return <Unavailable title="Chantier inaccessible" explanation="Ce chantier n'existe pas ou vous n'y avez pas accès." />;
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-h1 font-bold text-ink">Catalogue — {project.name}</h1>
      <AlertBanner
        variant="information"
        title="Fonctionnalité pas encore disponible"
        explanation="La consultation des modèles publiés de l'entreprise liée à ce chantier n'est pas encore construite : une décision du fondateur sur le lien entre chantier et organisation reste nécessaire avant toute mise en service. Aucun modèle, brouillon ou fichier n'est accessible depuis cette page."
      />
    </div>
  );
}
