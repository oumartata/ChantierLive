"use client";

import { useActionState } from "react";
import { Button, AlertBanner } from "@/components/ui";
import { refuseInvitationAction, type InvitationDecisionState } from "./actions";

// B016 (corrections post-revue) : proposé uniquement quand l'aperçu est
// indisponible (get_invitation_preview, M006) mais l'utilisateur est
// authentifié — refuse_invitation (M006a) autorise le refus indépendamment
// de la validité de l'adhésion émettrice, contrairement à accept_invitation.
// Masquer ce bouton dans ce cas empêcherait un refus pourtant possible côté
// RPC. Jamais de bouton Accepter ici (échouerait par construction si la
// cause réelle est un émetteur invalidé) et aucune information de chantier
// affichée (fidèle à l'indistinction volontaire de get_invitation_preview,
// BR024) — refuse_invitation reste seul responsable du contrôle de cible.
export function RefuseOnlyButton({ token }: { token: string }) {
  const [state, action, pending] = useActionState<InvitationDecisionState, FormData>(
    refuseInvitationAction,
    null
  );

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="token" value={token} />
      {state?.error ? (
        <AlertBanner variant="error" title="Refus impossible" explanation={state.error} />
      ) : null}
      <Button type="submit" variant="secondary" loading={pending} className="w-full">
        Refuser cette invitation
      </Button>
    </form>
  );
}
