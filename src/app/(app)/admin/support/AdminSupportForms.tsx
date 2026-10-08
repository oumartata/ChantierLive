"use client";

import { useActionState } from "react";
import { AlertBanner, Button } from "@/components/ui";
import { adminCloseSupportRequestAction, adminRevokeSupportAccessAction, takeSupportRequestAction, type AdminSupportState } from "./actions";

// B051 (D197) — formulaires de l'administrateur sur une demande d'aide.

const FIELD = "w-full rounded-small border border-muted/40 bg-surface px-4 py-2 text-body font-normal text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

function Feedback({ state, title }: { state: AdminSupportState; title: string }) {
  return state && "error" in state ? <AlertBanner variant="error" title={title} explanation={state.error} /> : null;
}

export function TakeRequestForm({ requestId }: { requestId: string }) {
  const [state, formAction, pending] = useActionState<AdminSupportState, FormData>(takeSupportRequestAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="request_id" value={requestId} />
      <label className="flex flex-col gap-1 text-label font-semibold text-ink">
        Motif de la prise en charge
        <textarea name="reason" required minLength={10} maxLength={1000} rows={2} className={FIELD} />
      </label>
      <p className="text-caption text-muted">Le motif est visible de l&apos;entreprise et du propriétaire principal, dans leur journal des accès support.</p>
      <Feedback state={state} title="Prise en charge impossible" />
      <div>
        <Button type="submit" size="compact" loading={pending}>
          Prendre en charge
        </Button>
      </div>
    </form>
  );
}

export function AdminRevokeForm({ requestId, grantId }: { requestId: string; grantId: string }) {
  const [state, formAction, pending] = useActionState<AdminSupportState, FormData>(adminRevokeSupportAccessAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="request_id" value={requestId} />
      <input type="hidden" name="grant_id" value={grantId} />
      <Feedback state={state} title="Arrêt impossible" />
      <div>
        <Button type="submit" size="compact" variant="secondary" loading={pending}>
          Arrêter l&apos;accès
        </Button>
      </div>
    </form>
  );
}

export function AdminCloseForm({ requestId }: { requestId: string }) {
  const [state, formAction, pending] = useActionState<AdminSupportState, FormData>(adminCloseSupportRequestAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="request_id" value={requestId} />
      <Feedback state={state} title="Clôture impossible" />
      <div>
        <Button type="submit" size="compact" variant="secondary" loading={pending}>
          Clore la demande
        </Button>
      </div>
    </form>
  );
}
