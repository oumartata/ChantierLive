"use client";

import { useActionState } from "react";
import { Button, TextField, AlertBanner } from "@/components/ui";
import { createCatalogItemAction, type CatalogueActionState } from "./actions";

export function CreateItemForm({ organizationId }: { organizationId: string }) {
  const [state, formAction, pending] = useActionState<CatalogueActionState, FormData>(createCatalogItemAction, null);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="organization_id" value={organizationId} />
      <h2 className="text-h2 font-semibold text-ink">Nouveau modèle</h2>
      {state?.error ? <AlertBanner variant="error" title="Création impossible" explanation={state.error} /> : null}
      <TextField label="Nom du modèle" name="label" required placeholder="ex. T3 standard" />
      <Button type="submit" loading={pending}>
        Créer
      </Button>
    </form>
  );
}
