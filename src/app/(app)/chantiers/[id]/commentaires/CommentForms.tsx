"use client";

import { useActionState } from "react";
import { AlertBanner, Button, TextField } from "@/components/ui";
import { addCommentAction, correctCommentAction, moderateCommentAction, retractCommentAction, type CommentActionState } from "./actions";

// B023 (D191) — formulaires du fil de commentaires.

const FIELD = "w-full rounded-small border border-muted/40 bg-surface px-4 py-2 text-body font-normal text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

export type CommentSection = "journal" | "incidents";

function Feedback({ state, title }: { state: CommentActionState; title: string }) {
  return state && "error" in state ? <AlertBanner variant="error" title={title} explanation={state.error} /> : null;
}

function Context({ projectId, section }: { projectId: string; section: CommentSection }) {
  return (
    <>
      <input type="hidden" name="project_id" value={projectId} />
      <input type="hidden" name="section" value={section} />
    </>
  );
}

function Ref({ commentId, revision }: { commentId: string; revision: number }) {
  return (
    <>
      <input type="hidden" name="comment_id" value={commentId} />
      <input type="hidden" name="expected_revision" value={revision} />
    </>
  );
}

function BodyField({ defaultValue }: { defaultValue?: string }) {
  return (
    <label className="flex flex-col gap-1 text-label font-semibold text-ink">
      Commentaire
      <textarea name="body" required minLength={1} maxLength={2000} rows={3} defaultValue={defaultValue} className={FIELD} />
    </label>
  );
}

export function AddCommentForm({ projectId, section, targetType, targetId }: { projectId: string; section: CommentSection; targetType: "DAILY_LOG" | "INCIDENT"; targetId: string }) {
  const [state, formAction, pending] = useActionState<CommentActionState, FormData>(addCommentAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-2" data-testid={`ajouter-commentaire-${targetId}`}>
      <Context projectId={projectId} section={section} />
      <input type="hidden" name="target_type" value={targetType} />
      <input type="hidden" name="target_id" value={targetId} />
      <BodyField />
      <p className="text-caption text-muted">Visible de tous les membres qui voient cet élément, attribué à votre rôle.</p>
      <Feedback state={state} title="Commentaire non publié" />
      <div>
        <Button type="submit" size="compact" loading={pending}>
          Publier le commentaire
        </Button>
      </div>
    </form>
  );
}

export function CorrectCommentForm({ projectId, section, commentId, revision, body }: { projectId: string; section: CommentSection; commentId: string; revision: number; body: string }) {
  const [state, formAction, pending] = useActionState<CommentActionState, FormData>(correctCommentAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <Context projectId={projectId} section={section} />
      <Ref commentId={commentId} revision={revision} />
      <BodyField defaultValue={body} />
      <p className="text-caption text-muted">La version actuelle reste lisible dans l&apos;historique du commentaire.</p>
      <Feedback state={state} title="Correction impossible" />
      <div>
        <Button type="submit" size="compact" variant="secondary" loading={pending}>
          Enregistrer la correction
        </Button>
      </div>
    </form>
  );
}

export function RetractCommentForm({ projectId, section, commentId, revision }: { projectId: string; section: CommentSection; commentId: string; revision: number }) {
  const [state, formAction, pending] = useActionState<CommentActionState, FormData>(retractCommentAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <Context projectId={projectId} section={section} />
      <Ref commentId={commentId} revision={revision} />
      <p className="text-caption text-muted">Le texte ne sera plus affiché ; le fil indiquera que vous l&apos;avez retiré. Il reste conservé, sans suppression.</p>
      <Feedback state={state} title="Retrait impossible" />
      <div>
        <Button type="submit" size="compact" variant="danger" loading={pending}>
          Retirer mon commentaire
        </Button>
      </div>
    </form>
  );
}

export function ModerateCommentForm({ projectId, section, commentId, revision }: { projectId: string; section: CommentSection; commentId: string; revision: number }) {
  const [state, formAction, pending] = useActionState<CommentActionState, FormData>(moderateCommentAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <Context projectId={projectId} section={section} />
      <Ref commentId={commentId} revision={revision} />
      <TextField label="Motif de la modération" name="reason" required minLength={3} maxLength={1000} />
      <p className="text-caption text-muted">La modération est visible de tous ; le texte reste lisible, replié. Rien n&apos;est supprimé.</p>
      <Feedback state={state} title="Modération impossible" />
      <div>
        <Button type="submit" size="compact" variant="secondary" loading={pending}>
          Modérer
        </Button>
      </div>
    </form>
  );
}
