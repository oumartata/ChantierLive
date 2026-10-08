import Link from "next/link";
import { redirect } from "next/navigation";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { AlertBanner, Card, EmptyState, StatusChip } from "@/components/ui";
import { CorrectionForm, DailyLogForm, type DailyLogDraftView } from "./DailyLogForm";
import { getPhaseOptions, phaseLinkLabel } from "@/lib/phases/phaseOptions";
import { CommentThread } from "../commentaires/CommentThread";

// B021 (M036) + B022 (M037, D151–D156). Brouillons : visibles et modifiables
// par leur auteur SEUL (list_my_daily_log_drafts). Journaux publiés : lus
// par tout membre ACTIF du chantier, propriétaires compris
// (list_published_daily_logs, get_daily_log_history), jamais un brouillon.
// Le droit de correction (can_correct) vient du serveur et y est revérifié.

interface PublishedLog {
  daily_log_id: string;
  log_date: string;
  author_is_me: boolean;
  published_at_server: string;
  current_version_number: number;
  current_published_by_role: string;
  current_published_at_server: string;
  current_reason: string | null;
  works_done: string | null;
  difficulties: string | null;
  team: string | null;
  next_actions: string | null;
  can_correct: boolean;
  phase_id: string | null;
  phase_label: string | null;
  phase_archived: boolean | null;
}

interface LogVersion {
  id: string;
  version_number: number;
  works_done: string | null;
  difficulties: string | null;
  team: string | null;
  next_actions: string | null;
  published_by_profile_id: string;
  published_by_role: string;
  reason: string | null;
  created_at_server: string;
  phase_id: string | null;
}

const PAGE_SIZE = 20;
const ROLE_LABEL: Record<string, string> = { CONTRACTOR: "Entreprise", SITE_MANAGER: "Chef de chantier" };
const SECTIONS: { name: "works_done" | "difficulties" | "team" | "next_actions"; label: string }[] = [
  { name: "works_done", label: "Travaux réalisés" },
  { name: "difficulties", label: "Difficultés" },
  { name: "team", label: "Équipe présente" },
  { name: "next_actions", label: "Prochaines actions" },
];

