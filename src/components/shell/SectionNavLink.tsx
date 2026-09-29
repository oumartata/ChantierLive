import Link from "next/link";
import { cn } from "@/lib/cn";

// Raccourci vers une ANCRE d'une page déjà présente dans la navigation
// (jamais une route distincte, jamais une page dupliquée) — ici "Mes
// chantiers" (#mes-chantiers sur /tableau-de-bord). Volontairement SANS état
// actif propre : NavLink (préservé tel quel) ne compare que le chemin, pas
// l'ancre — lui donner un état actif indépendant ferait apparaître DEUX
// éléments "actifs" en même temps sur la même page (celui-ci et "Tableau de
// bord"), l'ambiguïté precisément à éviter. Un seul élément de la navigation
// porte l'état actif pour une route donnée ; celui-ci reste un simple
// raccourci, visuellement distinct (jamais en pastille pleine), jamais en
// conflit avec lui.
export function SectionNavLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className={cn(
        "flex h-12 min-w-touch flex-1 items-center justify-center rounded-small px-2 text-label",
        "font-medium text-ink hover:bg-sand hover:text-primary",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
        "md:flex-none md:justify-start md:px-4"
      )}
    >
      {label}
    </Link>
  );
}
