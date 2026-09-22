import { redirect } from "next/navigation";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { AlertBanner } from "@/components/ui";
import { ModifierChantierForm } from "./ModifierChantierForm";

// Isolation tenancy : la lecture passe par le client de session utilisateur
// (RLS projects_select_own_membership, M004) — un chantier hors adhésion
// active renvoie 0 ligne, indistinguable d'un identifiant inexistant. Aucune
// clé service_role, aucun contournement de RLS ici.
export default async function ModifierChantierPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ enregistre?: string }>;
}) {
  const { id } = await params;
  const { enregistre } = await searchParams;

  const user = await getVerifiedUser();
  if (!user) {
    redirect("/connexion");
  }

  const supabase = await createClient();
  // budget::text : un bigint transmis en JSON comme nombre est déjà tronqué
  // par JSON.parse (limite de précision IEEE754, 2^53-1) avant même
  // d'atteindre notre code — un String(nombre) après coup ne répare rien,
  // la perte a déjà eu lieu. Le cast fait retourner une chaîne JSON par
  // PostgREST : jamais interprétée comme un nombre JS, précision exacte
  // jusqu'au formulaire (vérifié empiriquement : 9007199254740993 sans
  // cast revient tronqué, avec cast revient identique).
  const { data: project } = await supabase
    .from("projects")
    .select(
      "id, name, country, address, latitude, longitude, planned_start_date, planned_end_date, budget::text, status, revision"
    )
    .eq("id", id)
    .maybeSingle();

  if (!project) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
        <h1 className="text-h1 font-bold text-ink">Modifier le chantier</h1>
        <AlertBanner
          variant="error"
          title="Chantier inaccessible"
          explanation="Ce chantier n'existe pas ou vous n'y avez pas accès."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-h1 font-bold text-ink">Modifier le chantier</h1>
      {enregistre ? (
        <AlertBanner
          variant="information"
          title="Enregistré"
          explanation="Vos modifications ont été enregistrées."
        />
      ) : null}
      {project.status !== "DRAFT" ? (
        <AlertBanner
          variant="warning"
          title="Chantier non modifiable ici"
          explanation="Ce chantier n'est plus en brouillon."
        />
      ) : (
        <ModifierChantierForm project={project} />
      )}
    </div>
  );
}
