import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { AppShell } from "@/components/shell/AppShell";
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

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="fr" className={`${inter.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <ServiceWorkerRegistration />
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
