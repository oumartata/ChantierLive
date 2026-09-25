"use client";

import { useRef, useState, useTransition, type ChangeEvent, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button, AlertBanner } from "@/components/ui";
import { depositCatalogItemVersionAction } from "./actions";

// Flux SIMPLIFIÉ (voir actions.ts) : un seul appel serveur par tentative,
// pas de résolution client de reprise après interruption réseau franche —
// proportionné à un dépôt ponctuel par le propriétaire pour ce lot.
// CORRIGÉ (revue ciblée, point 1) : l'operation_uuid est désormais généré
// ICI et PERSISTÉ tant que le fichier sélectionné ne change pas — un
// nouveau clic sur "Déposer" après une réponse perdue (timeout réseau, etc.)
// REPREND la même opération plutôt que d'en ouvrir une nouvelle (même
// principe que pendingOperationUuidRef dans MediaUploadForm, B026/B027).
export function UploadVersionForm({ organizationId, catalogItemId }: { organizationId: string; catalogItemId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const pendingOperationUuidRef = useRef<string | null>(null);

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    // Nouveau fichier choisi = nouveau dépôt explicite : abandonne toute
    // opération en attente pour l'ancien fichier (jamais reprise pour un
    // contenu différent).
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
    if (!pendingOperationUuidRef.current) {
      pendingOperationUuidRef.current = crypto.randomUUID();
    }
    const operationUuid = pendingOperationUuidRef.current;
    startTransition(async () => {
      const formData = new FormData();
      formData.set("organization_id", organizationId);
      formData.set("catalog_item_id", catalogItemId);
      formData.set("operation_uuid", operationUuid);
      formData.set("file", file);
      const result = await depositCatalogItemVersionAction(formData);
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
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,image/jpeg,image/png"
        onChange={handleFileChange}
        className="text-caption text-ink"
      />
      <Button type="submit" size="compact" loading={pending}>
        Déposer une nouvelle version
      </Button>
    </form>
  );
}