function formatDay(date: string) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("fr-FR", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" });
}
// Heure serveur affichée à l'heure de Bamako (UTC).
function formatStamp(ts: string) {
  return new Date(ts).toLocaleString("fr-FR", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " (UTC)";
}

function Sections({ v }: { v: Pick<LogVersion, "works_done" | "difficulties" | "team" | "next_actions"> }) {
  return (
    <dl className="flex flex-col gap-2">
      {SECTIONS.filter((s) => v[s.name]).map((s) => (
        <div key={s.name} className="flex flex-col">
          <dt className="text-caption font-semibold text-muted">{s.label}</dt>
          <dd className="whitespace-pre-line break-words text-body text-ink">{v[s.name]}</dd>
        </div>
      ))}
    </dl>
  );
}

export default async function JournalPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { id } = await params;
  const { page: pageParam } = await searchParams;
  const user = await getVerifiedUser();
  if (!user) redirect("/connexion");

  const pageIndex = /^\d{1,4}$/.test(pageParam ?? "") ? Number(pageParam) : 0;
  const supabase = await createClient();
  const [{ data: project }, drafts, published] = await Promise.all([
    supabase.from("projects").select("id, name").eq("id", id).maybeSingle(),
    supabase.rpc("list_my_daily_log_drafts", { p_project_id: id }),
    supabase.rpc("list_published_daily_logs", { p_project_id: id, p_limit: PAGE_SIZE + 1, p_offset: pageIndex * PAGE_SIZE }),
  ]);

  if (!project || (published.error && published.error.message === "not_authorized")) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-4 p-4 sm:p-6">
        <h1 className="text-h1 font-bold text-ink">Journal</h1>
        <AlertBanner variant="warning" title="Journal non accessible" explanation="Le journal quotidien est réservé aux membres actifs de ce chantier." />
      </div>
    );
  }
  // Brouillons : seulement entreprise et chef de chantier (le refus
  // not_authorized signifie « lecteur seul », pas une erreur).
  const isAuthor = !drafts.error;
  if (published.error || (drafts.error && drafts.error.message !== "not_authorized")) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-4 p-4 sm:p-6">
        <h1 className="text-h1 font-bold text-ink">Journal</h1>
        <AlertBanner variant="error" title="Lecture impossible" explanation="Le journal n'a pas pu être lu. Réessayez plus tard." />
      </div>
    );
  }

  const draftList = (drafts.data ?? []) as DailyLogDraftView[];
  const rows = (published.data ?? []) as PublishedLog[];
  const hasMore = rows.length > PAGE_SIZE;
  const logs = rows.slice(0, PAGE_SIZE);
  // Historique : seulement pour les journaux corrigés (version > 1).
  const histories = new Map<string, LogVersion[]>();
  await Promise.all(
    logs
      .filter((l) => l.current_version_number > 1)
      .map(async (l) => {
        const { data } = await supabase.rpc("get_daily_log_history", { p_log_id: l.daily_log_id });
        histories.set(l.daily_log_id, (data ?? []) as LogVersion[]);
      })
  );
  // D182 : étapes proposées (actives, plan publié) et libellés.
  const { options: phaseOptions, labels: phaseLabels } = await getPhaseOptions(supabase, id);
  // Date du jour à Bamako (UTC, sans heure d'été) ; seulement une valeur
  // proposée, modifiable.
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-h1 font-bold text-ink">Journal — {project.name}</h1>
        <p className="text-body text-muted">
          {isAuthor
            ? "Vos brouillons ne sont visibles que par vous. Une fois publié, un journal est visible par tous les membres du chantier et ne se modifie plus que par une correction motivée."
            : "Journaux publiés par l'entreprise et le chef de chantier. Chaque correction est conservée avec son motif."}
        </p>
      </div>

      {isAuthor ? (
        <>
          <Card className="flex flex-col gap-3">
            <h2 className="text-h2 font-semibold text-ink">Nouveau brouillon</h2>
            <DailyLogForm projectId={project.id} draft={null} today={today} phases={phaseOptions} />
          </Card>

          <section className="flex flex-col gap-3">
            <h2 className="text-h2 font-semibold text-ink">Mes brouillons</h2>
            {draftList.length === 0 ? (
              <EmptyState title="Aucun brouillon" description="Vos brouillons de journal apparaîtront ici." />
            ) : (
              draftList.map((d) => (
                <Card key={`${d.id}-${d.revision}`} className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-label font-semibold text-ink">{formatDay(d.log_date)}</p>
                    <StatusChip variant="neutral" label="Brouillon" />
                  </div>
                  <DailyLogForm projectId={project.id} draft={d} today={today} phases={phaseOptions} />
                </Card>
              ))
            )}
          </section>
        </>
      ) : null}

      <section className="flex flex-col gap-3" data-testid="journaux-publies">
        <h2 className="text-h2 font-semibold text-ink">Journaux publiés</h2>
        {logs.length === 0 ? (
          <EmptyState title="Aucun journal publié" description="Les journaux publiés du chantier apparaîtront ici, du plus récent au plus ancien." />
        ) : (
          logs.map((l) => {
            const history = histories.get(l.daily_log_id) ?? [];
            return (
              <Card key={`${l.daily_log_id}-${l.current_version_number}`} className="flex flex-col gap-3" data-testid={`publie-${l.log_date}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-label font-semibold text-ink">{formatDay(l.log_date)}</p>
                  <StatusChip
                    variant={l.current_version_number > 1 ? "attention" : "success"}
                    label={l.current_version_number > 1 ? `Corrigé — version ${l.current_version_number}` : "Publié"}
                  />
                </div>
                <p className="text-caption text-muted">
                  {l.current_version_number > 1 ? "Corrigé" : "Publié"} par {ROLE_LABEL[l.current_published_by_role] ?? l.current_published_by_role}
                  {l.author_is_me && l.current_version_number === 1 ? " (vous)" : ""} le {formatStamp(l.current_published_at_server)}
                  {l.current_reason ? ` — motif : ${l.current_reason}` : ""}
                </p>
                {l.phase_id ? (
                  <p className="text-caption text-ink" data-testid="journal-etape">
                    Étape : <span className="font-semibold">{phaseLinkLabel(l.phase_id, phaseLabels, l.phase_label, l.phase_archived)}</span>
                  </p>
                ) : null}
                <Sections v={l} />
                {history.length > 1 ? (
                  <details className="rounded-small border border-muted/30 px-3 py-2">
                    <summary className="cursor-pointer text-label font-semibold text-primary">Historique ({history.length} versions)</summary>
                    <ol className="mt-3 flex flex-col gap-4">
                      {history.map((v) => (
                        <li key={v.id} className="flex flex-col gap-2 border-l-2 border-muted/30 pl-3">
                          <p className="text-caption font-semibold text-ink">
                            Version {v.version_number} — {v.version_number === 1 ? "publication" : "correction"} par {ROLE_LABEL[v.published_by_role] ?? v.published_by_role}
                            {v.published_by_profile_id === user.id ? " (vous)" : ""}, le {formatStamp(v.created_at_server)}
                          </p>
                          {v.reason ? <p className="text-caption text-muted">Motif : {v.reason}</p> : null}
                          <p className="text-caption text-muted">Étape : {phaseLinkLabel(v.phase_id, phaseLabels) ?? "aucune"}</p>
                          <Sections v={v} />
                        </li>
                      ))}
                    </ol>
                  </details>
                ) : null}
                {l.can_correct ? (
                  <details className="rounded-small border border-muted/30 px-3 py-2">
                    <summary className="cursor-pointer text-label font-semibold text-primary">Corriger ce journal</summary>
                    <div className="mt-3">
                      <CorrectionForm projectId={project.id} log={l} phases={phaseOptions} />
                    </div>
                  </details>
                ) : null}
                {/* B023 (D191) : commentaires d'un journal publié, tout membre actif. */}
                <CommentThread projectId={project.id} section="journal" targetType="DAILY_LOG" targetId={l.daily_log_id} open />
              </Card>
            );
          })
        )}
        {pageIndex > 0 || hasMore ? (
          <nav aria-label="Pages du journal" className="flex flex-wrap justify-between gap-2">
            {pageIndex > 0 ? (
              <Link href={`/chantiers/${id}/journal?page=${pageIndex - 1}`} className="text-label font-semibold text-primary">
                &larr; Plus récents
              </Link>
            ) : (
              <span />
            )}
            {hasMore ? (
              <Link href={`/chantiers/${id}/journal?page=${pageIndex + 1}`} className="text-label font-semibold text-primary">
                Plus anciens &rarr;
              </Link>
            ) : null}
          </nav>
        ) : null}
      </section>
    </div>
  );
}
