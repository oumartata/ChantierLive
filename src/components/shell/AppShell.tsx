import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { NavLink } from "./NavLink";

export interface AppShellProps {
  children: ReactNode;
}

// Destinations réellement disponibles dans l'application (aucune route
// fictive) — UI_KIT_SPEC.yaml navigation.mobile limite à cinq maximum.
const NAV_ITEMS = [
  { href: "/", label: "Accueil" },
  { href: "/connexion", label: "Connexion" },
  { href: "/inscription", label: "Inscription" },
  { href: "/tableau-de-bord", label: "Tableau de bord" },
] as const;

// Coquille technique générique (lot B004, adaptée visuellement lors de
// l'alignement aux maquettes) : zone d'en-tête, navigation adaptée
// mobile/ordinateur, contenu principal, zones sûres (env
// safe-area-inset-*). Navigation limitée aux routes existantes — la
// navigation par rôle (RESPONSIVE_RULES.yaml shells.authenticated) reste un
// sujet distinct, non traité ici.
export function AppShell({ children }: AppShellProps) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header
        className="sticky top-0 z-20 flex h-14 shrink-0 items-center border-b border-muted/20 bg-surface px-4"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <p className="text-label font-semibold text-primary">ChantierLive</p>
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
          {NAV_ITEMS.map((item) => (
            <NavLink key={item.href} href={item.href} label={item.label} />
          ))}
        </nav>

        <main className="min-w-0 flex-1 pb-14 md:pb-0">{children}</main>
      </div>
    </div>
  );
}
