import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Card, AlertBanner, EmptyState, Button } from "@/components/ui";
import { createClient, getVerifiedUser } from "@/lib/supabase/server";
import { dashboardRole, loadContractorCard, loadOwnerCard, loadSiteManagerCard, type ProjectRef } from "@/lib/dashboard/dashboard";
import { LogoutButton } from "./LogoutButton";
import { ContractorProjectCard, OwnerProjectCard, SiteManagerProjectCard, stamp, statusOf } from "./DashboardCards";

// B044 (D189 T1 à T7) : une seule page d'accueil, un bloc par rôle détenu,
// chaque bloc limité aux chantiers de ce rôle et calculé chantier par
// chantier (aucun total entre chantiers). Les chiffres viennent des
// fonctions existantes appelées avec la session de l'utilisateur
// (src/lib/dashboard/dashboard.ts) : le propriétaire n'en reçoit jamais
// aucune donnée interne (D183), le chef de chantier jamais le budget ni
// l'alerte (D185). Fraîcheur (T3 A) : heure du serveur à la lecture.

const STATUS_FILTERS = [
  { value: "", label: "Tous" },
  { value: "ACTIVE", label: "Actifs" },
  { value: "DRAFT", label: "Brouillons" },
  { value: "SUSPENDED", label: "Suspendus" },
  { value: "COMPLETED", label: "Terminés" },
];

