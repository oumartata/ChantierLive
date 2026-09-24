"use client";

import { useActionState, useState } from "react";
import { Button, TextField, AlertBanner } from "@/components/ui";
import { transferContractorRoleAction, type EquipeActionState } from "./actions";
import { useRefreshOnSuccess } from "./useRefreshOnSuccess";

// B018 : transfert CONTRACTOR immédiat (transfer_contractor_role, M006b) —
// sans période de double contrôle (AC039), une seule confirmation suffit.
export function TransferContractorRoleButton({
  projectId,
  successorMembershipId,
}: {
  projectId: string;
  successorMembershipId: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState<EquipeActionState, FormData>(
    transferContractorRoleAction,
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
        <AlertBanner variant="error" title="Transfert impossible" explanation={state.error} />
      ) : null}
      <TextField label="Motif du transfert" name="reason" required />
      <div className="flex gap-2">
        <Button type="submit" variant="danger" size="compact" loading={pending}>
          Confirmer définitivement le transfert
        </Button>
        <Button type="button" variant="ghost" size="compact" onClick={() => setConfirming(false)}>
          Annuler
        </Button>
      </div>
    </form>
  );
}
