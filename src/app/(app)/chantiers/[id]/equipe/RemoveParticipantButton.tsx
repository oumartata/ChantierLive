"use client";

import { useActionState, useState } from "react";
import { Button, TextField, AlertBanner } from "@/components/ui";
import { removeParticipantAction, type EquipeActionState } from "./actions";

// B017 : confirmation + motif obligatoire (FR037) avant tout appel —
// remove_participant (M004c) revalide indépendamment le motif non vide et
// l'habilitation de l'appelant, ce formulaire n'est qu'une première ligne.
export function RemoveParticipantButton({
  projectId,
  membershipId,
}: {
  projectId: string;
  membershipId: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState<EquipeActionState, FormData>(
    removeParticipantAction,
    null
  );

  if (!confirming) {
    return (
      <Button type="button" variant="danger" size="compact" onClick={() => setConfirming(true)}>
        Retirer
      </Button>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="project_id" value={projectId} />
      <input type="hidden" name="membership_id" value={membershipId} />
      {state?.error ? (
        <AlertBanner variant="error" title="Retrait impossible" explanation={state.error} />
      ) : null}
      <TextField label="Motif du retrait" name="reason" required />
      <div className="flex gap-2">
        <Button type="submit" variant="danger" size="compact" loading={pending}>
          Confirmer le retrait
        </Button>
        <Button type="button" variant="ghost" size="compact" onClick={() => setConfirming(false)}>
          Annuler
        </Button>
      </div>
    </form>
  );
}
