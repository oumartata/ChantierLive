"use client";

import { Button } from "@/components/ui";
import { OfflineLogoutForm } from "@/components/offline/OfflineLogoutForm";

// Identité + déconnexion, toujours en dernière position du menu de
// navigation (jamais mélangées aux destinations). Réutilise directement
// signOut (scope "local", voir (auth)/actions.ts) — pas une nouvelle
// implémentation de déconnexion.
export function AccountMenuFooter({ identity }: { identity: string | null }) {
  return (
    <div className="flex flex-col gap-2 border-t border-muted/20 pt-3 md:border-t-0 md:pt-0">
      {identity ? (
        <p className="truncate px-2 text-caption text-muted" title={identity}>
          {identity}
        </p>
      ) : null}
      {/* L06 (O6) : effacement de la base locale du compte, avec choix si des
          brouillons hors ligne ne sont pas envoyés. */}
      <OfflineLogoutForm>
        {(pending) => (
          <Button type="submit" variant="ghost" size="compact" loading={pending} className="w-full justify-start">
            Se déconnecter
          </Button>
        )}
      </OfflineLogoutForm>
    </div>
  );
}
