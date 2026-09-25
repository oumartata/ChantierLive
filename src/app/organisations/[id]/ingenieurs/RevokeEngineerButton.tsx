"use client";

import { useActionState, useState } from "react";
import { Button, AlertBanner } from "@/components/ui";
import { revokeEngineerAction, type IngenieursActionState } from "./actions";

export function RevokeEngineerButton({
  organizationId,
  designationId,
}: {
  organizationId: string;
  designationId: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState<IngenieursActionState, FormData>(
    revokeEngineerAction,
    null
  );

  if (!confirming) {
    return (
      <Button type="button" variant="danger" size="compact" onClick={() => setConfirming(true)}>
        Révoquer
      </Button>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="organization_id" value={organizationId} />
      <input type="hidden" name="designation_id" value={designationId} />
      {state?.error ? (
        <AlertBanner variant="error" title="Révocation impossible" explanation={state.error} />
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" variant="danger" size="compact" loading={pending}>
          Confirmer la révocation
        </Button>
        <Button type="button" variant="ghost" size="compact" onClick={() => setConfirming(false)}>
          Annuler
        </Button>
      </div>
    </form>
  );
}
