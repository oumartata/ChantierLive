"use client";

import { useActionState } from "react";
import { Button, AlertBanner } from "@/components/ui";
import { revokeInvitation, type RevokeInvitationState } from "./actions";

export function RevokeButton({
  invitationId,
  projectId,
}: {
  invitationId: string;
  projectId: string;
}) {
  const [state, formAction, pending] = useActionState<RevokeInvitationState, FormData>(
    revokeInvitation,
    null
  );

  return (
    <form action={formAction} className="flex flex-col gap-1">
      <input type="hidden" name="invitation_id" value={invitationId} />
      <input type="hidden" name="project_id" value={projectId} />
      {state?.error ? (
        <AlertBanner variant="error" title="Révocation impossible" explanation={state.error} />
      ) : null}
      <Button type="submit" variant="danger" size="compact" loading={pending}>
        Révoquer
      </Button>
    </form>
  );
}
