"use client";

import { useActionState, useState } from "react";
import { Button, TextField, AlertBanner } from "@/components/ui";
import { requestRoleTransferAction, type EquipeActionState } from "./actions";
import { useRefreshOnSuccess } from "./useRefreshOnSuccess";

// B018 : demande de transfert OWNER/PRIMARY (request_role_transfer, M006b) —
// aucune bascule ici, seule une confirmation explicite du successeur
// (confirm_role_transfer) exécute le transfert (AC038, double confirmation).
export function RequestRoleTransferButton({
  projectId,
  successorMembershipId,
}: {
  projectId: string;
  successorMembershipId: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState<EquipeActionState, FormData>(
    requestRoleTransferAction,
    null
  );
  useRefreshOnSuccess(pending, !!state?.error);

  if (!confirming) {
    return (
      <Button type="button" variant="secondary" size="compact" onClick={() => setConfirming(true)}>
        Transférer le rôle principal
      </Button>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="project_id" value={projectId} />
      <input type="hidden" name="successor_membership_id" value={successorMembershipId} />
      {state?.error ? (
        <AlertBanner variant="error" title="Demande impossible" explanation={state.error} />
      ) : null}
      <TextField label="Motif du transfert" name="reason" required />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="compact" loading={pending}>
          Envoyer la demande
        </Button>
        <Button type="button" variant="ghost" size="compact" onClick={() => setConfirming(false)}>
          Annuler
        </Button>
      </div>
    </form>
  );
}
