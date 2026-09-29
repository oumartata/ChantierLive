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
export function DecisionButtons({
  token,
  identity,
  proposedRoleLabel,
  projectName,
}: {
  token: string;
  identity: string | null;
  proposedRoleLabel?: string;
  projectName?: string;
}) {
  const [acceptState, acceptAction, acceptPending] = useActionState<
    InvitationDecisionState,
    FormData
  >(acceptInvitationAction, null);
  const [refuseState, refuseAction, refusePending] = useActionState<
    InvitationDecisionState,
    FormData
  >(refuseInvitationAction, null);

  // 'already_member' : accept_invitation refuse explicitement tout profil
  // déjà membre actif, quel que soit son rôle actuel — le serveur ne
  // transforme JAMAIS un rôle existant (voir le commentaire source de
  // accept_invitation, M006a : "aucun changement de rôle implicite"). Ce cas
  // se produit typiquement quand le lien est ouvert avec le compte qui a
  // créé ou gère déjà ce chantier (ex. l'entreprise), pas avec le compte du
  // nouveau participant visé — d'où le message explicite ci-dessous, plutôt
  // qu'un texte générique. accept_invitation ne renvoie aucun project_id
  // dans ce cas (exception, pas une ligne de succès) et get_invitation_preview
  // n'en expose pas non plus (choix délibéré, hors périmètre ici) : faute de
  // pouvoir lier directement au chantier, on oriente vers le tableau de bord
  // ("Mes chantiers" y est désormais mis en avant).
  if (acceptState?.code === "already_member") {
    return (
      <div className="flex flex-col gap-3">
        <AlertBanner
          variant="information"
          title="Ce compte est déjà membre de ce chantier"
          explanation={
            `Le compte connecté${identity ? ` (${identity})` : ""} fait déjà partie de ${projectName ? `« ${projectName} »` : "ce chantier"}, sous son rôle actuel — jamais celui proposé ici${proposedRoleLabel ? ` (${proposedRoleLabel})` : ""}. Aucun rôle n'a été modifié. Si cette invitation est destinée à quelqu'un d'autre, utilisez « Changer de compte » et connectez-vous avec le compte concerné.`
          }
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
