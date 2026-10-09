"use client";

import { useActionState, useEffect, useState } from "react";
import { AlertBanner, Button } from "@/components/ui";
import { signOut, type AuthActionState } from "@/app/(app)/(auth)/actions";
import { getOfflineReference } from "@/app/(app)/offline-actions";
import { indexedDbBackend, storageStatus } from "@/lib/offline/idb";
import { applyReferenceForSession, confirmEraseOthers, openForAccount, type Notice } from "@/lib/offline/account";

// L06 (B036 ; O1, O9, O12 P1 ; D202) — ouverture de la base locale du compte
// connecté sur cet appareil :
// - autre compte avec des brouillons non envoyés : avertissement bloquant,
//   « Effacer et continuer » ou « Annuler » (qui déconnecte sans rien
//   toucher) ;
// - retour d'un compte dont les brouillons ont été effacés : avis (nombre,
//   date) ;
// - en ligne : référence minimale rafraîchie ; chantier retiré → données
//   effacées, brouillons propres refusés (accès retiré).
// L'identifiant du compte n'est jamais écrit sur l'appareil (clé hachée).

const day = (ts: string) => new Date(ts).toLocaleString("fr-FR", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });

export function OfflineSession({ profileId }: { profileId: string }) {
  const [confirm, setConfirm] = useState<number | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [removed, setRemoved] = useState(0);

  const refresh = async () => {
    if (!navigator.onLine) return;
    const res = await getOfflineReference();
    if (res.ok && res.profileId === profileId) {
      const out = await applyReferenceForSession(indexedDbBackend, profileId, res.reference);
      if (out.removedProjects.length > 0) setRemoved(out.removedProjects.length);
    }
  };

  const ready = async (result: Awaited<ReturnType<typeof openForAccount>>) => {
    if (result.kind === "confirm") {
      setConfirm(result.pendingTotal);
      return;
    }
    setConfirm(null);
    if (result.notice) setNotice(result.notice);
    await storageStatus();
    await refresh();
  };

  useEffect(() => {
    if (typeof indexedDB === "undefined") return;
    let alive = true;
    openForAccount(indexedDbBackend, profileId).then(
      (r) => {
        if (alive) void ready(r);
      },
      () => undefined,
    );
    const onOnline = () => void refresh();
    window.addEventListener("online", onOnline);
    return () => {
      alive = false;
      window.removeEventListener("online", onOnline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId]);

  if (confirm !== null) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4" role="alertdialog" aria-modal="true" aria-label="Brouillons d'un autre compte" data-testid="o12-avertissement">
        <div className="flex w-full max-w-md flex-col gap-3 rounded-medium bg-surface p-5">
          <p className="text-h2 font-semibold text-ink">Brouillons d&apos;un autre compte</p>
          <p className="text-body text-ink">
            {confirm} brouillon(s) non envoyé(s) d&apos;un autre compte, illisibles pour vous, seront effacés de cet appareil.
          </p>
          <p className="text-caption text-muted">
            Pour les conserver, annulez : la personne concernée pourra se reconnecter sur cet appareil et les exporter.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="danger" data-testid="o12-effacer" onClick={async () => ready(await confirmEraseOthers(indexedDbBackend, profileId))}>
              Effacer et continuer
            </Button>
            <CancelSignOut />
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      {notice ? (
        <div className="px-4 pt-3" data-testid="o12-avis">
          <AlertBanner
            variant="warning"
            title="Brouillons effacés de cet appareil"
            explanation={`${notice.erasedCount} brouillon(s) hors ligne non envoyé(s) de votre compte ont été effacés le ${day(notice.erasedAt)}, lors de la connexion d'un autre compte sur cet appareil.`}
          />
        </div>
      ) : null}
      {removed > 0 ? (
        <div className="px-4 pt-3" data-testid="acces-retire">
          <AlertBanner
            variant="information"
            title="Accès retiré"
            explanation={`Votre accès à ${removed} chantier(s) a été retiré : ses données ont été effacées de cet appareil. Vos brouillons hors ligne pour ce chantier restent visibles dans « Hors ligne », refusés, jamais envoyés, jusqu'à ce que vous les retiriez.`}
          />
        </div>
      ) : null}
    </>
  );
}

// « Annuler » : déconnecte le nouveau compte sans rien toucher sur l'appareil.
function CancelSignOut() {
  const [, formAction, pending] = useActionState<AuthActionState, FormData>(signOut, null);
  return (
    <form action={formAction}>
      <Button type="submit" variant="secondary" loading={pending} data-testid="o12-annuler">
        Annuler
      </Button>
    </form>
  );
}
