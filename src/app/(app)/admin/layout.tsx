import type { ReactNode } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cn } from "@/lib/cn";
import { createClient, getVerifiedUser } from "@/lib/supabase/server";

// B050 (D195 E8, D026) — section d'administration de la plateforme avec son
// propre menu, jamais le menu des chantiers. Réservée à l'administrateur :
// tout autre compte obtient une page introuvable. Ce contrôle d'affichage ne
// remplace aucun contrôle : chaque fonction d'administration revérifie en
// base (require_platform_admin, M049, M050).
const LINKS = [
  { href: "/admin", label: "Tableau de bord" },
  { href: "/admin/licences", label: "Licences" },
  { href: "/admin/chantiers", label: "Chantiers" },
  { href: "/admin/comptes", label: "Comptes" },
  { href: "/admin/support", label: "Support" },
  { href: "/admin/journal", label: "Journal" },
];

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await getVerifiedUser();
  if (!user) redirect("/connexion");
  const supabase = await createClient();
  const { data: isAdmin } = await supabase.rpc("is_platform_admin");
  if (isAdmin !== true) notFound();

  return (
    <div className="flex flex-col">
      <div className="border-b border-muted/20 bg-surface px-4 py-3">
        <div className="mx-auto flex max-w-3xl flex-col gap-1">
          <p className="text-label font-bold text-ink">Administration de la plateforme</p>
          <nav aria-label="Navigation de l'administration" className="flex gap-1 overflow-x-auto pt-2">
            {LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={cn("shrink-0 rounded-small px-3 py-1.5 text-caption font-semibold text-ink", "hover:bg-sand hover:text-primary")}
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
      </div>
      {children}
    </div>
  );
}
