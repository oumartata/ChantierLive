"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { resumeCatalogueCopyAction } from "@/app/(app)/organisations/[id]/catalogue/[itemId]/copier/actions";

// Copie d'un modèle interrompue avant l'enregistrement de sa variante 1 :
// action EXPLICITE pour la terminer sur la même demande, depuis la même
// version source. Rien n'est ouvert dans l'éditeur sans action ensuite :
// l'éditeur propose la copie et protège le brouillon local (bandeau dédié).
export function ResumeCatalogueCopyButton({ requestId }: { requestId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function handleClick() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await resumeCatalogueCopyAction(requestId);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.push(`/prototype-plans?retour=${result.value.projectId}&demande=${result.value.requestId}&variante=${result.value.variantId}`);
    } catch {
      setError("Réponse du serveur non reçue. Réessayez : la copie n'est jamais enregistrée deux fois.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="secondary" size="compact" loading={pending} onClick={handleClick}>
        Terminer la copie du modèle
      </Button>
      {error ? <span className="text-danger">{error}</span> : null}
    </span>
  );
}
