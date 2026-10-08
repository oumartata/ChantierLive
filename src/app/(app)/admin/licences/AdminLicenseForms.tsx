"use client";

import { useActionState } from "react";
import { AlertBanner, Button, TextField } from "@/components/ui";
import { activateLicensePaymentAction, rejectLicensePaymentAction, type AdminLicenseActionState } from "./actions";

// B049 (D194) — décisions de l'administrateur sur une déclaration en attente.

function Feedback({ state, title }: { state: AdminLicenseActionState; title: string }) {
  return state && "error" in state ? <AlertBanner variant="error" title={title} explanation={state.error} /> : null;
}

export function ActivateForm({ paymentId }: { paymentId: string }) {
  const [state, formAction, pending] = useActionState<AdminLicenseActionState, FormData>(activateLicensePaymentAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="payment_id" value={paymentId} />
      <TextField label="Note de vérification (facultative)" name="note" maxLength={1000} />
      <p className="text-caption text-muted">La licence du chantier devient active aujourd&apos;hui pour 12 mois. Aucun rôle ni droit n&apos;est modifié.</p>
      <Feedback state={state} title="Activation impossible" />
      <div>
        <Button type="submit" size="compact" loading={pending}>
          Activer la licence
        </Button>
      </div>
    </form>
  );
}

export function RejectForm({ paymentId }: { paymentId: string }) {
  const [state, formAction, pending] = useActionState<AdminLicenseActionState, FormData>(rejectLicensePaymentAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="payment_id" value={paymentId} />
      <TextField label="Motif du rejet" name="reason" required minLength={3} maxLength={1000} />
      <p className="text-caption text-muted">Le déclarant verra ce motif. Rien n&apos;est supprimé.</p>
      <Feedback state={state} title="Rejet impossible" />
      <div>
        <Button type="submit" size="compact" variant="danger" loading={pending}>
          Rejeter la déclaration
        </Button>
      </div>
    </form>
  );
}
