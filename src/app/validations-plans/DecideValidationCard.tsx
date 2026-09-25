"use client";

import { useActionState, useState, useTransition } from "react";
import { Button, AlertBanner, TextField } from "@/components/ui";
import { decideValidationAction, getValidationFileUrlAction, type ValidationsActionState } from "./actions";

export function DecideValidationCard({ validationId, versionNumber }: { validationId: string; versionNumber: number }) {
  const [state, formAction, pending] = useActionState<ValidationsActionState, FormData>(decideValidationAction, null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [filePending, startFileTransition] = useTransition();

  function handleOpenFile() {
    setFileError(null);
    // CORRIGÉ (vérification navigateur réelle) : window.open appelé APRÈS un
    // await (dans startTransition) n'est plus rattaché au geste utilisateur
    // du clic — les navigateurs le bloquent silencieusement comme pop-up,
    // constaté empiriquement (l'action serveur réussissait, l'onglet ne
    // s'ouvrait jamais). Un onglet vide est ouvert SYNCHRONEMENT dans le
    // gestionnaire de clic ; son emplacement est fixé une fois l'URL signée
    // obtenue — même onglet, jamais bloqué.
    const pendingTab = window.open("", "_blank", "noopener,noreferrer");
    startFileTransition(async () => {
      const result = await getValidationFileUrlAction(validationId);
      if (!result.ok) {
        setFileError(result.message);
        pendingTab?.close();
        return;
      }
      if (pendingTab) {
        pendingTab.location.href = result.url;
      } else {
        // Fenêtre déjà bloquée par ailleurs (ex. réglage navigateur strict) :
        // repli explicite, jamais un échec silencieux.
        setFileError("Autorisez les fenêtres pop-up pour ouvrir le fichier, ou copiez ce lien : " + result.url);
      }
    });
  }

  return (
    <li className="flex flex-col gap-3 border-b border-sand pb-4 last:border-b-0 last:pb-0">
      <span className="text-label font-semibold text-ink">Version {versionNumber}</span>
      {fileError ? <AlertBanner variant="error" title="Fichier indisponible" explanation={fileError} /> : null}
      <Button type="button" variant="secondary" size="compact" loading={filePending} onClick={handleOpenFile}>
        Ouvrir le fichier
      </Button>
      <form action={formAction} className="flex flex-col gap-2">
        <input type="hidden" name="validation_id" value={validationId} />
        {state?.error ? <AlertBanner variant="error" title="Décision impossible" explanation={state.error} /> : null}
        <TextField label="Note (optionnelle)" name="note" />
        <div className="flex gap-2">
          <Button type="submit" name="decision" value="VALIDATED" size="compact" loading={pending}>
            Valider
          </Button>
          <Button type="submit" name="decision" value="REJECTED" variant="danger" size="compact" loading={pending}>
            Rejeter
          </Button>
        </div>
      </form>
    </li>
  );
}
