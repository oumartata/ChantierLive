"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

export interface NavLinkProps {
  href: string;
  label: string;
}

// Lien de navigation avec état actif (UI_KIT_SPEC.yaml navigation.active_state :
// "fond marine pâle + libellé semibold"). Isolé du AppShell (composant serveur)
// car usePathname exige un composant client.
export function NavLink({ href, label }: NavLinkProps) {
  const pathname = usePathname();
  const isActive = pathname === href;

  return (
    <Link
      href={href}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "flex h-12 min-w-touch flex-1 items-center justify-center rounded-small px-2 text-label",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
        "md:flex-none md:justify-start md:px-4",
        isActive
          ? "bg-sand font-semibold text-primary"
          : "font-medium text-ink md:hover:bg-sand md:hover:text-primary"
      )}
    >
      {label}
    </Link>
  );
}
