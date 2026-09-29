import { redirect } from "next/navigation";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { AlertBanner } from "@/components/ui";
import { NouvelleInvitationForm } from "./NouvelleInvitationForm";

// Isolation tenancy identique à /chantiers/[id]/modifier (M004b, B014) : la
// lecture passe par le client de session utilisateur (RLS
// projects_select_own_membership) — un chantier hors adhésion active renvoie
// 0 ligne. Le rôle affiché ici ne sert qu'à composer le formulaire (choix
// proposés) ; create_invitation (M006) revérifie indépendamment côté SQL,
// sous verrou, avant toute émission — ceci n'est jamais le contrôle
// d'autorisation réel.
export default async function NouvelleInvitationPage({
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
  const { data: project } = await supabase
    .from("projects")
    .select("id, name")
    .eq("id", id)
    .maybeSingle();

  if (!project) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
        <h1 className="text-h1 font-bold text-ink">Inviter</h1>
        <AlertBanner
          variant="error"
          title="Chantier inaccessible"
          explanation="Ce chantier n'existe pas ou vous n'y avez pas accès."
        />
      </div>
    );
  }

  const { data: membership } = await supabase
    .from("project_memberships")
    .select("role, owner_profile")
    .eq("project_id", id)
    .eq("profile_id", user.id)
    .is("revoked_at", null)
    .maybeSingle();

  // Seuls OWNER PRIMARY et CONTRACTOR actifs peuvent émettre une invitation
  // (BR021/FR027-030, matrice reprise telle quelle dans create_invitation) —
  // même filtre que le RPC, affiché ici uniquement pour guider l'appelant,
  // jamais pour décider à sa place.
  const canInvite =
    membership &&
    (membership.role === "CONTRACTOR" ||
      (membership.role === "OWNER" && membership.owner_profile === "PRIMARY"));

  if (!canInvite) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
        <h1 className="text-h1 font-bold text-ink">Inviter — {project.name}</h1>
        <AlertBanner
          variant="warning"
          title="Action indisponible"
          explanation="Seul le propriétaire principal ou l'entrepreneur de ce chantier peut créer une invitation."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-h1 font-bold text-ink">Inviter — {project.name}</h1>
      <NouvelleInvitationForm projectId={project.id} emitterRole={membership.role} />
    </div>
  );
}
