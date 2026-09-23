"use client";

import { useActionState } from "react";
import { Button, AlertBanner } from "@/components/ui";
import {
  acceptInvitationAction,
  refuseInvitationAction,
  type InvitationDecisionState,
} from "./actions";

// Deux formulaires distincts (jamais un bouton générique qui déciderait à
// la soumission) : chaque action a son propre contrôle serveur (M006a),
// aucune décision automatique n'est jamais déclenchée par le simple
// affichage de cette page — uniquement par un clic explicite ici.
export function DecisionButtons({ token }: { token: string }) {
  const [acceptState, acceptAction, acceptPending] = useActionState<
    InvitationDecisionState,
    FormData
  >(acceptInvitationAction, null);
  const [refuseState, refuseAction, refusePending] = useActionState<
    InvitationDecisionState,
    FormData
  >(refuseInvitationAction, null);

  return (
    <div className="flex flex-col gap-3">
      {acceptState?.error ? (
        <AlertBanner variant="error" title="Acceptation impossible" explanation={acceptState.error} />
      ) : null}
      {refuseState?.error ? (
        <AlertBanner variant="error" title="Refus impossible" explanation={refuseState.error} />
      ) : null}
      <form action={acceptAction}>
        <input type="hidden" name="token" value={token} />
        <Button type="submit" loading={acceptPending} disabled={refusePending} className="w-full">
          Accepter
        </Button>
      </form>
      <form action={refuseAction}>
        <input type="hidden" name="token" value={token} />
        <Button
          type="submit"
          variant="secondary"
          loading={refusePending}
          disabled={acceptPending}
          className="w-full"
        >
          Refuser
        </Button>
      </form>
    </div>
  );
}
