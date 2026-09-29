"use client";

import { useActionState } from "react";
import { Button, TextField, AlertBanner } from "@/components/ui";
import { designateEngineerAction, type IngenieursActionState } from "./actions";

export function DesignateEngineerForm({ organizationId }: { organizationId: string }) {
  const [state, formAction, pending] = useActionState<IngenieursActionState, FormData>(
    designateEngineerAction,
    null
  );

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="organization_id" value={organizationId} />
      <h2 className="text-h2 font-semibold text-ink">Désigner un ingénieur</h2>
      {state?.error ? (
        <AlertBanner variant="error" title="Désignation impossible" explanation={state.error} />
      ) : null}
      <TextField
        label="E-mail ou téléphone de l'ingénieur"
        name="identifier"
        required
        placeholder="ex. ingenieur@agence.com ou +22370000000"
      />
      <p className="text-caption text-muted">
        L&apos;ingénieur doit déjà posséder un compte ChantierLive avec cet identifiant vérifié.
        Aucun annuaire n&apos;est proposé ici — indiquez l&apos;identifiant que vous connaissez déjà.
      </p>
      <Button type="submit" loading={pending}>
        Désigner
      </Button>
    </form>
  );
}
