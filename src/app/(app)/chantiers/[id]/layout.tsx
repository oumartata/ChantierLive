import type { ReactNode } from "react";
import Link from "next/link";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/cn";

// Navigation PERSISTANTE du chantier — corrige le constat fondateur : les
// destinations autorisées vivaient dans une simple liste de liens au milieu
// du formulaire "Informations du chantier" (modifier/page.tsx), invisible
// dès qu'on naviguait vers une sous-page (devis, plans, ...). Elles sont
// désormais dans ce layout, partagé par TOUTES les sous-pages du chantier,
// donc toujours visible — nom du chantier et rôle actif inclus.
//
// Visibilité dérivée EXACTEMENT des mêmes gardes serveur déjà vérifiés
// (aucune permission inventée, voir modifier/page.tsx pour les sources
// citées : invitation_required_emitter M006, quote_version_readable/
// get_quote_state M021, change_order_version_readable M022,
// advance_require_reader M014 réutilisé par get_project_financial_summary
// M028). Équipe/Photos/Plans restent visibles pour tous : aucune de leurs
// lectures ne porte de restriction de rôle, et Plans rend déjà une vue
// réduite fonctionnelle pour SITE_MANAGER.
const SPACE_LABEL: Record<string, string> = {
  OWNER: "Espace propriétaire",
  CONTRACTOR: "Espace entreprise",
  SITE_MANAGER: "Espace chef de chantier",
};

export default async function ChantierLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getVerifiedUser();
  if (!user) {
    // Chaque page revérifie déjà indépendamment (redirect("/connexion")) —
    // ce layout ne fait qu'omettre la navigation contextuelle si, pour une
    // raison quelconque, il était atteint sans session ; jamais un contrôle
    // d'accès supplémentaire ici.
    return <>{children}</>;
  }

  const supabase = await createClient();
  const [{ data: project }, { data: membership }] = await Promise.all([
    supabase.from("projects").select("name").eq("id", id).maybeSingle(),
    supabase
      .from("project_memberships")
      .select("role, owner_profile")
      .eq("project_id", id)
      .eq("profile_id", user.id)
      .is("revoked_at", null)
      .maybeSingle(),
  ]);

  if (!project) {
    // Chantier inaccessible/inexistant : chaque page affiche déjà son propre
    // message ; pas de navigation contextuelle à construire sur du vide.
    return <>{children}</>;
  }

  const role = membership?.role ?? null;
  const ownerProfile = membership?.owner_profile ?? null;
  const spaceLabel = role ? SPACE_LABEL[role] : null;
  const isOwnerPrimary = role === "OWNER" && ownerProfile === "PRIMARY";
  const isCoOwner = role === "OWNER" && ownerProfile === "CO_OWNER";
  const isContractor = role === "CONTRACTOR";
  const canInvite = isContractor || isOwnerPrimary;
  const canSeeFinancials = isContractor || isOwnerPrimary || isCoOwner;

  // Séparation de navigation (maquettes fondateur 2026-10-03,
  // PREPARATION_ESPACES_PROPRIETAIRE_ENTREPRISE.md §4 Lot ESPACES-1) :
  // le propriétaire (OWNER, PRIMARY ou CO_OWNER) obtient un menu propre,
  // centré consultation, distinct de celui de l'entreprise. Équipe/Devis/
  // Avenants/Invitations ne sont pas supprimés — ils restent exactement
  // aussi accessibles qu'avant (mêmes gardes canInvite/canSeeFinancials),
  // seulement déplacés dans le détail du chantier (page.tsx, section
  // « Gestion »). CONTRACTOR et SITE_MANAGER gardent le menu actuel,
  // inchangé (aucune maquette ne demande d'y toucher pour ces rôles ici ;
  // CONTRACTOR obtient son propre espace séparé sous /entreprise).
  const isOwner = role === "OWNER";
  const links: { href: string; label: string }[] = isOwner
    ? [
        { href: `/chantiers/${id}`, label: "Mon chantier" },
        { href: `/chantiers/${id}/acomptes`, label: "Versements" },
        { href: `/chantiers/${id}/avancement`, label: "Avancement" },
        { href: `/chantiers/${id}/photos`, label: "Photos et vidéos" },
        // B022 : le propriétaire lit les journaux publiés (JOURNAL_VIEW,
        // list_published_daily_logs M037), jamais les brouillons.
        { href: `/chantiers/${id}/journal`, label: "Journal" },
        // B024 : incidents lus par tout membre actif (INCIDENT_VIEW, M038).
        { href: `/chantiers/${id}/incidents`, label: "Incidents" },
        // B028 : documents visibles selon leur visibilité (M039).
        { href: `/chantiers/${id}/documents`, label: "Documents" },
        { href: `/chantiers/${id}/catalogue`, label: "Catalogue" },
        { href: `/chantiers/${id}/plans`, label: "Plans" },
      ]
    : [
        { href: `/chantiers/${id}`, label: "Chantier" },
        ...(canInvite
          ? [
              { href: `/chantiers/${id}/invitations/nouveau`, label: "Inviter" },
              { href: `/chantiers/${id}/invitations`, label: "Invitations" },
            ]
          : []),
        { href: `/chantiers/${id}/equipe`, label: "Équipe" },
        // B021/B022 : journal tenu par l'entreprise et le chef de chantier
        // (M036), journaux publiés lus par tout membre actif (M037).
        ...(role ? [{ href: `/chantiers/${id}/journal`, label: "Journal" }] : []),
        ...(role ? [{ href: `/chantiers/${id}/incidents`, label: "Incidents" }] : []),
        ...(role ? [{ href: `/chantiers/${id}/documents`, label: "Documents" }] : []),
        { href: `/chantiers/${id}/photos`, label: "Photos" },
        { href: `/chantiers/${id}/plans`, label: "Plans" },
        ...(canSeeFinancials
          ? [
              { href: `/chantiers/${id}/devis`, label: "Devis" },
              { href: `/chantiers/${id}/avenants`, label: "Avenants" },
              { href: `/chantiers/${id}/acomptes`, label: "Acomptes" },
              { href: `/chantiers/${id}/finances`, label: "Synthèse" },
            ]
          : []),
      ];

  return (
    <div className="flex flex-col">
      <div className="border-b border-muted/20 bg-surface px-4 py-3">
        <div className="mx-auto flex max-w-3xl flex-col gap-1">
          <Link href="/tableau-de-bord" className="text-caption font-semibold text-muted hover:text-primary">
            &larr; Mes chantiers
          </Link>
          <div className="flex flex-wrap items-baseline gap-2">
            <p className="text-label font-bold text-ink">{project.name}</p>
            {spaceLabel ? <span className="text-caption font-semibold text-primary">{spaceLabel}</span> : null}
          </div>
        </div>
        {/* Bande horizontale défilable : reste utilisable sur mobile sans
            toucher à la barre basse globale (déjà à 5 destinations max,
            UI_KIT_SPEC.yaml), et s'affiche en ligne normale sur ordinateur. */}
        <nav
          aria-label="Navigation du chantier"
          className="mx-auto flex max-w-3xl gap-1 overflow-x-auto pt-2"
        >
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={cn(
                "shrink-0 rounded-small px-3 py-1.5 text-caption font-semibold text-ink",
                "hover:bg-sand hover:text-primary"
              )}
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
      {children}
    </div>
  );
}
