import type { ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";

export interface AppShellProps {
  children: ReactNode;
}

// Coquille technique générique (lot B004) : zone d'en-tête, navigation
// adaptée mobile/ordinateur, contenu principal, zones sûres (env
// safe-area-inset-*). Aucun contenu métier — la navigation réelle par rôle
// (RESPONSIVE_RULES.yaml shells.authenticated) arrive avec les écrans
// authentifiés, hors périmètre de ce lot.
export function AppShell({ children }: AppShellProps) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header
        className="sticky top-0 z-20 flex h-14 shrink-0 items-center border-b border-muted/20 bg-surface px-4"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <p className="text-label font-semibold text-ink">ChantierLive</p>
      </header>

      <div className="flex flex-1 md:flex-row">
        {/* Mobile : barre basse fixe. Ordinateur : colonne latérale 240px
            (RESPONSIVE_RULES.yaml desktop.navigation: side_240_collapsible_72
            — le repli n'est pas requis pour ce socle technique). */}
        <nav
          aria-label="Navigation principale"
          className={cn(
            "fixed inset-x-0 bottom-0 z-20 flex h-14 items-center justify-center",
            "border-t border-muted/20 bg-surface",
            "md:static md:h-auto md:w-60 md:flex-col md:items-stretch md:justify-start",
            "md:border-t-0 md:border-r md:p-4"
          )}
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        >
          <Link
            href="/"
            className="flex h-12 min-w-touch items-center justify-center px-4 text-label font-semibold text-primary md:justify-start md:rounded-small md:hover:bg-sand"
          >
            Accueil technique
          </Link>
        </nav>

        <main className="min-w-0 flex-1 pb-14 md:pb-0">{children}</main>
      </div>
    </div>
  );
}
