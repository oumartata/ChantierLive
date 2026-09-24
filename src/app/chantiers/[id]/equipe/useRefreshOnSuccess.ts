"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

// B018 (corrigé après revue ZIP, 2026-09-24) : revalidatePath (Server Action)
// invalide le cache serveur mais ne réactualise pas toujours immédiatement
// l'arbre client déjà monté (observé sur les 2 parcours navigateur : un
// rechargement manuel était nécessaire pour voir la demande/les nouveaux
// rôles/les actions actualisées). router.refresh() est déclenché ICI dès
// qu'une soumission vient de se terminer SANS erreur (transition pending
// true -> false, state sans "error") — jamais à l'affichage initial.
export function useRefreshOnSuccess(pending: boolean, hasError: boolean) {
  const router = useRouter();
  const wasPending = useRef(false);

  useEffect(() => {
    if (wasPending.current && !pending && !hasError) {
      router.refresh();
    }
    wasPending.current = pending;
  }, [pending, hasError, router]);
}
