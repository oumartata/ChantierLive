"use client";

import { useState } from "react";
import { Button, AlertBanner } from "@/components/ui";
import { getCatalogItemVersionFileAction } from "./actions";

// Consultation de l'aperçu et récupération du fichier modifiable (Lot A,
// PREPARATION_CATALOGUE_MODIFIABLE.md) — mêmes droits que la gestion du
// catalogue aujourd'hui (propriétaire de l'organisation, revérifié par le
// RPC appelé) : aucune permission de lecture nouvelle, aucun accès public.
export function CatalogVersionFileLinks({ versionId }: { versionId: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [layout, setLayout] = useState<unknown>(undefined);

  async function handleOpen() {
    setLoading(true);
    setError(null);
    const result = await getCatalogItemVersionFileAction(versionId);
    setLoading(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setPreviewUrl(result.value.previewUrl);
    setLayout(result.value.layout);
    if (result.value.previewUrl) {
      window.open(result.value.previewUrl, "_blank", "noopener,noreferrer");
    }
  }

  function handleDownloadLayout() {
    if (!layout) return;
    const blob = new Blob([JSON.stringify(layout, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "modele-chantierlive.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="secondary" size="compact" loading={loading} onClick={handleOpen}>
        Voir l&apos;aperçu
      </Button>
      {layout !== undefined && layout !== null ? (
        <Button type="button" variant="secondary" size="compact" onClick={handleDownloadLayout}>
          Récupérer le fichier modifiable (.json)
        </Button>
      ) : layout === null && previewUrl ? (
        <span className="text-caption text-muted">Modèle sans fichier modifiable (dépôt plat).</span>
      ) : null}
      {error ? <AlertBanner variant="error" title="Lecture impossible" explanation={error} /> : null}
    </div>
  );
}
