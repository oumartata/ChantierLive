"use client";

import { useActionState } from "react";
import { Button, AlertBanner } from "@/components/ui";
import { signOut, type AuthActionState } from "@/app/(app)/(auth)/actions";

// Identité + déconnexion, toujours en dernière position du menu de
// navigation (jamais mélangées aux destinations). Réutilise directement
// signOut (scope "local", voir (auth)/actions.ts) — pas une nouvelle
// implémentation de déconnexion.
export function AccountMenuFooter({ identity }: { identity: string | null }) {
  const [state, formAction, pending] = useActionState<AuthActionState, FormData>(
    signOut,
    null
  );

  return (
    <div className="flex flex-col gap-2 border-t border-muted/20 pt-3 md:border-t-0 md:pt-0">
      {identity ? (
        <p className="truncate px-2 text-caption text-muted" title={identity}>
          {identity}
        </p>
      ) : null}
      {state?.error ? (
        <AlertBanner variant="error" title="Déconnexion impossible" explanation={state.error} />
      ) : null}
      <form action={formAction}>
        <Button type="submit" variant="ghost" size="compact" loading={pending} className="w-full justify-start">
          Se déconnecter
        </Button>
      </form>
    </div>
  );
}
