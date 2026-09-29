import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { ServiceWorkerRegistration } from "@/components/shell/ServiceWorkerRegistration";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ChantierLive",
  description: "Socle technique installable (PWA)",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Nécessaire pour que env(safe-area-inset-*) résolve à une vraie valeur
  // sur les appareils à encoche (voir AppShell).
  viewportFit: "cover",
  themeColor: "#0b3b5c",
};

// Racine VOLONTAIREMENT minimale : ne lit plus jamais la session (AppShell,
// qui appelle getVerifiedUser()/cookies(), vit désormais dans
// src/app/(app)/layout.tsx). /offline reste hors du groupe (app) précisément
// pour ne dépendre d'aucune lecture réseau/session — un appareil réellement
// hors ligne doit pouvoir l'afficher sans qu'un appel à Supabase Auth
// n'échoue ou ne bloque le rendu. Toute route ajoutée sous (app) hérite de
// la coquille ; toute route ajoutée ici, à la racine, en est dépourvue —
// à choisir consciemment, pas par défaut.
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="fr" className={`${inter.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <ServiceWorkerRegistration />
        {children}
      </body>
    </html>
  );
}