// Route protégée : revérifie l'identité côté serveur (getUser, pas
// getSession) avant tout rendu. FR008 : l'état provisional lu ici ne remplace
// pas les contrôles serveur de chaque action sensible future.
export default async function TableauDeBordPage({ searchParams }: { searchParams: Promise<{ statut?: string }> }) {
  const { statut } = await searchParams;
  const statusFilter = STATUS_FILTERS.some((f) => f.value === statut) ? (statut ?? "") : "";
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
    .select("role, owner_profile, projects(id, name, status, budget)")
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

  // B049 (D194) : lien d'administration pour le seul administrateur de plateforme.
  const { data: isPlatformAdmin } = await supabase.rpc("is_platform_admin");

  // Cartes par rôle, chantier par chantier (T1 A, T7 A).
  const readAt = new Date();
  const today = readAt.toISOString().slice(0, 10);
  const held = (memberships ?? []).flatMap((m) => {
    const project = Array.isArray(m.projects) ? m.projects[0] : m.projects;
    const role = dashboardRole(m.role, m.owner_profile);
    if (!project || !role) return [];
    const ref: ProjectRef = { id: project.id, name: project.name, status: project.status, budget: project.budget === null || project.budget === undefined ? null : String(project.budget) };
    return [{ role, ref }];
  });
  const [ownerCards, contractorCards, siteManagerCards] = await Promise.all([
    Promise.all(held.filter((h) => h.role === "OWNER_PRIMARY" || h.role === "CO_OWNER").map((h) => loadOwnerCard(supabase, h.ref, h.role as "OWNER_PRIMARY" | "CO_OWNER"))),
    Promise.all(held.filter((h) => h.role === "CONTRACTOR").map((h) => loadContractorCard(supabase, h.ref, today))),
    Promise.all(held.filter((h) => h.role === "SITE_MANAGER").map((h) => loadSiteManagerCard(supabase, h.ref, today))),
  ]);
  const portfolioCounts = STATUS_FILTERS.filter((f) => f.value !== "").map((f) => ({ ...f, count: contractorCards.filter((c) => c.project.status === f.value).length })).filter((f) => f.count > 0);
  const shownContractorCards = statusFilter ? contractorCards.filter((c) => c.project.status === statusFilter) : contractorCards;

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

      <p className="text-caption text-muted" data-testid="fraicheur">
        Données lues sur le serveur le {stamp(readAt.toISOString())}. Chaque indicateur ne montre que ce que votre rôle permet de voir sur le chantier.
      </p>

      {/* Ancre stable ciblée par le lien "Mes chantiers" du menu principal
          (AppShell/SectionNavLink) — scroll-mt compense l'en-tête collant
          (h-14) pour que le titre ne soit pas masqué après le saut. */}
      <section id="mes-chantiers" className="flex scroll-mt-20 flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-h2 font-semibold text-ink">Mes chantiers</h2>
          <Link href="/chantiers/nouveau" className="text-label font-semibold text-primary">
            Créer un chantier
          </Link>
        </div>

        {held.length === 0 ? (
          <EmptyState
            title="Aucun chantier pour le moment"
            description="Créez votre premier chantier, ou acceptez une invitation reçue pour en rejoindre un."
            action={
              <Link href="/chantiers/nouveau">
                <Button size="compact">Créer un chantier</Button>
              </Link>
            }
          />
        ) : null}

        {ownerCards.length > 0 ? (
          <div className="flex flex-col gap-3" data-testid="bloc-proprietaire">
            <h3 className="text-label font-semibold text-ink">En tant que propriétaire ({ownerCards.length})</h3>
            <p className="text-caption text-muted">Avancement, décisions, incidents, paiements et activité partagés de vos chantiers.</p>
            {ownerCards.map((card) => (
              <OwnerProjectCard key={card.project.id} card={card} />
            ))}
          </div>
        ) : null}

        {contractorCards.length > 0 ? (
          <div className="flex flex-col gap-3" data-testid="bloc-entreprise">
            <h3 className="text-label font-semibold text-ink">En tant qu&apos;entreprise ({contractorCards.length})</h3>
            <p className="text-caption text-muted">
              {portfolioCounts.map((f) => `${f.count} ${f.label.toLowerCase()}`).join(", ")}. Aucun montant n&apos;est cumulé entre chantiers.
            </p>
            <nav className="flex flex-wrap gap-2" aria-label="Filtrer par statut">
              {STATUS_FILTERS.map((f) => (
                <Link
                  key={f.value || "tous"}
                  href={f.value ? `/tableau-de-bord?statut=${f.value}#mes-chantiers` : "/tableau-de-bord#mes-chantiers"}
                  className={`rounded-small border px-3 py-1 text-caption font-semibold ${statusFilter === f.value ? "border-primary text-primary" : "border-muted/40 text-muted"}`}
                >
                  {f.label}
                </Link>
              ))}
            </nav>
            {shownContractorCards.length === 0 ? (
              <p className="text-body text-muted">Aucun chantier {statusOf(statusFilter).label.toLowerCase()} pour l&apos;instant.</p>
            ) : (
              shownContractorCards.map((card) => <ContractorProjectCard key={card.project.id} card={card} />)
            )}
          </div>
        ) : null}

        {siteManagerCards.length > 0 ? (
          <div className="flex flex-col gap-3" data-testid="bloc-chef">
            <h3 className="text-label font-semibold text-ink">En tant que chef de chantier ({siteManagerCards.length})</h3>
            <p className="text-caption text-muted">Saisies du jour, incidents et vos dépenses.</p>
            {siteManagerCards.map((card) => (
              <SiteManagerProjectCard key={card.project.id} card={card} />
            ))}
          </div>
        ) : null}
      </section>

      {/* Espace entreprise séparé (maquettes fondateur 2026-10-03) :
          affiché seulement si une adhésion CONTRACTOR active existe
          (donnée déjà lue ci-dessus, aucune requête supplémentaire) —
          jamais pour un visiteur sans aucun chantier en tant qu'entreprise. */}
      {(memberships ?? []).some((m) => m.role === "CONTRACTOR") ? (
        <Link href="/entreprise" className="text-label font-semibold text-primary">
          Ouvrir l&apos;espace entreprise
        </Link>
      ) : null}

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

      {isPlatformAdmin === true ? (
        <Link href="/admin/licences" className="text-label font-semibold text-primary" data-testid="lien-admin-licences">
          Administration : licences à vérifier
        </Link>
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
