"use client";

import { useActionState } from "react";
import { AlertBanner, Button, TextField } from "@/components/ui";
import { setInternalBudgetAction, type BudgetActionState } from "./actions";

// Déclaration (première version, motif facultatif) ou révision directe
// (motif obligatoire, D185) du budget interne.
export function BudgetForm({ projectId, revision, isRevision }: { projectId: string; revision: number; isRevision: boolean }) {
  const [state, formAction, pending] = useActionState<BudgetActionState, FormData>(setInternalBudgetAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-3" data-testid="budget-form">
      <input type="hidden" name="project_id" value={projectId} />
      <input type="hidden" name="expected_revision" value={revision} />
      <TextField label={isRevision ? "Nouveau montant (FCFA)" : "Montant du budget interne (FCFA)"} name="amount" inputMode="numeric" required />
      <TextField label={isRevision ? "Motif de la révision" : "Note (facultative)"} name="reason" required={isRevision} minLength={isRevision ? 3 : undefined} maxLength={1000} />
      <p className="text-caption text-muted">
        {isRevision
          ? "La nouvelle version devient le budget en vigueur ; l'ancienne reste visible dans l'historique."
          : "Montant entier en FCFA. Ce budget reste interne à l'entreprise : il n'est jamais montré au propriétaire."}
      </p>
      {state && "error" in state ? <AlertBanner variant="error" title="Budget non enregistré" explanation={state.error} /> : null}
      {state && "ok" in state ? <p className="text-caption text-muted">Budget enregistré.</p> : null}
      <div>
        <Button type="submit" loading={pending}>
          {isRevision ? "Enregistrer la révision" : "Déclarer le budget"}
        </Button>
      </div>
    </form>
  );
}
