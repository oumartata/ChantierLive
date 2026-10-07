"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { AlertBanner, Button, ConfirmDialog, TextField } from "@/components/ui";
import { archiveDocumentAction, depositDocumentAction, publishDocumentAction, type DocumentActionState } from "./actions";
import { DOCUMENT_TYPES, VISIBILITY } from "./labels";

const FIELD = "w-full rounded-small border border-muted/40 bg-surface px-4 py-2 text-body font-normal text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

function FileInput() {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-label font-semibold text-ink">
      Fichier (PDF, JPEG, PNG ou WebP, 20 Mo au plus)
      <input type="file" name="file" required accept="application/pdf,image/jpeg,image/png,image/webp" className="w-full min-w-0 max-w-full text-body font-normal text-ink" />
    </label>
  );
}

function Feedback({ state, title, success }: { state: DocumentActionState; title: string; success?: string }) {
  if (state && "error" in state) return <AlertBanner variant="error" title={title} explanation={state.error} />;
  if (state && "ok" in state && success) return <p className="text-caption text-muted">{success}</p>;
  return null;
}

// SCR043 : dépôt en brouillon (D170) ; ENTREPRISE proposé à l'entreprise
// seulement (D169), le serveur le revérifie.
export function NewDocumentForm({ projectId, canChooseEnterprise }: { projectId: string; canChooseEnterprise: boolean }) {
  const [state, formAction, pending] = useActionState<DocumentActionState, FormData>(depositDocumentAction, null);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state && "ok" in state) formRef.current?.reset();
  }, [state]);
  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-3" data-testid="nouveau-document">
      <input type="hidden" name="project_id" value={projectId} />
      <label className="flex flex-col gap-1 text-label font-semibold text-ink">
        Type
        <select name="document_type" required defaultValue="" className={`${FIELD} h-12`}>
          <option value="" disabled>
            Choisir…
          </option>
          {DOCUMENT_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <TextField label="Titre" name="title" required minLength={3} maxLength={120} />
      <label className="flex flex-col gap-1 text-label font-semibold text-ink">
        Description (facultative)
        <textarea name="description" maxLength={500} rows={2} className={FIELD} />
      </label>
      <label className="flex flex-col gap-1 text-label font-semibold text-ink">
        Qui peut voir ce document ?
        <select name="visibility" defaultValue="PRINCIPAUX" className={`${FIELD} h-12`}>
          {Object.entries(VISIBILITY)
            .filter(([k]) => canChooseEnterprise || k !== "ENTREPRISE")
            .map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
        </select>
      </label>
      <FileInput />
      <p className="text-caption text-muted">Le document reste un brouillon visible par vous seul jusqu&apos;à sa publication. Aucune analyse antivirus n&apos;est faite.</p>
      <Feedback state={state} title="Dépôt impossible" success="Document déposé en brouillon." />
      <div>
        <Button type="submit" loading={pending}>
          Déposer le document
        </Button>
      </div>
    </form>
  );
}

// D172 : nouvelle version publiée immédiatement ; l'ancienne reste lisible.
export function NewVersionForm({ projectId, documentId }: { projectId: string; documentId: string }) {
  const [state, formAction, pending] = useActionState<DocumentActionState, FormData>(depositDocumentAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="project_id" value={projectId} />
      <input type="hidden" name="document_id" value={documentId} />
      <FileInput />
      <p className="text-caption text-muted">La nouvelle version est publiée tout de suite, avec le même type et la même visibilité. L&apos;ancienne version reste consultable.</p>
      <Feedback state={state} title="Nouvelle version impossible" />
      <div>
        <Button type="submit" size="compact" loading={pending}>
          Publier la nouvelle version
        </Button>
      </div>
    </form>
  );
}

// D173 : la confirmation dit exactement qui verra le document.
export function PublishDocumentButton({ projectId, documentId, revision, visibility }: { projectId: string; documentId: string; revision: number; visibility: string }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const audience = VISIBILITY[visibility]?.audience ?? visibility;
  return (
    <>
      <Button type="button" size="compact" loading={pending} onClick={() => setOpen(true)}>
        Publier
      </Button>
      {error ? <AlertBanner variant="error" title="Publication impossible" explanation={error} /> : null}
      <ConfirmDialog
        open={open}
        title="Publier ce document ?"
        consequence={`Il sera visible par ${audience}.`}
        permanence="La visibilité ne pourra plus être modifiée après publication. Les nouvelles versions garderont la même visibilité."
        confirmLabel="Publier"
        onCancel={() => setOpen(false)}
        onConfirm={() => {
          setOpen(false);
          startTransition(async () => {
            const result = await publishDocumentAction(projectId, documentId, revision);
            if (result && "error" in result) setError(result.error);
          });
        }}
      />
    </>
  );
}

// D174 : archivage motivé ; versions toujours consultables.
export function ArchiveDocumentForm({ projectId, documentId, revision }: { projectId: string; documentId: string; revision: number }) {
  const [state, formAction, pending] = useActionState<DocumentActionState, FormData>(archiveDocumentAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="project_id" value={projectId} />
      <input type="hidden" name="document_id" value={documentId} />
      <input type="hidden" name="expected_revision" value={revision} />
      <TextField label="Motif de l'archivage" name="reason" required minLength={3} maxLength={1000} />
      <p className="text-caption text-muted">Le document sort de la liste active ; il n&apos;est jamais supprimé et ses versions restent consultables.</p>
      <Feedback state={state} title="Archivage impossible" />
      <div>
        <Button type="submit" size="compact" variant="secondary" loading={pending}>
          Archiver
        </Button>
      </div>
    </form>
  );
}
