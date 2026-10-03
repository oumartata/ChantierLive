"use client";

import { useRef, useState, useTransition, type ChangeEvent, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button, AlertBanner } from "@/components/ui";
import { depositModifiableCatalogItemVersionAction } from "./actions";
import { validateProjectFile } from "@/app/prototype-plans/projectFile";
import { renderSvg, renderSvgToPngBlob } from "@/app/prototype-plans/render";

// Dépôt d'un modèle MODIFIABLE (Lot A, PREPARATION_CATALOGUE_MODIFIABLE.md) —
// UN SEUL fichier choisi par l'utilisateur (le fichier de projet .json déjà
// exporté depuis /prototype-plans), jamais deux fichiers indépendants
// susceptibles de représenter des plans différents : le PNG (aperçu) est
// rendu ICI, côté client, depuis CE MÊME layout validé, avec le rendu
// existant (renderSvg/render.ts) — jamais un second moteur de rendu, jamais
// un fichier image choisi séparément.
export function UploadModifiableVersionForm({ organizationId, catalogItemId }: { organizationId: string; catalogItemId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewInfo, setPreviewInfo] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pendingOperationUuidRef = useRef<string | null>(null);

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    pendingOperationUuidRef.current = null;
    setSelectedFile(e.target.files?.[0] ?? null);
    setPreviewInfo(null);
    setError(null);
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selectedFile) {
      setError("Choisissez un fichier de projet (.json) à déposer.");
      return;
    }
    const file = selectedFile;
    setError(null);
    if (!pendingOperationUuidRef.current) {
      pendingOperationUuidRef.current = crypto.randomUUID();
    }
    const operationUuid = pendingOperationUuidRef.current;
    startTransition(async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        setError("Fichier de projet illisible (JSON invalide).");
        return;
      }
      // Validation côté client pour un retour immédiat — l'action serveur
      // revalide intégralement (validateProjectFile, autoritaire) avant tout
      // stockage, jamais une confiance aveugle dans ce contrôle client.
      const validated = validateProjectFile(parsed);
      if (!validated.ok) {
        setError(`Fichier de projet invalide : ${validated.error}`);
        return;
      }
      if (!canvasRef.current) {
        setError("Rendu indisponible. Réessayez.");
        return;
      }
      let pngBlob: Blob;
      try {
        const svgMarkup = renderSvg(validated.value.layout, validated.value.orientation);
        pngBlob = await renderSvgToPngBlob(svgMarkup, canvasRef.current);
      } catch {
        setError("Impossible de générer l'aperçu depuis ce fichier. Réessayez.");
        return;
      }
      setPreviewInfo(`Aperçu généré depuis ${file.name} (version ${validated.value.version}, orientation ${validated.value.orientation}).`);

      const formData = new FormData();
      formData.set("organization_id", organizationId);
      formData.set("catalog_item_id", catalogItemId);
      formData.set("operation_uuid", operationUuid);
      formData.set("file", new File([pngBlob], "apercu.png", { type: "image/png" }));
      formData.set("layout", JSON.stringify(validated.value));
      const result = await depositModifiableCatalogItemVersionAction(formData);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      pendingOperationUuidRef.current = null;
      setSelectedFile(null);
      setPreviewInfo(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      router.refresh();
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2 border-t border-sand pt-3">
      <p className="text-caption text-muted">
        Modèle modifiable : déposez le fichier de projet (.json) déjà exporté depuis le générateur 2D. L&apos;aperçu
        (PNG) est produit automatiquement depuis ce même fichier, jamais choisi séparément.
      </p>
      {error ? <AlertBanner variant="error" title="Dépôt impossible" explanation={error} /> : null}
      {previewInfo ? <p className="text-caption text-ink">{previewInfo}</p> : null}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        onChange={handleFileChange}
        className="text-caption text-ink"
      />
      <canvas ref={canvasRef} className="hidden" />
      <Button type="submit" size="compact" loading={pending}>
        Déposer ce modèle modifiable
      </Button>
    </form>
  );
}
