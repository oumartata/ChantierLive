import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/AppShell";

// Coquille applicative (navigation, session) — appliquée à toutes les routes
// de ce groupe, jamais à /offline (racine, voir src/app/layout.tsx). Un
// layout imbriqué ne redéclare pas <html>/<body> (déjà posés par la racine).
export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
