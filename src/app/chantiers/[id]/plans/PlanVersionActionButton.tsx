"use client";

import { useActionState } from "react";
import { Button, AlertBanner } from "@/components/ui";
import {
  grantSiteManagerShareAction,
  publishPlanAction,
  revokeSiteManagerShareAction,
  setRetainedPlanAction,
  shareProjectPlanAction,
  submitPlanForValidationAction,
  type PlanActionState,
} from "./actions";

const ACTIONS = {
  share: { action: shareProjectPlanAction, label: "Partager avec le propriétaire", errorTitle: "Partage impossible" },
  retain: { action: setRetainedPlanAction, label: "Retenir ce plan", errorTitle: "Désignation impossible" },
  submit: { action: submitPlanForValidationAction, label: "Soumettre à l'ingénieur", errorTitle: "Soumission impossible" },
  publish: { action: publishPlanAction, label: "Publier au chantier", errorTitle: "Publication impossible" },
  grantSiteManager: { action: grantSiteManagerShareAction, label: "Donner accès au plan publié", errorTitle: "Octroi impossible" },
  revokeSiteManager: { action: revokeSiteManagerShareAction, label: "Retirer l'accès", errorTitle: "Retrait impossible" },
} as const;

export function PlanVersionActionButton({
  kind,
  projectId,
  versionId,
  expectedRevision,
  hidden,
  select,
}: {
  kind: keyof typeof ACTIONS;
  projectId: string;
  versionId?: string;
  expectedRevision?: number;
  hidden?: Record<string, string>;
  select?: { name: string; label: string; options: { value: string; label: string }[] };
}) {
  const { action, label, errorTitle } = ACTIONS[kind];
  const [state, formAction, pending] = useActionState<PlanActionState, FormData>(action, null);

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="project_id" value={projectId} />
      {versionId ? <input type="hidden" name="version_id" value={versionId} /> : null}
      {expectedRevision !== undefined ? <input type="hidden" name="expected_revision" value={expectedRevision} /> : null}
      {Object.entries(hidden ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {state?.error ? <AlertBanner variant="error" title={errorTitle} explanation={state.error} /> : null}
      {select ? (
        <label className="flex flex-col gap-1 text-caption text-ink">
          {select.label}
          <select name={select.name} required className="rounded-md border border-sand p-2 text-body text-ink">
            {select.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <Button type="submit" size="compact" variant="secondary" loading={pending}>
        {label}
      </Button>
    </form>
  );
}
