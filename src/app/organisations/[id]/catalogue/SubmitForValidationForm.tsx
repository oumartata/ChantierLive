"use client";

import { useActionState } from "react";
import { Button, AlertBanner } from "@/components/ui";
import { submitForValidationAction, type CatalogueActionState } from "./actions";

export function SubmitForValidationForm({
  organizationId,
  versionId,
  engineers,
}: {
  organizationId: string;
  versionId: string;
  engineers: { id: string; label: string }[];
}) {
  const [state, formAction, pending] = useActionState<CatalogueActionState, FormData>(submitForValidationAction, null);

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="organization_id" value={organizationId} />
      <input type="hidden" name="version_id" value={versionId} />
      {state?.error ? <AlertBanner variant="error" title="Soumission impossible" explanation={state.error} /> : null}
      <label className="flex flex-col gap-1 text-caption text-ink">
        Soumettre à
        <select name="designation_id" required className="rounded-md border border-sand p-2 text-body text-ink">
          {engineers.map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
        </select>
      </label>
      <Button type="submit" size="compact" variant="secondary" loading={pending}>
        Soumettre pour validation
      </Button>
    </form>
  );
}
