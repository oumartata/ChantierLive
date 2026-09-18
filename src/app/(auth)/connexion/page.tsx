"use client";

import { Suspense, useActionState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button, TextField, AlertBanner, Card } from "@/components/ui";
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

export default function ConnexionPage() {
  const [state, formAction, pending] = useActionState<AuthActionState, FormData>(
    signIn,
    null
  );

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-title font-bold text-ink">Se connecter</h1>
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
          <Button type="submit" loading={pending}>
            Se connecter
          </Button>
        </form>
      </Card>
      <p className="text-body text-ink">
        Pas encore de compte ?{" "}
        <Link href="/inscription" className="font-semibold text-primary">
          Créer un compte
        </Link>
      </p>
    </div>
  );
}
