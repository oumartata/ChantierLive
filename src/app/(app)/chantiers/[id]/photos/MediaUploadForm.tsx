"use client";

import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button, TextField, AlertBanner } from "@/components/ui";
import { commitMediaUpload, getUploadStatus, prepareMediaUpload, recoverMediaUpload } from "./actions";
import { isConfirmedNonExistent, resumeUploadPlan } from "@/lib/media/uploadResumePolicy";

const BUCKET = "project-media";

async function sha256Hex(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function MediaUploadForm({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [caption, setCaption] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Fichier retenu en état CONTRÔLÉ, jamais relu depuis l'<input> au moment
  // du clic (correction post-vérification navigateur, 2026-09-26) : un
  // <form action={...}> (React 19) réinitialise l'<input type="file">
  // non contrôlé après CHAQUE soumission, y compris un échec — vérifié
  // réellement (l'input était vide juste après un rejet). Sans cet état,
  // "Déposer la photo" recliqué après un échec ne retrouvait plus aucun
  // fichier et ne pouvait donc jamais exercer la reprise ci-dessous.
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  // Opération en cours pour le FICHIER actuellement retenu (revue
  // 2026-09-26) : un nouvel operationUuid n'était généré qu'au hasard de
  // chaque clic, y compris pour "réessayer" un résultat incertain — ce qui
  // pouvait produire un second média pour un même dépôt. Cette référence
  // persiste tant que l'utilisateur ne choisit pas explicitement un NOUVEAU
  // fichier (voir handleFileChange) ; "Déposer la photo" recliqué sans
  // changer de fichier REPREND cette même opération.
  const pendingOperationUuidRef = useRef<string | null>(null);

  // Nouveau fichier choisi = nouvel envoi explicite : abandonne toute
  // opération en attente pour l'ancien fichier (jamais reprise pour un
  // contenu différent).
  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    pendingOperationUuidRef.current = null;
    setSelectedFile(e.target.files?.[0] ?? null);
    setError(null);
    setSuccess(false);
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    const file: File | null = selectedFile;
    if (!file || file.size === 0) {
      setError("Choisissez une photo à envoyer.");
      return;
    }
    // Capturé dans une const explicitement typée `File` (jamais `File | null`)
    // : TypeScript ne propage pas le rétrécissement ci-dessus dans les
    // fonctions imbriquées (depositSource ci-dessous).
    const currentFile: File = file;

    function shortCircuitSuccess() {
      pendingOperationUuidRef.current = null;
      setSelectedFile(null);
      setSuccess(true);
      setCaption("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      router.refresh();
    }

    setPending(true);
    try {
      let operationUuid = pendingOperationUuidRef.current;
      // Plan de reprise (revue v3, §2) : "skip" = source certainement plus
      // utile ; "try-skip" = rien ne prouve son absence, tenter le commit
      // directement, le serveur confirmera/infirmera réellement (code
      // `source_not_found`) ; "deposit" = opération neuve, dépôt normal.
      // Jamais un redépôt par défaut.
      let plan: "skip" | "try-skip" | "deposit" = "deposit";

      if (operationUuid) {
        // Reprise d'une opération déjà entamée pour CE fichier (résultat
        // précédent incertain) : lecture seule d'abord, pour PILOTER la
        // reprise selon l'état réel plutôt que de rejouer aveuglément.
        const status = await getUploadStatus({ operationUuid });
        if (!status.ok) {
          if (isConfirmedNonExistent(status.code)) {
            // Confirmé par le serveur (`not_authorized`) : cette opération
            // n'existe pas ou n'est pas la sienne — rien à perdre, l'ancien
            // operationUuid était déjà sans valeur.
            pendingOperationUuidRef.current = null;
            operationUuid = null;
          } else {
            // CORRIGÉ (revue v3, §1) : `operation_access_revoked`, une erreur
            // réseau, une session expirée ou une erreur serveur inattendue ne
            // PROUVENT jamais une inexistence — conserver l'identité, jamais
            // l'abandonner ici, sous peine de produire un second média dès
            // que la panne transitoire se résorbe.
            setError(status.message);
            return;
          }
        } else if (status.value.status === "FINALIZED") {
          // La tentative précédente avait en réalité abouti côté serveur
          // malgré un résultat incertain côté client : jamais un second média.
          shortCircuitSuccess();
          return;
        } else if (status.value.status === "ABANDONED") {
          // Réellement terminal : aucune reprise possible, un nouvel envoi
          // exige un nouveau fichier/operationUuid.
          pendingOperationUuidRef.current = null;
          setError("Cet envoi a expiré et ne peut plus être repris. Recommencez avec une nouvelle photo.");
          return;
        } else {
          // PENDING ou FINALIZING : resynchronise l'expiration de la tentative
          // (sans effet si encore valide — jamais une réouverture anticipée).
          const recovered = await recoverMediaUpload({ operationUuid });
          if (!recovered.ok) {
            if (isConfirmedNonExistent(recovered.code)) {
              pendingOperationUuidRef.current = null;
              operationUuid = null;
            } else {
              // Idem (revue v3, §1) : conserve l'identité sur toute erreur
              // incertaine, pas seulement `operation_access_revoked`.
              setError(recovered.message);
              return;
            }
          } else if (recovered.value.status === "FINALIZED") {
            shortCircuitSuccess();
            return;
          } else {
            plan = resumeUploadPlan(status.value.status, status.value.writeClaimed);
          }
        }
      }

      if (!operationUuid) {
        operationUuid = crypto.randomUUID();
        pendingOperationUuidRef.current = operationUuid;
      }
      const opId = operationUuid;

      // Étapes 1+2 : PREPARE (idempotent sur opId) + dépôt navigateur de la
      // source temporaire via URL signée (jamais la candidate).
      async function depositSource(): Promise<boolean> {
        const checksum = await sha256Hex(currentFile);
        const prepared = await prepareMediaUpload({
          projectId,
          operationUuid: opId,
          checksum,
          sizeBytes: currentFile.size,
          mimeType: currentFile.type || "application/octet-stream",
        });
        if (!prepared.ok) {
          if (prepared.code === "operation_already_finalized" || prepared.code === "operation_abandoned") {
            pendingOperationUuidRef.current = null;
          }
          setError(prepared.message);
          return false;
        }
        const browserClient = createClient();
        const { error: uploadError } = await browserClient.storage
          .from(BUCKET)
          .uploadToSignedUrl(prepared.value.path, prepared.value.token, currentFile, {
            contentType: currentFile.type || "application/octet-stream",
          });
        if (uploadError) {
          setError("Échec de l'envoi. Réessayez.");
          return false;
        }
        return true;
      }

      if (plan === "deposit") {
        const ok = await depositSource();
        if (!ok) return;
      }

      // Étape 3 : commit serveur (claim -> candidate -> attestation -> finalize).
      let committed = await commitMediaUpload({
        projectId,
        operationUuid: opId,
        origin: "IMPORTED",
        caption: caption.trim() || null,
      });
      if (!committed.ok && committed.code === "source_not_found" && plan === "try-skip") {
        // CORRIGÉ (revue v3, §2) : confirmation RÉELLE par le serveur que la
        // source n'a jamais été déposée (panne survenue avant tout dépôt
        // Storage) — seul cas où un dépôt est désormais nécessaire, jamais
        // une hypothèse de départ ni un redépôt aveugle sur le même chemin.
        const ok = await depositSource();
        if (!ok) return;
        committed = await commitMediaUpload({
          projectId,
          operationUuid: opId,
          origin: "IMPORTED",
          caption: caption.trim() || null,
        });
      }
      if (!committed.ok) {
        setError(committed.message);
        return;
      }

      shortCircuitSuccess();
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 rounded-medium border border-sand bg-surface p-4"
    >
      <label className="text-label font-semibold text-ink" htmlFor="media-file">
        Ajouter une photo de suivi
      </label>
      <input
        ref={fileInputRef}
        id="media-file"
        name="file"
        type="file"
        accept="image/jpeg,image/png,image/webp,video/mp4"
        onChange={handleFileChange}
        required
        className="text-body text-ink"
      />
      {selectedFile && error && (
        <p className="text-caption text-muted">
          Fichier retenu pour la reprise : {selectedFile.name}
        </p>
      )}
      <TextField
        label="Légende (facultatif)"
        value={caption}
        onChange={(e) => setCaption(e.target.value)}
        maxLength={200}
      />
      {error && <AlertBanner variant="error" title="Envoi impossible" explanation={error} />}
      {success && <AlertBanner variant="information" title="Photo déposée" explanation="Visible en aperçu, à publier pour l'équipe." />}
      <Button type="submit" loading={pending} disabled={pending}>
        Déposer la photo
      </Button>
    </form>
  );
}
