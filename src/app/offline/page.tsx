import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Hors ligne — ChantierLive",
};

// Page de secours minimale servie par le service worker quand une navigation
// échoue faute de réseau. Aucune donnée, aucune fonctionnalité métier.
export default function OfflinePage() {
  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col items-center justify-center gap-3 px-4 py-8 text-center">
      <p className="text-h2 font-semibold text-ink">Vous êtes hors ligne</p>
      <p className="text-body text-muted">
        Cette page nécessite une connexion. Réessayez lorsque le réseau sera de retour.
      </p>
    </div>
  );
}
