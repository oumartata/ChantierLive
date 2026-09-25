"use client";

import { useActionState } from "react";
import { Button, AlertBanner } from "@/components/ui";
import { publishCatalogItemVersionAction, type CatalogueActionState } from "./actions";

export function PublishVersionButton({ organizationId, versionId }: { organizationId: string; versionId: string }) {
  const [state, formAction, pending] = useActionState<CatalogueActionState, FormData>(publishCatalogItemVersionAction, null);

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="organization_id" value={organizationId} />
      <input type="hidden" name="version_id" value={versionId} />
      {state?.error ? <AlertBanner variant="error" title="Publication impossible" explanation={state.error} /> : null}
      <Button type="submit" size="compact" loading={pending}>
        Publier cette version au catalogue
      </Button>
    </form>
  );
}
