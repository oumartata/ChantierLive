"use client";

import { Button } from "@/components/ui";
import { OfflineLogoutForm } from "@/components/offline/OfflineLogoutForm";

// Composant client dédié : signOut peut échouer (voir actions.ts) et
// l'échec doit être visible, jamais une déconnexion affichée à tort.
export function LogoutButton() {
  // L06 (O6) : base locale du compte effacée à la déconnexion.
  return (
    <OfflineLogoutForm className="flex flex-col gap-3">
      {(pending) => (
        <Button type="submit" variant="secondary" loading={pending}>
          Se déconnecter
        </Button>
      )}
    </OfflineLogoutForm>
  );
}
