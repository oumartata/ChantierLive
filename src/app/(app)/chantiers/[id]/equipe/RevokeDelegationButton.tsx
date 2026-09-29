"use client";

import { useActionState } from "react";
import { Button, AlertBanner } from "@/components/ui";
import { revokeDelegationAction, type EquipeActionState } from "./actions";

// B017 : révocation par le rôle habilitant COURANT (revoke_delegation,
// M004c) — jamais restreinte à granted_by, revalidé côté RPC.
export function RevokeDelegationButton({
  projectId,
  delegationId,
}: {
  projectId: string;
  delegationId: string;
}) {
  const [state, formAction, pending] = useActionState<EquipeActionState, FormData>(
    revokeDelegationAction,
    null
  );

  return (
    <form action={formAction} className="flex flex-col gap-1">
      <input type="hidden" name="project_id" value={projectId} />
      <input type="hidden" name="delegation_id" value={delegationId} />
      {state?.error ? (
        <AlertBanner variant="error" title="Révocation impossible" explanation={state.error} />
      ) : null}
      <Button type="submit" variant="danger" size="compact" loading={pending}>
        Révoquer
      </Button>
    </form>
  );
}
