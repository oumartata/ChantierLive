"use client";

import { useRef, useState, useTransition, type ChangeEvent, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button, AlertBanner } from "@/components/ui";
import { depositProjectPlanAction } from "./actions";

// Plafond RÉEL du flux : storage.buckets.file_size_limit pour "project-plans"
// (M020) = 20971520 octets exactement — vérifié dans la migration, pas
// supposé. Un contrôle ICI, avant tout envoi réseau, donne un message clair
// immédiatement plutôt que de laisser Storage refuser après coup ; il ne
// remplace pas cette limite serveur, qui reste seule décisionnaire.
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

// Même flux que UploadVersionForm (B061) : l'operation_uuid est généré ICI
// et persisté tant que le fichier sélectionné ne change pas, pour qu'un
// nouveau clic après une réponse perdue reprenne la même opération.
export function DepositPlanForm({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const pendingOperationUuidRef = useRef<string | null>(null);

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    pendingOperationUuidRef.current = null;
    setSelectedFile(e.target.files?.[0] ?? null);
    setError(null);
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selectedFile) {
      setError("Choisissez un fichier à déposer.");
      return;
    }
    const file = selectedFile;
    setError(null);
    // Vérifié AVANT tout envoi réseau, aucun opération_uuid consommé pour
    // rien : Storage refuserait de toute façon au-delà de cette taille
    // (bucket "project-plans", M020) — message clair immédiat plutôt qu'un
    // échec réseau brut.
    if (file.size > MAX_FILE_SIZE_BYTES) {
      setError("Ce fichier dépasse la taille maximale autorisée (20 Mo). Choisissez un fichier plus léger.");
      return;
    }
    if (!pendingOperationUuidRef.current) {
      pendingOperationUuidRef.current = crypto.randomUUID();
    }
    const operationUuid = pendingOperationUuidRef.current;
    startTransition(async () => {
      const formData = new FormData();
      formData.set("project_id", projectId);
      formData.set("operation_uuid", operationUuid);
      formData.set("file", file);
      // Filet de sécurité : un rejet de transport (limite de taille, réseau)
      // survient AVANT l'exécution de l'action serveur et rejette cette
      // promesse plutôt que de renvoyer { ok: false } — jamais un plan
      // finalisé dans ce cas, seulement un message français au lieu d'une
      // erreur brute du framework.
      let result: Awaited<ReturnType<typeof depositProjectPlanAction>>;
      try {
        result = await depositProjectPlanAction(formData);
      } catch {
        setError("L'envoi a échoué (fichier trop volumineux ou connexion interrompue). Réessayez avec un fichier plus léger.");
        return;
      }
      if (!result.ok) {
        setError(result.message);
        return;
      }
      pendingOperationUuidRef.current = null;
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      router.refresh();
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      {error ? <AlertBanner variant="error" title="Dépôt impossible" explanation={error} /> : null}
      <label className="flex flex-col gap-1 text-caption text-ink">
        Fichier du plan (PDF, JPEG ou PNG)
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,image/jpeg,image/png"
          onChange={handleFileChange}
          className="text-caption text-ink"
        />
      </label>
      <Button type="submit" size="compact" loading={pending}>
        Déposer ce plan
      </Button>
    </form>
  );
}
