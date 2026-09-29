import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Card, AlertBanner, StatusChip, EmptyState, Button } from "@/components/ui";
import { createClient, getVerifiedUser } from "@/lib/supabase/server";
import { LogoutButton } from "./LogoutButton";

const STATUS_LABEL: Record<string, { label: string; variant: "neutral" | "info" | "success" | "attention" }> = {
  DRAFT: { label: "Brouillon", variant: "neutral" },
  ACTIVE: { label: "Actif", variant: "success" },
  SUSPENDED: { label: "Suspendu", variant: "attention" },
  COMPLETED: { label: "Terminé", variant: "info" },
  ARCHIVED: { label: "Archivé", variant: "neutral" },
  READ_ONLY: { label: "Lecture seule", variant: "neutral" },
};

const ROLE_LABEL: Record<string, string> = {
  OWNER_PRIMARY: "Propriétaire principal",
  OWNER_CO_OWNER: "Copropriétaire",
  CONTRACTOR: "Entrepreneur",
  SITE_MANAGER: "Chef de chantier",
};

function roleLabel(role: string, ownerProfile: string | null): string {
  const key = role === "OWNER" ? `OWNER_${ownerProfile}` : role;
  return ROLE_LABEL[key] ?? role;
}

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

  // "Mes chantiers" : lecture directe via RLS (project_memberships_select_own
  // + projects_select_own_membership, M004) — jamais un RPC dédié nécessaire
  // ici, la portée est déjà strictement celle de l'appelant. Adhésions
  // révoquées explicitement exclues (jamais affichées comme un chantier actif).
  const { data: memberships } = await supabase
    .from("project_memberships")
    .select("role, owner_profile, projects(id, name, status)")
    .eq("profile_id", user.id)
    .is("revoked_at", null);

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
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <h1 className="text-h1 font-bold text-ink">Tableau de bord</h1>
      {banner}

      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-h2 font-semibold text-ink">Mes chantiers</h2>
          <Link href="/chantiers/nouveau" className="text-label font-semibold text-primary">
            Créer un chantier
          </Link>
        </div>

        {(memberships ?? []).length === 0 ? (
          <EmptyState
            title="Aucun chantier pour le moment"
            description="Créez votre premier chantier, ou acceptez une invitation reçue pour en rejoindre un."
            action={
              <Link href="/chantiers/nouveau">
                <Button size="compact">Créer un chantier</Button>
              </Link>
            }
          />
        ) : (
          <div className="flex flex-col gap-3">
            {(memberships ?? []).map((m, i) => {
              const project = Array.isArray(m.projects) ? m.projects[0] : m.projects;
              if (!project) return null;
              const status = STATUS_LABEL[project.status] ?? { label: project.status, variant: "neutral" as const };
              return (
                <Card key={project.id ?? i} className="flex flex-col gap-2 p-5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex flex-col gap-1">
                    <p className="text-label font-semibold text-ink">{project.name}</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusChip variant={status.variant} label={status.label} />
                      <span className="text-caption text-muted">{roleLabel(m.role, m.owner_profile)}</span>
                    </div>
                  </div>
                  <Link href={`/chantiers/${project.id}/modifier`}>
                    <Button variant="secondary" size="compact">
                      Ouvrir
                    </Button>
                  </Link>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {ownedOrganizations && ownedOrganizations.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-h2 font-semibold text-ink">Outils professionnels</h2>
          <Card className="flex flex-col gap-3 p-5">
            {ownedOrganizations.map((org) => (
              <div key={org.id} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-body text-ink">{org.name}</span>
                <div className="flex gap-4">
                  <Link href={`/organisations/${org.id}/ingenieurs`} className="text-label font-semibold text-primary">
                    Ingénieurs habilités
                  </Link>
                  {/* B061 : catalogue par agence, même périmètre propriétaire que
                      ci-dessus. */}
                  <Link href={`/organisations/${org.id}/catalogue`} className="text-label font-semibold text-primary">
                    Catalogue de plans
                  </Link>
                </div>
              </div>
            ))}
          </Card>
        </section>
      ) : null}

      {/* Parcours ingénieur (validations-plans) : toujours affiché, sans
          dépendre d'une désignation connue ici — la page gère elle-même
          l'absence de demande en attente. */}
      <Link href="/validations-plans" className="text-label font-semibold text-primary">
        Plans à valider (ingénieur)
      </Link>

      {/* Identité + déconnexion déjà présentes dans la navigation
          (ordinateur, colonne latérale) ; conservées ici aussi pour un accès
          direct sur mobile, où la barre de navigation basse ne les affiche
          pas (espace limité à 5 destinations, UI_KIT_SPEC.yaml). */}
      <p className="text-caption text-muted">{user.email ?? user.phone}</p>
      <LogoutButton />
    </div>
  );
}
