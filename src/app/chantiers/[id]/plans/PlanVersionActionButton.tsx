"use client";

import { useActionState } from "react";
import { Button, AlertBanner } from "@/components/ui";
import { setRetainedPlanAction, shareProjectPlanAction, type PlanActionState } from "./actions";

const ACTIONS = {
  share: { action: shareProjectPlanAction, label: "Partager avec le propriétaire", errorTitle: "Partage impossible" },
  retain: { action: setRetainedPlanAction, label: "Retenir ce plan", errorTitle: "Désignation impossible" },
} as const;

export function PlanVersionActionButton({
  kind,
  projectId,
  versionId,
  expectedRevision,
}: {
  kind: keyof typeof ACTIONS;
  projectId: string;
  versionId: string;
  expectedRevision?: number;
}) {
  const { action, label, errorTitle } = ACTIONS[kind];
  const [state, formAction, pending] = useActionState<PlanActionState, FormData>(action, null);

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="project_id" value={projectId} />
      <input type="hidden" name="version_id" value={versionId} />
      {expectedRevision !== undefined ? <input type="hidden" name="expected_revision" value={expectedRevision} /> : null}
      {state?.error ? <AlertBanner variant="error" title={errorTitle} explanation={state.error} /> : null}
      <Button type="submit" size="compact" variant="secondary" loading={pending}>
        {label}
      </Button>
    </form>
  );
}
