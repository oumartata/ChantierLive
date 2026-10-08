import type { ReactNode } from "react";
import { createClient } from "@/lib/supabase/server";
import { AddCommentForm, CorrectCommentForm, ModerateCommentForm, RetractCommentForm, type CommentSection } from "./CommentForms";

// B023 (M047, D191) — fil de commentaires d'un journal publié ou d'un
// incident. Tout vient de list_comments, qui revérifie que l'appelant voit
// l'élément ; le texte d'un commentaire retiré par son auteur n'est jamais
// renvoyé ; un commentaire modéré reste lisible, replié (« modération reste
// visible »). Attribution par rôle, jamais par nom (C5).

interface CommentRow {
  id: string;
  revision: number;
  author_role: string;
  author_is_me: boolean;
  author_is_former_member: boolean;
  target_version_number: number | null;
  body: string | null;
  version_number: number;
  edited: boolean;
  created_at_server: string;
  last_edited_at_server: string | null;
  retracted_at_server: string | null;
  moderated_at_server: string | null;
  moderated_by_role: string | null;
  moderated_by_me: boolean;
  moderation_reason: string | null;
  can_correct: boolean;
  can_retract: boolean;
  can_moderate: boolean;
}
interface HistoryRow {
  version_number: number;
  body: string;
  created_at_server: string;
  is_current: boolean;
}

const ROLE: Record<string, string> = {
  CONTRACTOR: "l'entreprise",
  OWNER_PRIMARY: "le propriétaire principal",
  CO_OWNER: "le copropriétaire",
  SITE_MANAGER: "le chef de chantier",
};
const roleLabel = (r: string | null) => (r ? ROLE[r] ?? r : "—");
const stamp = (ts: string) =>
  new Date(ts).toLocaleString("fr-FR", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " (UTC)";

function Fold({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="rounded-small border border-muted/30 px-3 py-2">
      <summary className="cursor-pointer text-caption font-semibold text-primary">{title}</summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}

export async function CommentThread({
  projectId,
  section,
  targetType,
  targetId,
  open,
}: {
  projectId: string;
  section: CommentSection;
  targetType: "DAILY_LOG" | "INCIDENT";
  targetId: string;
  open: boolean;
}) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_comments", { p_target_type: targetType, p_target_id: targetId });
  if (error) return <p className="text-caption text-muted">Commentaires indisponibles pour l&apos;instant.</p>;
  const rows = (data ?? []) as CommentRow[];
  const histories = new Map<string, HistoryRow[]>();
  await Promise.all(
    rows
      .filter((c) => c.edited && !c.retracted_at_server)
      .map(async (c) => {
        const { data: h } = await supabase.rpc("get_comment_history", { p_comment_id: c.id });
        histories.set(c.id, (h ?? []) as HistoryRow[]);
      })
  );

  return (
    <section className="flex flex-col gap-2 border-t border-muted/20 pt-3" data-testid={`commentaires-${targetId}`}>
      <h3 className="text-label font-semibold text-ink">Commentaires ({rows.length})</h3>
      {rows.length === 0 ? <p className="text-caption text-muted">Aucun commentaire pour l&apos;instant.</p> : null}
      <ol className="flex flex-col gap-3">
        {rows.map((c) => {
          const author = `${c.author_is_me ? "vous" : roleLabel(c.author_role)}${c.author_is_former_member ? " (ancien membre)" : ""}`;
          const history = histories.get(c.id) ?? [];
          return (
            <li key={`${c.id}-${c.revision}`} className="flex flex-col gap-1 border-l-2 border-muted/30 pl-3" data-testid={`commentaire-${c.id}`}>
              <p className="text-caption text-muted">
                Par <span className="font-semibold text-ink">{author}</span>, le {stamp(c.created_at_server)}
                {c.target_version_number ? ` — sur la version ${c.target_version_number} du journal` : ""}
                {c.edited && c.last_edited_at_server ? ` — modifié le ${stamp(c.last_edited_at_server)}` : ""}
              </p>
              {c.retracted_at_server ? (
                <p className="text-caption italic text-muted" data-testid="commentaire-retire">
                  Commentaire retiré par son auteur le {stamp(c.retracted_at_server)}.
                </p>
              ) : c.moderated_at_server ? (
                <>
                  <p className="break-words text-caption font-semibold text-ink" data-testid="commentaire-modere">
                    Modéré par {c.moderated_by_me ? "vous" : roleLabel(c.moderated_by_role)} le {stamp(c.moderated_at_server)} : {c.moderation_reason}
                  </p>
                  <Fold title="Afficher le texte modéré">
                    <p className="whitespace-pre-line break-words text-body text-ink">{c.body}</p>
                  </Fold>
                </>
              ) : (
                <p className="whitespace-pre-line break-words text-body text-ink">{c.body}</p>
              )}
              {history.length > 1 ? (
                <Fold title={`Historique (${history.length} versions)`}>
                  <ol className="flex flex-col gap-1">
                    {history.map((h) => (
                      <li key={h.version_number} className="break-words text-caption text-muted">
                        Version {h.version_number}
                        {h.is_current ? " (actuelle)" : ""}, le {stamp(h.created_at_server)} : <span className="text-ink">{h.body}</span>
                      </li>
                    ))}
                  </ol>
                </Fold>
              ) : null}
              {c.can_correct && c.body !== null ? (
                <Fold title="Corriger mon commentaire">
                  <CorrectCommentForm projectId={projectId} section={section} commentId={c.id} revision={c.revision} body={c.body} />
                </Fold>
              ) : null}
              {c.can_retract ? (
                <Fold title="Retirer mon commentaire">
                  <RetractCommentForm projectId={projectId} section={section} commentId={c.id} revision={c.revision} />
                </Fold>
              ) : null}
              {c.can_moderate ? (
                <Fold title="Modérer ce commentaire">
                  <ModerateCommentForm projectId={projectId} section={section} commentId={c.id} revision={c.revision} />
                </Fold>
              ) : null}
            </li>
          );
        })}
      </ol>
      {open ? (
        <Fold title="Ajouter un commentaire">
          <AddCommentForm projectId={projectId} section={section} targetType={targetType} targetId={targetId} />
        </Fold>
      ) : (
        <p className="text-caption text-muted">Cet élément n&apos;accepte plus de commentaire ; le fil reste lisible.</p>
      )}
    </section>
  );
}
