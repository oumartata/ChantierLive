import Link from "next/link";
import { redirect } from "next/navigation";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { AlertBanner } from "@/components/ui";
import { ModifierChantierForm } from "./ModifierChantierForm";

// Formulaire d'édition — atteint UNIQUEMENT via l'action "Modifier" explicite
// de la fiche chantier (../page.tsx), jamais la page affichée par défaut à
// l'ouverture. Les bannières liées à un enregistrement/une invitation
// vivent désormais sur la fiche (destination du redirect après succès) —
// cette page ne garde que le formulaire lui-même.
//
// Isolation tenancy : la lecture passe par le client de session utilisateur
// (RLS projects_select_own_membership, M004) — un chantier hors adhésion
// active renvoie 0 ligne, indistinguable d'un identifiant inexistant. Aucune
// clé service_role, aucun contournement de RLS ici.
export default async function ModifierChantierPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

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
  const [{ data: project }, { data: membership }] = await Promise.all([
    supabase
      .from("projects")
      .select(
        "id, name, country, address, latitude, longitude, planned_start_date, planned_end_date, budget::text, status, revision"
      )
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("project_memberships")
      .select("role, owner_profile")
      .eq("project_id", id)
      .eq("profile_id", user.id)
      .is("revoked_at", null)
      .maybeSingle(),
  ]);

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

  // Reflet, EN PLUS du contrôle serveur (update_draft_project le revérifie
  // intégralement à l'enregistrement, inchangé) : un membre non autorisé ne
  // doit pas voir un formulaire pré-rempli qui échouera silencieusement au
  // clic — un message clair, immédiatement, plutôt qu'un formulaire qui
  // fonctionne en apparence.
  const canEdit =
    membership?.role === "CONTRACTOR" ||
    (membership?.role === "OWNER" && membership.owner_profile === "PRIMARY");

  if (!canEdit) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
        <h1 className="text-h1 font-bold text-ink">Modifier le chantier</h1>
        <AlertBanner
          variant="warning"
          title="Modification non disponible"
          explanation="Seuls le propriétaire principal et l'entreprise de ce chantier peuvent modifier ces informations."
        />
        <Link href={`/chantiers/${id}`} className="text-label font-semibold text-primary">
          Retour à la fiche du chantier
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
      {project.status !== "DRAFT" ? (
        <AlertBanner
          variant="warning"
          title="Chantier non modifiable ici"
          explanation="Ce chantier n'est plus en brouillon."
        />
      ) : (
        <>
          <h1 className="text-h1 font-bold text-ink">Informations du chantier</h1>
          <ModifierChantierForm project={project} />
        </>
      )}
    </div>
  );
}
