"use client";

import { useActionState, useState } from "react";
import { Button, TextField, AlertBanner } from "@/components/ui";
import {
  cancelRoleTransferAction,
  confirmRoleTransferAction,
  refuseRoleTransferAction,
  type EquipeActionState,
} from "./actions";
import { useRefreshOnSuccess } from "./useRefreshOnSuccess";

// B018 : actions sur une demande OWNER PENDING (role_transfers, M006b).
// isPending vient de list_role_transfers (calculé, jamais le seul statut
// stocké) : une demande expirée ou invalidée n'affiche plus aucune action,
// même si son statut brut est encore "PENDING" en base (fermeture différée,
// voir migration M006b).
export function RoleTransferRequestCard({
  projectId,
  transferId,
  role,
  isInitiator,
  isSuccessor,
  isPending,
}: {
  projectId: string;
  transferId: string;
  role: string;
  isInitiator: boolean;
  isSuccessor: boolean;
  isPending: boolean;
}) {
  const [action, setAction] = useState<"confirm" | "refuse" | "cancel" | null>(null);
  const [confirmState, confirmFormAction, confirmPending] = useActionState<EquipeActionState, FormData>(
    confirmRoleTransferAction,
    null
  );
  const [refuseState, refuseFormAction, refusePending] = useActionState<EquipeActionState, FormData>(
    refuseRoleTransferAction,
    null
  );
  const [cancelState, cancelFormAction, cancelPending] = useActionState<EquipeActionState, FormData>(
    cancelRoleTransferAction,
    null
  );
  useRefreshOnSuccess(confirmPending, !!confirmState?.error);
  useRefreshOnSuccess(refusePending, !!refuseState?.error);
  useRefreshOnSuccess(cancelPending, !!cancelState?.error);

  if (!isPending) {
    return null;
  }

  const roleLabel = role === "OWNER" ? "propriétaire principal" : "entrepreneur principal";

  return (
    <div className="flex flex-col gap-2">
      {confirmState?.error ? (
        <AlertBanner variant="error" title="Confirmation impossible" explanation={confirmState.error} />
      ) : null}
      {refuseState?.error ? (
        <AlertBanner variant="error" title="Refus impossible" explanation={refuseState.error} />
      ) : null}
      {cancelState?.error ? (
        <AlertBanner variant="error" title="Annulation impossible" explanation={cancelState.error} />
      ) : null}

      {action === null ? (
        <div className="flex flex-wrap gap-2">
          {isSuccessor ? (
            <>
              <Button type="button" variant="primary" size="compact" onClick={() => setAction("confirm")}>
                Confirmer le transfert de {roleLabel}
              </Button>
              <Button type="button" variant="ghost" size="compact" onClick={() => setAction("refuse")}>
                Refuser
              </Button>
            </>
          ) : null}
          {isInitiator ? (
            <Button type="button" variant="ghost" size="compact" onClick={() => setAction("cancel")}>
              Annuler la demande
            </Button>
          ) : null}
        </div>
      ) : null}

      {action === "confirm" ? (
        <form action={confirmFormAction} className="flex flex-col gap-2">
          <input type="hidden" name="project_id" value={projectId} />
          <input type="hidden" name="transfer_id" value={transferId} />
          <TextField label="Motif de la confirmation" name="reason" required />
          <div className="flex gap-2">
            <Button type="submit" variant="primary" size="compact" loading={confirmPending}>
              Confirmer définitivement le transfert
            </Button>
            <Button type="button" variant="ghost" size="compact" onClick={() => setAction(null)}>
              Retour
            </Button>
          </div>
        </form>
      ) : null}

      {action === "refuse" ? (
        <form action={refuseFormAction} className="flex flex-col gap-2">
          <input type="hidden" name="project_id" value={projectId} />
          <input type="hidden" name="transfer_id" value={transferId} />
          <TextField label="Motif du refus" name="reason" required />
          <div className="flex gap-2">
            <Button type="submit" variant="danger" size="compact" loading={refusePending}>
              Confirmer le refus
            </Button>
            <Button type="button" variant="ghost" size="compact" onClick={() => setAction(null)}>
              Retour
            </Button>
          </div>
        </form>
      ) : null}

      {action === "cancel" ? (
        <form action={cancelFormAction} className="flex flex-col gap-2">
          <input type="hidden" name="project_id" value={projectId} />
          <input type="hidden" name="transfer_id" value={transferId} />
          <TextField label="Motif de l'annulation" name="reason" required />
          <div className="flex gap-2">
            <Button type="submit" variant="danger" size="compact" loading={cancelPending}>
              Confirmer l&apos;annulation
            </Button>
            <Button type="button" variant="ghost" size="compact" onClick={() => setAction(null)}>
              Retour
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
