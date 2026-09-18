"use client";

import { useActionState } from "react";
import { Button, AlertBanner } from "@/components/ui";
import { signOut, type AuthActionState } from "../actions";

// Composant client dédié : signOut peut échouer (voir actions.ts) et
// l'échec doit être visible, jamais une déconnexion affichée à tort.
export function LogoutButton() {
  const [state, formAction, pending] = useActionState<AuthActionState, FormData>(
    signOut,
    null
  );

  return (
    <form action={formAction} className="flex flex-col gap-3">
      {state?.error ? (
        <AlertBanner
          variant="error"
          title="Déconnexion impossible"
          explanation={state.error}
        />
      ) : null}
      <Button type="submit" variant="secondary" loading={pending}>
        Se déconnecter
      </Button>
    </form>
  );
}
