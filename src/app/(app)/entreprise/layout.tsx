import type { ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";

// Espace entreprise — séparation de navigation (maquettes fondateur
// 2026-10-03, PREPARATION_ESPACES_PROPRIETAIRE_ENTREPRISE.md §3.2/§4 Lot
// ESPACES-3). Contrairement à chantiers/[id]/layout.tsx (nav scopée à UN
// chantier via l'URL), cet espace regroupe les chantiers où le profil
// courant a une adhésion CONTRACTOR active ; la sélection du chantier se
// fait DANS le contenu de chaque page (jamais déduite ici). Chaque page
// revérifie elle-même, côté serveur, qui peut la voir (RLS/RPC déjà
// existants, réutilisés tels quels) — ce menu est un simple raccourci,
// jamais un contrôle d'accès (règle fondateur explicite).
const LINKS = [
  { href: "/entreprise", label: "Tableau de bord" },
  { href: "/entreprise/versements", label: "Versements clients" },
  { href: "/entreprise/depenses", label: "Dépenses internes" },
  { href: "/entreprise/photos", label: "Photos et vidéos" },
  { href: "/entreprise/catalogue", label: "Catalogue de plans" },
  { href: "/entreprise/equipe", label: "Équipe" },
];

export default function EntrepriseLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col">
      <div className="border-b border-muted/20 bg-surface px-4 py-3">
        <div className="mx-auto flex max-w-3xl flex-col gap-1">
          <Link href="/tableau-de-bord" className="text-caption font-semibold text-muted hover:text-primary">
            &larr; Mes chantiers
          </Link>
          <div className="flex flex-wrap items-baseline gap-2">
            <p className="text-label font-bold text-ink">Espace entreprise</p>
          </div>
        </div>
        <nav
          aria-label="Navigation entreprise"
          className="mx-auto flex max-w-3xl gap-1 overflow-x-auto pt-2"
        >
          {LINKS.map((link) => (
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
