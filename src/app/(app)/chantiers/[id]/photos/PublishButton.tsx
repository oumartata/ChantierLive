"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, AlertBanner } from "@/components/ui";
import { publishMediaAsset } from "./actions";

export function PublishButton({ projectId, mediaId }: { projectId: string; mediaId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePublish() {
    setPending(true);
    setError(null);
    const result = await publishMediaAsset({ projectId, mediaId });
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-2">
      {error && <AlertBanner variant="error" title="Publication impossible" explanation={error} />}
      <Button variant="secondary" size="compact" loading={pending} disabled={pending} onClick={handlePublish}>
        Publier pour l&apos;équipe
      </Button>
    </div>
  );
}
