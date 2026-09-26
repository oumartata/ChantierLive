"use client";

import { useActionState } from "react";
import { Button, AlertBanner } from "@/components/ui";
import { attachCatalogPlanAction, type PlanActionState } from "./actions";

export function AttachCatalogForm({
  projectId,
  items,
}: {
  projectId: string;
  items: { id: string; label: string }[];
}) {
  const [state, formAction, pending] = useActionState<PlanActionState, FormData>(attachCatalogPlanAction, null);

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="project_id" value={projectId} />
      {state?.error ? <AlertBanner variant="error" title="Rattachement impossible" explanation={state.error} /> : null}
      <label className="flex flex-col gap-1 text-caption text-ink">
        Modèle publié
        <select name="catalog_item_id" required className="rounded-md border border-sand p-2 text-body text-ink">
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <Button type="submit" size="compact" variant="secondary" loading={pending}>
        Rattacher ce modèle au chantier
      </Button>
    </form>
  );
}
