"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { Button, AlertBanner } from "@/components/ui";
import { signOut, type AuthActionState } from "@/app/(app)/(auth)/actions";
import {
  acceptInvitationAction,
  refuseInvitationAction,
  type InvitationDecisionState,
} from "./actions";

// "Utiliser un autre compte" : réutilise EXACTEMENT la déconnexion existante
// (signOut, scope "local") — se déconnecter est nécessaire ici car
// /connexion redirige immédiatement toute session déjà valide ; le jeton
// d'invitation est préservé pour revenir sur cette même page après
// connexion avec un autre compte. Jamais de déconnexion automatique à la
// simple ouverture du lien — uniquement sur ce clic explicite.
function ChangeAccountButton({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState<AuthActionState, FormData>(signOut, null);
  return (
    <form action={formAction}>
      <input type="hidden" name="invitation" value={token} />
      {state?.error ? (
        <AlertBanner variant="error" title="Déconnexion impossible" explanation={state.error} />
      ) : null}
      <Button type="submit" variant="ghost" size="compact" loading={pending} className="w-full">
        Utiliser un autre compte
      </Button>
    </form>
  );
}

function AlreadyMemberState({
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
  // accept_invitation refuse explicitement tout profil déjà membre actif,
  // quel que soit son rôle actuel — le serveur ne transforme JAMAIS un rôle
  // existant (voir son commentaire source, M006a : "aucun changement de
  // rôle implicite"). Ce cas se produit typiquement quand le lien est ouvert
  // avec le compte qui gère déjà ce chantier (ex. l'entreprise), pas avec le
  // compte du nouveau participant visé. accept_invitation ne renvoie aucun
  // project_id dans ce cas et get_invitation_preview n'en expose pas non
  // plus à l'anonyme (choix délibéré) : faute de pouvoir lier directement au
  // chantier, on oriente vers le tableau de bord ("Mes chantiers").
  return (
    <div className="flex flex-col gap-3">
      <AlertBanner
        variant="information"
        title="Ce compte est déjà membre de ce chantier"
        explanation={
          `Le compte connecté${identity ? ` (${identity})` : ""} fait déjà partie de ${projectName ? `« ${projectName} »` : "ce chantier"}, sous son rôle actuel — jamais celui proposé ici${proposedRoleLabel ? ` (${proposedRoleLabel})` : ""}. Aucun rôle n'a été modifié. Si cette invitation est destinée à quelqu'un d'autre, utilisez « Utiliser un autre compte ».`
        }
      />
      <Link href="/tableau-de-bord">
        <Button className="w-full">Ouvrir mes chantiers</Button>
      </Link>
      <ChangeAccountButton token={token} />
    </div>
  );
}

// Deux formulaires distincts (jamais un bouton générique qui déciderait à
// la soumission) : chaque action a son propre contrôle serveur (M006a),
// aucune décision automatique n'est jamais déclenchée par le simple
// affichage de cette page — uniquement par des clics explicites ici.
export function DecisionButtons({
  token,
  identity,
  alreadyMember,
  proposedRoleLabel,
  projectName,
}: {
  token: string;
  identity: string | null;
  alreadyMember: boolean;
  proposedRoleLabel?: string;
  projectName?: string;
}) {
  // Confirmation en deux temps pour une session PRÉEXISTANTE (celle qui
  // était déjà connectée avant l'ouverture du lien, jamais réinitialisée
  // automatiquement) : "Continuer avec ce compte" doit être un choix
  // explicite avant que "Accepter" n'apparaisse — jamais un accès direct qui
  // laisserait croire à une acceptation en un clic sous la mauvaise identité.
  const [confirmed, setConfirmed] = useState(false);

  const [acceptState, acceptAction, acceptPending] = useActionState<
    InvitationDecisionState,
    FormData
  >(acceptInvitationAction, null);
  const [refuseState, refuseAction, refusePending] = useActionState<
    InvitationDecisionState,
    FormData
  >(refuseInvitationAction, null);

  // Détection PROACTIVE (get_invitation_preview.already_member, M030) —
  // jamais seulement après un clic sur Accepter refusé par le serveur.
  // acceptState?.code reste une seconde ligne de défense pour une rare
  // course (adhésion créée ailleurs entre le chargement de la page et ce
  // clic) : même traitement dans les deux cas, jamais "Accepter" affiché.
  if (alreadyMember || acceptState?.code === "already_member") {
    return (
      <AlreadyMemberState
        token={token}
        identity={identity}
        proposedRoleLabel={proposedRoleLabel}
        projectName={projectName}
      />
    );
  }

  if (!confirmed) {
    return (
      <div className="flex flex-col gap-3">
        {identity ? (
          <p className="text-caption text-muted">
            Connecté en tant que <span className="font-semibold">{identity}</span>.
          </p>
        ) : null}
        <Button className="w-full" onClick={() => setConfirmed(true)}>
          Continuer avec ce compte
        </Button>
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
