"use client";

import { Suspense, useActionState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button, TextField, AlertBanner, Card } from "@/components/ui";
import { parseInvitationToken } from "@/lib/invitationResume";
import { signUp, type AuthActionState } from "../actions";

// FR033 : voir connexion/page.tsx — même mécanisme dédié, revalidé côté
// serveur dans signUp.
function InvitationHiddenField() {
  const searchParams = useSearchParams();
  const token = parseInvitationToken(searchParams.get("invitation"));
  return <input type="hidden" name="invitation" value={token ?? ""} />;
}

function SignInLink() {
  const searchParams = useSearchParams();
  const token = parseInvitationToken(searchParams.get("invitation"));
  return (
    <Link
      href={token ? `/connexion?invitation=${token}` : "/connexion"}
      className="font-semibold text-primary"
    >
      Se connecter
    </Link>
  );
}

export function InscriptionForm() {
  const [state, formAction, pending] = useActionState<AuthActionState, FormData>(
    signUp,
    null
  );

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-h1 font-bold text-ink">Créer un compte</h1>
      <Card className="flex flex-col gap-4 p-6">
        {state?.error ? (
          <AlertBanner variant="error" title="Inscription impossible" explanation={state.error} />
        ) : null}
        {/* Diagnostic : [auth.sms.twilio] utilise des identifiants fictifs en
            local (aucun fournisseur réel connecté) — seuls les deux numéros
            de test fonctionnent. Orientation vers l'e-mail plutôt qu'un
            blocage silencieux ou une activation de service payant. */}
        <AlertBanner
          variant="information"
          title="Sur cet environnement de démonstration"
          explanation="L'envoi de SMS réel n'est pas connecté. Utilisez un e-mail pour un parcours complet, ou l'un des deux numéros de test (+15550001111 / +15550001112, code 123456)."
        />
        <form action={formAction} className="flex flex-col gap-4">
          <TextField
            label="Téléphone ou e-mail"
            name="identifier"
            type="text"
            autoComplete="username"
            required
          />
          <TextField
            label="Mot de passe"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={6}
            required
          />
          <Suspense fallback={<input type="hidden" name="invitation" value="" />}>
            <InvitationHiddenField />
          </Suspense>
          <Button type="submit" loading={pending}>
            Créer mon compte
          </Button>
        </form>
      </Card>
      <p className="text-body text-ink">
        Déjà un compte ?{" "}
        <Suspense fallback={<Link href="/connexion" className="font-semibold text-primary">Se connecter</Link>}>
          <SignInLink />
        </Suspense>
      </p>
    </div>
  );
}
