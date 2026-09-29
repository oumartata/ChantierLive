"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Button, AlertBanner } from "@/components/ui";
import { signOut, type AuthActionState } from "@/app/(app)/(auth)/actions";
import {
  acceptInvitationAction,
  refuseInvitationAction,
  type InvitationDecisionState,
} from "./actions";

// "Changer de compte" : réutilise EXACTEMENT la déconnexion existante
// (signOut, scope "local") — se déconnecter est nécessaire ici car
// /connexion redirige immédiatement toute session déjà valide ; le jeton
// d'invitation est préservé pour revenir sur cette même page après
// connexion avec un autre compte.
function ChangeAccountButton({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState<AuthActionState, FormData>(signOut, null);
  return (
    <form action={formAction}>
      <input type="hidden" name="invitation" value={token} />
      {state?.error ? (
        <AlertBanner variant="error" title="Déconnexion impossible" explanation={state.error} />
      ) : null}
      <Button type="submit" variant="ghost" size="compact" loading={pending} className="w-full">
        Changer de compte
      </Button>
    </form>
  );
}

// Deux formulaires distincts (jamais un bouton générique qui déciderait à
// la soumission) : chaque action a son propre contrôle serveur (M006a),
// aucune décision automatique n'est jamais déclenchée par le simple
// affichage de cette page — uniquement par un clic explicite ici.
export function DecisionButtons({ token, identity }: { token: string; identity: string | null }) {
  const [acceptState, acceptAction, acceptPending] = useActionState<
    InvitationDecisionState,
    FormData
  >(acceptInvitationAction, null);
  const [refuseState, refuseAction, refusePending] = useActionState<
    InvitationDecisionState,
    FormData
  >(refuseInvitationAction, null);

  // 'already_member' : accept_invitation ne renvoie aucun project_id dans ce
  // cas (exception, pas une ligne de succès) — get_invitation_preview n'en
  // expose pas non plus (choix délibéré, hors périmètre ici). Faute de
  // pouvoir lier directement au chantier, on oriente vers le tableau de bord
  // ("Mes chantiers" y est désormais mis en avant) plutôt qu'un message sec.
  if (acceptState?.code === "already_member") {
    return (
      <div className="flex flex-col gap-3">
        <AlertBanner
          variant="information"
          title="Déjà membre de ce chantier"
          explanation="Ce compte fait déjà partie de ce chantier. Aucun changement n'a été effectué."
        />
        <Link href="/tableau-de-bord">
          <Button className="w-full">Ouvrir mes chantiers</Button>
        </Link>
        <ChangeAccountButton token={token} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {identity ? (
        <p className="text-caption text-muted">
          Connecté en tant que <span className="font-semibold">{identity}</span> — c&apos;est ce compte qui acceptera l&apos;invitation.
        </p>
      ) : null}
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
      <ChangeAccountButton token={token} />
    </div>
  );
}
