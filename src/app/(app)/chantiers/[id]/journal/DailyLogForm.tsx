"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { AlertBanner, Button, ConfirmDialog, TextField } from "@/components/ui";
import { archiveDailyLogDraftAction, createDailyLogDraftAction, updateDailyLogDraftAction, type JournalActionState } from "./actions";

export interface DailyLogDraftView {
  id: string;
  log_date: string;
  works_done: string | null;
  difficulties: string | null;
  team: string | null;
  next_actions: string | null;
  revision: number;
  updated_at_server: string;
}

const FIELDS: { name: "works_done" | "difficulties" | "team" | "next_actions"; label: string }[] = [
  { name: "works_done", label: "Travaux réalisés" },
  { name: "difficulties", label: "Difficultés" },
  { name: "team", label: "Équipe présente" },
  { name: "next_actions", label: "Prochaines actions" },
];

// Zone de texte multiligne : même présentation que TextField (aucun
// composant multiligne dans src/components/ui).
function TextArea({ name, label, defaultValue }: { name: string; label: string; defaultValue: string }) {
  return (
    <label className="flex flex-col gap-1 text-label font-semibold text-ink">
      {label}
      <textarea
        name={name}
        defaultValue={defaultValue}
        maxLength={4000}
        rows={3}
        className="w-full rounded-small border border-muted/40 bg-surface px-4 py-2 text-body font-normal text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      />
    </label>
  );
}

// Formulaire de création (draft absent) ou de modification d'un brouillon.
// Aucun champ de contenu obligatoire (AC053) ; la date est requise.
export function DailyLogForm({ projectId, draft, today }: { projectId: string; draft: DailyLogDraftView | null; today: string }) {
  const [state, formAction, pending] = useActionState<JournalActionState, FormData>(
    draft ? updateDailyLogDraftAction : createDailyLogDraftAction,
    null
  );
  const saved = state && "ok" in state;
  const formRef = useRef<HTMLFormElement>(null);
  // Création réussie : formulaire vidé (aucune double soumission involontaire).
  useEffect(() => {
    if (saved && !draft) formRef.current?.reset();
  }, [saved, draft, state]);
  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-3" data-testid={draft ? `brouillon-${draft.log_date}` : "nouveau-brouillon"}>
      <input type="hidden" name="project_id" value={projectId} />
      {draft ? (
        <>
          <input type="hidden" name="log_id" value={draft.id} />
          <input type="hidden" name="expected_revision" value={draft.revision} />
        </>
      ) : null}
      <TextField label="Date du journal" name="log_date" type="date" required defaultValue={draft?.log_date ?? today} />
      {FIELDS.map((f) => (
        <TextArea key={f.name} name={f.name} label={f.label} defaultValue={draft?.[f.name] ?? ""} />
      ))}
      {state && "error" in state ? <AlertBanner variant="error" title="Enregistrement impossible" explanation={state.error} /> : null}
      {saved ? <p className="text-caption text-muted">Brouillon enregistré.</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="compact" loading={pending}>
          {draft ? "Enregistrer les modifications" : "Créer le brouillon"}
        </Button>
        {draft ? <ArchiveButton projectId={projectId} draft={draft} /> : null}
      </div>
    </form>
  );
}

function ArchiveButton({ projectId, draft }: { projectId: string; draft: DailyLogDraftView }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <>
      <Button type="button" variant="secondary" size="compact" loading={pending} onClick={() => setOpen(true)}>
        Supprimer ce brouillon
      </Button>
      {error ? <AlertBanner variant="error" title="Suppression impossible" explanation={error} /> : null}
      <ConfirmDialog
        open={open}
        title="Supprimer ce brouillon ?"
        consequence="Le brouillon disparaît de votre liste. Il est archivé, pas effacé : une trace est conservée."
        permanence="Un brouillon archivé ne peut plus être modifié ni rouvert ; vous pourrez en créer un nouveau pour cette date."
        confirmLabel="Supprimer"
        onCancel={() => setOpen(false)}
        onConfirm={() => {
          setOpen(false);
          startTransition(async () => {
            const result = await archiveDailyLogDraftAction(projectId, draft.id, draft.revision);
            if (result && "error" in result) setError(result.error);
          });
        }}
      />
    </>
  );
}
