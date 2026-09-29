import Link from "next/link";
import { redirect } from "next/navigation";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { AlertBanner } from "@/components/ui";
import { ModifierChantierForm } from "./ModifierChantierForm";

// Constat fondateur (diagnostic à deux comptes réellement isolés,
// localhost/127.0.0.1) : cette page rendait un contenu STRICTEMENT
// identique à un propriétaire et à une entreprise sur le même chantier —
// aucune étiquette d'espace, aucun lien vers avenants/acomptes/synthèse
// financière (déjà livrés mais seulement atteignables depuis devis/acomptes
// eux-mêmes). Les droits serveur sont corrects et déjà vérifiés
// indépendamment de cette page (create_quote_estimate refuse le
// propriétaire avec not_authorized ; les pages devis/équipe se
// différencient déjà par rôle) — seule cette page ne le montrait pas.
const SPACE_LABEL: Record<string, string> = {
  OWNER: "Espace propriétaire",
  CONTRACTOR: "Espace entreprise",
  SITE_MANAGER: "Espace chef de chantier",
};

// Isolation tenancy : la lecture passe par le client de session utilisateur
// (RLS projects_select_own_membership, M004) — un chantier hors adhésion
// active renvoie 0 ligne, indistinguable d'un identifiant inexistant. Aucune
// clé service_role, aucun contournement de RLS ici.
export default async function ModifierChantierPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ enregistre?: string; invitation?: string }>;
}) {
  const { id } = await params;
  const { enregistre, invitation } = await searchParams;

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

  // Même lecture RLS que "Mes chantiers" (tableau de bord) : seule
  // l'adhésion active de l'appelant sur CE chantier, jamais un rôle global.
  // maybeSingle() peut légitimement renvoyer null (RLS/adhésion introuvable
  // dans un état transitoire) — traité comme absence d'étiquette, jamais une
  // erreur bloquante : la page reste utilisable, seule l'étiquette d'espace
  // est omise.
  const { data: membership } = await supabase
    .from("project_memberships")
    .select("role")
    .eq("project_id", id)
    .eq("profile_id", user.id)
    .is("revoked_at", null)
    .maybeSingle();
  const spaceLabel = membership ? SPACE_LABEL[membership.role] : null;

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <div>
        {spaceLabel ? <p className="text-caption font-semibold text-primary">{spaceLabel}</p> : null}
        <h1 className="text-h1 font-bold text-ink">{project.name}</h1>
      </div>
      {enregistre ? (
        <AlertBanner
          variant="information"
          title="Enregistré"
          explanation="Vos modifications ont été enregistrées."
        />
      ) : null}
      {invitation === "acceptee" ? (
        <AlertBanner
          variant="information"
          title="Invitation acceptée"
          explanation="Vous êtes désormais membre de ce chantier."
        />
      ) : null}
      {/* B015 : visible quel que soit le statut du chantier — aucune source
          ne restreint la création d'invitation aux seuls chantiers DRAFT
          (contrairement à create_draft_project/update_draft_project, B014). */}
      <Link href={`/chantiers/${id}/invitations/nouveau`} className="text-label font-semibold text-primary">
        Inviter quelqu&apos;un sur ce chantier
      </Link>
      {/* B016 : gestion (consultation + révocation) des invitations
          relevant du rôle habilitant courant de l'appelant sur ce chantier
          — accessible quel que soit le statut, comme le lien ci-dessus. */}
      <Link href={`/chantiers/${id}/invitations`} className="text-label font-semibold text-primary">
        Gérer les invitations
      </Link>
      {/* B017 : consultation de l'équipe, retrait des participants non
          principaux et gestion des délégations — accessible quel que soit
          le statut, comme les liens ci-dessus. */}
      <Link href={`/chantiers/${id}/equipe`} className="text-label font-semibold text-primary">
        Gérer l&apos;équipe
      </Link>
      {/* B027 : suivi par photos/vidéos — accessible quel que soit le
          statut, comme les liens ci-dessus ; list_project_media (M010)
          reste la seule autorité sur ce qui est effectivement affiché. */}
      <Link href={`/chantiers/${id}/photos`} className="text-label font-semibold text-primary">
        Photos et vidéos
      </Link>
      {/* B063 : plans candidats et plan retenu — accessible quel que soit
          le statut ; list_project_plan_candidates (M020) reste la seule
          autorité sur ce qui est affiché. */}
      <Link href={`/chantiers/${id}/plans`} className="text-label font-semibold text-primary">
        Plans du chantier
      </Link>
      {/* B065 : devis (estimation privée, proposition, décision du client) ;
          les RPC M021 restent la seule autorité sur ce qui est affiché —
          la page elle-même distingue déjà proposition (entreprise) et
          décision (propriétaire), aucun changement nécessaire là. */}
      <Link href={`/chantiers/${id}/devis`} className="text-label font-semibold text-primary">
        Devis
      </Link>
      {/* B066 : avenants — même distinction proposition/décision que les
          devis, déjà gérée par cette page ; manquait seulement ici. */}
      <Link href={`/chantiers/${id}/avenants`} className="text-label font-semibold text-primary">
        Avenants
      </Link>
      {/* B033 : acomptes — déclaration (propriétaire) / confirmation
          (entreprise) déjà distinguées par cette page ; manquait ici. */}
      <Link href={`/chantiers/${id}/acomptes`} className="text-label font-semibold text-primary">
        Acomptes
      </Link>
      {/* B068 : synthèse financière, lecture seule pour tous les rôles
          autorisés (D140) ; manquait ici. */}
      <Link href={`/chantiers/${id}/finances`} className="text-label font-semibold text-primary">
        Synthèse financière
      </Link>

      {project.status !== "DRAFT" ? (
        <AlertBanner
          variant="warning"
          title="Chantier non modifiable ici"
          explanation="Ce chantier n'est plus en brouillon."
        />
      ) : (
        <>
          <h2 className="text-h2 font-semibold text-ink">Informations du chantier</h2>
          <ModifierChantierForm project={project} />
        </>
      )}
    </div>
  );
}
