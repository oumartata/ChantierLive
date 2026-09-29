import type { ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import { getVerifiedUser } from "@/lib/supabase/server";
import { NavLink } from "./NavLink";
import { AccountMenuFooter } from "./AccountMenuFooter";

export interface AppShellProps {
  children: ReactNode;
}

// Destinations réellement disponibles dans l'application (aucune route
// fictive) — UI_KIT_SPEC.yaml navigation.mobile limite à cinq maximum.
// Connexion/Inscription ne sont proposées qu'à un visiteur non connecté :
// une session valide n'a jamais besoin de ces deux routes, et les montrer
// quand même prêterait à confusion (aucun intérêt à s'inscrire à nouveau).
function navItems(homeHref: string, authenticated: boolean) {
  // Authentifié : "Accueil" et "Tableau de bord" mèneraient au même endroit
  // — une seule entrée ("Tableau de bord", plus explicite), jamais deux
  // liens différents vers la même href (source du doublon de clé React
  // constaté). Le logo de l'en-tête pointe aussi vers homeHref séparément.
  if (authenticated) {
    return [{ href: homeHref, label: "Tableau de bord" }];
  }
  return [
    { href: homeHref, label: "Accueil" },
    { href: "/connexion", label: "Connexion" },
    { href: "/inscription", label: "Inscription" },
  ];
}

// Coquille technique générique (lot B004) : zone d'en-tête, navigation
// adaptée mobile/ordinateur, contenu principal, zones sûres (env
// safe-area-inset-*). Devenue asynchrone (session lue une fois ici, au
// niveau de la coquille) pour adapter la navigation ET afficher l'identité
// du compte connecté — reste une lecture d'affichage uniquement : chaque
// Server Function sensible revérifie indépendamment (voir
// src/lib/supabase/server.ts), cette lecture-ci ne remplace aucun contrôle.
export async function AppShell({ children }: AppShellProps) {
  const user = await getVerifiedUser();
  const authenticated = Boolean(user);
  // "Accueil" et le logo mènent directement au tableau de bord pour une
  // session valide (évite un aller-retour par "/" qui redirige de toute
  // façon) ; sinon vers "/", qui redirige lui-même vers la connexion.
  const homeHref = authenticated ? "/tableau-de-bord" : "/";
  const items = navItems(homeHref, authenticated);
  const identity = user?.email ?? user?.phone ?? null;

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header
        className="sticky top-0 z-20 flex h-14 shrink-0 items-center border-b border-muted/20 bg-surface px-4"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <Link href={homeHref} className="text-label font-semibold text-primary">
          ChantierLive
        </Link>
      </header>

      <div className="flex flex-1 md:flex-row">
        {/* Mobile : barre basse fixe. Ordinateur : colonne latérale 240px
            (RESPONSIVE_RULES.yaml desktop.navigation: side_240_collapsible_72
            — le repli n'est pas requis pour ce socle technique). */}
        <nav
          aria-label="Navigation principale"
          className={cn(
            "fixed inset-x-0 bottom-0 z-20 flex h-14 items-stretch justify-around gap-1 px-1",
            "border-t border-muted/20 bg-surface",
            "md:static md:h-auto md:w-60 md:flex-col md:items-stretch md:justify-start md:gap-1",
            "md:border-t-0 md:border-r md:p-4"
          )}
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        >
          {items.map((item) => (
            <NavLink key={item.href} href={item.href} label={item.label} />
          ))}
          {/* Identité du compte + déconnexion : toujours en dernière
              position de la navigation (bas de la colonne sur ordinateur,
              fin de la barre sur mobile), jamais mélangée aux destinations
              ci-dessus. Masquée pour un visiteur non connecté. */}
          {authenticated ? (
            <div className="hidden md:mt-auto md:flex md:flex-col md:gap-1">
              <AccountMenuFooter identity={identity} />
            </div>
          ) : null}
        </nav>

        <main className="min-w-0 flex-1 pb-14 md:pb-0">{children}</main>
      </div>
    </div>
  );
}
