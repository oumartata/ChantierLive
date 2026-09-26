"use client";

import { useActionState } from "react";
import { Button, AlertBanner, TextField } from "@/components/ui";
import { decideQuoteAction, proposeQuoteAction, type QuoteActionState } from "./actions";

export function ProposeQuoteButton({ projectId, versionId, expectedRevision }: { projectId: string; versionId: string; expectedRevision: number }) {
  const [state, formAction, pending] = useActionState<QuoteActionState, FormData>(proposeQuoteAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="project_id" value={projectId} />
      <input type="hidden" name="version_id" value={versionId} />
      <input type="hidden" name="expected_revision" value={expectedRevision} />
      {state?.error ? <AlertBanner variant="error" title="Proposition impossible" explanation={state.error} /> : null}
      <Button type="submit" size="compact" loading={pending}>
        Proposer au client
      </Button>
    </form>
  );
}

// Décision du client (D112 : OWNER/PRIMARY seul, revérifié côté serveur).
export function DecideQuoteForm({ projectId, versionId, expectedRevision }: { projectId: string; versionId: string; expectedRevision: number }) {
  const [state, formAction, pending] = useActionState<QuoteActionState, FormData>(decideQuoteAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="project_id" value={projectId} />
      <input type="hidden" name="version_id" value={versionId} />
      <input type="hidden" name="expected_revision" value={expectedRevision} />
      {state?.error ? <AlertBanner variant="error" title="Décision impossible" explanation={state.error} /> : null}
      <TextField label="Motif (facultatif)" name="reason" />
      <div className="flex gap-2">
        <Button type="submit" name="decision" value="ACCEPTED" size="compact" loading={pending}>
          Accepter le devis
        </Button>
        <Button type="submit" name="decision" value="REFUSED" variant="danger" size="compact" loading={pending}>
          Refuser
        </Button>
      </div>
    </form>
  );
}
