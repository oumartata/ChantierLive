"use client";

import { useActionState } from "react";
import { Button, AlertBanner } from "@/components/ui";
import { grantDelegationAction, type EquipeActionState } from "./actions";

// B017 : un bouton = un formulaire = un code (jamais de <form> imbriqué,
// invalide en HTML). Aucun champ de motif ici (grant_delegation, M004c,
// génère lui-même un motif technique). Les codes proposés sont restreints
// par le parent à ceux réellement éligibles pour ce bénéficiaire (couples
// déjà validés, M004) : ce composant ne choisit rien lui-même.
export function GrantDelegationForm({
  projectId,
  projectMembershipId,
  codes,
  labels,
}: {
  projectId: string;
  projectMembershipId: string;
  codes: string[];
  labels: Record<string, string>;
}) {
  const [state, formAction, pending] = useActionState<EquipeActionState, FormData>(
    grantDelegationAction,
    null
  );

  if (codes.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2">
      {state?.error ? (
        <AlertBanner variant="error" title="Octroi impossible" explanation={state.error} />
      ) : null}
      <div className="flex flex-wrap gap-2">
        {codes.map((code) => (
          <form key={code} action={formAction}>
            <input type="hidden" name="project_id" value={projectId} />
            <input type="hidden" name="project_membership_id" value={projectMembershipId} />
            <input type="hidden" name="permission_code" value={code} />
            <Button type="submit" variant="secondary" size="compact" loading={pending}>
              Accorder « {labels[code] ?? code} »
            </Button>
          </form>
        ))}
      </div>
    </div>
  );
}
