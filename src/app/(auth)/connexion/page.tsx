"use client";

import { Suspense, useActionState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button, TextField, AlertBanner, Card } from "@/components/ui";
import { parseInvitationToken } from "@/lib/invitationResume";
import { signIn, type AuthActionState } from "../actions";

function SignupNotice() {
  const searchParams = useSearchParams();
  if (searchParams.get("inscription") !== "ok") {
    return null;
  }
  return (
    <AlertBanner
      variant="information"
      title="Compte créé"
      explanation="Confirmez votre identifiant (e-mail ou code reçu) avant de vous connecter."
    />
  );
}

// FR033 : reprend l'invitation en cours (transmise via ?invitation=<jeton>)
// à travers le formulaire — revalidée côté serveur dans signIn, jamais
// utilisée telle quelle. Absente ou invalide -> champ vide, parcours normal.
function InvitationHiddenField() {
  const searchParams = useSearchParams();
  const token = parseInvitationToken(searchParams.get("invitation"));
  return <input type="hidden" name="invitation" value={token ?? ""} />;
}

// Préserve la reprise en cours si l'utilisateur bascule vers l'inscription.
function CreateAccountLink() {
  const searchParams = useSearchParams();
  const token = parseInvitationToken(searchParams.get("invitation"));
  return (
    <Link
      href={token ? `/inscription?invitation=${token}` : "/inscription"}
      className="font-semibold text-primary"
    >
      Créer un compte
    </Link>
  );
}

export default function ConnexionPage() {
  const [state, formAction, pending] = useActionState<AuthActionState, FormData>(
    signIn,
    null
  );

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-h1 font-bold text-ink">Se connecter</h1>
      <Card className="flex flex-col gap-4 p-6">
        <Suspense fallback={null}>
          <SignupNotice />
        </Suspense>
        {state?.error ? (
          <AlertBanner variant="error" title="Connexion impossible" explanation={state.error} />
        ) : null}
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
            autoComplete="current-password"
            required
          />
          <Suspense fallback={<input type="hidden" name="invitation" value="" />}>
            <InvitationHiddenField />
          </Suspense>
          <Button type="submit" loading={pending}>
            Se connecter
          </Button>
        </form>
      </Card>
      <p className="text-body text-ink">
        Pas encore de compte ?{" "}
        <Suspense fallback={<Link href="/inscription" className="font-semibold text-primary">Créer un compte</Link>}>
          <CreateAccountLink />
        </Suspense>
      </p>
    </div>
  );
}
