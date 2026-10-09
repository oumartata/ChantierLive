"use client";

import { useActionState, useRef, useState, type ReactNode } from "react";
import { AlertBanner, Button } from "@/components/ui";
import { signOut, type AuthActionState } from "@/app/(app)/(auth)/actions";
import { indexedDbBackend } from "@/lib/offline/idb";
import { currentAccountDb, eraseCurrentAccount, exportDrafts, logoutCheck } from "@/lib/offline/account";

// L06 (O6 ; D202) — déconnexion : la base locale du compte est effacée ; si
// des brouillons hors ligne ne sont pas envoyés, la personne choisit
// explicitement (exporter puis effacer, effacer, ou annuler) : jamais de file
// laissée sans avertissement. Réutilise signOut (scope « local »).

export function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function OfflineLogoutForm({ className, children }: { className?: string; children: (pending: boolean) => ReactNode }) {
  const [state, formAction, pending] = useActionState<AuthActionState, FormData>(signOut, null);
  const formRef = useRef<HTMLFormElement>(null);
  const approved = useRef(false);
  const [waiting, setWaiting] = useState<number | null>(null);

  const proceed = async (exportFirst: boolean) => {
    if (exportFirst) {
      const db = await currentAccountDb(indexedDbBackend);
      if (db) downloadText(`brouillons-hors-ligne-${new Date().toISOString().slice(0, 10)}.json`, await exportDrafts(db));
    }
    await eraseCurrentAccount(indexedDbBackend);
    setWaiting(null);
    approved.current = true;
    formRef.current?.requestSubmit();
  };

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    if (approved.current || typeof indexedDB === "undefined") return;
    e.preventDefault();
    try {
      const { pending: n } = await logoutCheck(indexedDbBackend);
      if (n === 0) await proceed(false);
      else setWaiting(n);
    } catch {
      approved.current = true;
      formRef.current?.requestSubmit();
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {state?.error ? <AlertBanner variant="error" title="Déconnexion impossible" explanation={state.error} /> : null}
      <form ref={formRef} action={formAction} onSubmit={onSubmit} className={className}>
        {children(pending)}
      </form>
      {waiting !== null ? (
        <div role="alertdialog" aria-label="Brouillons hors ligne non envoyés" className="flex flex-col gap-2 rounded-small border border-attention/50 bg-attention/10 p-3" data-testid="deconnexion-brouillons">
          <p className="text-label font-semibold text-ink">
            {waiting} brouillon(s) hors ligne non envoyé(s) sur cet appareil.
          </p>
          <p className="text-caption text-muted">
            À la déconnexion, ils sont effacés de cet appareil. Ils ne sont pas encore sur le serveur : exportez-les pour les garder.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="compact" onClick={() => proceed(true)} data-testid="exporter-effacer">
              Exporter puis me déconnecter
            </Button>
            <Button type="button" size="compact" variant="danger" onClick={() => proceed(false)} data-testid="effacer-deconnecter">
              Effacer et me déconnecter
            </Button>
            <Button type="button" size="compact" variant="ghost" onClick={() => setWaiting(null)}>
              Annuler
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
