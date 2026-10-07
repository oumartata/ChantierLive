import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { AlertBanner, Card, StatusChip } from "@/components/ui";
import type { StatusChipVariant } from "@/components/ui/StatusChip";
import { DecisionForm, DeclareCompleteForm, DraftEditor, ProgressForm, RestructureToggle, ScheduleForm, DEFAULT_ROWS, type Row } from "./PhasePlanForms";
import { formatPercent } from "./phasePlanDiff";
import { FIELD_LABEL, KIND_LABEL, buildPhaseHistories, formatHistoryValue, type PhaseHistoryEntry } from "./phaseHistory";

// B020 : versions antérieures visibles — chaque modification d'une étape,
// état précédent -> nouvel état, rôle, date et motif ; lecture seule, pour
// tout membre actif (même source que l'historique général).
function PhaseHistory({ entries }: { entries: PhaseHistoryEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <details className="rounded-small border border-muted/30 px-3 py-2" data-testid="historique-etape">
      <summary className="cursor-pointer text-label font-semibold text-primary">Historique de l&apos;étape ({entries.length})</summary>
      <ol className="mt-3 flex flex-col gap-3">
        {[...entries].reverse().map((h) => (
          <li key={h.seq} className="flex flex-col gap-1 border-l-2 border-muted/30 pl-3">
            <p className="text-caption font-semibold text-ink">
              {KIND_LABEL[h.kind]} — par {ACTOR_LABEL[h.actorRole] ?? h.actorRole}, le {stamp(h.at)}
            </p>
            {h.changes.length > 0 ? (
              <ul className="flex flex-col gap-0.5">
                {h.changes.map((c) => (
                  <li key={c.field} className="break-words text-caption text-muted">
                    {FIELD_LABEL[c.field]} : {formatHistoryValue(c.field, c.before)} → {formatHistoryValue(c.field, c.after)}
                  </li>
                ))}
              </ul>
            ) : null}
            {h.reason ? <p className="break-words text-caption text-muted">Motif : {h.reason}</p> : null}
          </li>
        ))}
      </ol>
    </details>
  );
}

interface PlanView {
  plan_id: string | null;
  project_id: string;
  status: "ABSENT" | "BROUILLON" | "PUBLIE";
  revision: number | null;
  published_at_server: string | null;
  published_by_profile_id: string | null;
  global_progress: string | number | null;
  last_event_at: string | null;
  last_event_by_role: "CONTRACTOR" | "SITE_MANAGER" | "OWNER" | null;
}
interface PhaseDetail {
  phase_id: string;
  position: number;
  label: string;
  weight: string | number;
  progression: string | number;
  status: "BROUILLON" | "PUBLIEE" | "TERMINEE" | "VALIDEE" | "REFUSEE";
  planned_start: string | null;
  planned_end: string | null;
  started_at: string | null;
  declared_completed_at: string | null;
  validated_at: string | null;
  refused_at: string | null;
  last_refusal_reason: string | null;
  can_declare: boolean;
  can_decide: boolean;
  can_edit_schedule: boolean;
}
interface ValidatedProgress {
  applicable_count: number;
  validated_count: number;
  validated_progress: string | number | null;
  computable: boolean;
}
interface EventRow {
  event_seq: number;
  event_type: keyof typeof EVENT_LABEL;
  phase_id: string | null;
  phase_label: string | null;
  previous_value: unknown;
  new_value: unknown;
  actor_role: "CONTRACTOR" | "SITE_MANAGER" | "OWNER";
  reason: string | null;
  computed_global_progress: string | number;
  computed_validated_progress: string | number | null;
  created_at_server: string;
}

const EVENT_LABEL = {
  PLAN_PUBLISHED: "Plan des étapes publié",
  PROGRESSION_UPDATED: "Progression mise à jour",
  STRUCTURE_CHANGED: "Étapes ou poids modifiés",
  PHASE_DECLARED_COMPLETE: "Étape déclarée terminée",
  PHASE_VALIDATED: "Étape validée",
  PHASE_REFUSED: "Étape refusée",
  PHASE_SCHEDULE_CHANGED: "Dates prévues modifiées",
} as const;
const ACTOR_LABEL: Record<string, string> = { CONTRACTOR: "l'entreprise", SITE_MANAGER: "le chef de chantier", OWNER: "le propriétaire" };
const STATUS: Record<PhaseDetail["status"], { label: string; chip: StatusChipVariant }> = {
  BROUILLON: { label: "Brouillon", chip: "neutral" },
  PUBLIEE: { label: "Publiée", chip: "info" },
  TERMINEE: { label: "Déclarée terminée", chip: "attention" },
  VALIDEE: { label: "Validée", chip: "success" },
  REFUSEE: { label: "Refusée", chip: "danger" },
};

// Dates serveur à l'heure de Bamako (UTC).
const day = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString("fr-FR", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });
const stamp = (ts: string) =>
  new Date(ts).toLocaleString("fr-FR", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " (UTC)";

function Unavailable({ title, explanation }: { title: string; explanation: string }) {
  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-h1 font-bold text-ink">Avancement</h1>
      <AlertBanner variant="warning" title={title} explanation={explanation} />
    </div>
  );
}

function Action({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="rounded-small border border-muted/30 px-3 py-2">
      <summary className="cursor-pointer text-label font-semibold text-primary">{title}</summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

// M033 + M040 (B019/B020, D177, D179). Deux mesures distinctes, jamais
// fusionnées : « Avancement déclaré par l'entreprise » (pondéré, M033) et
// « Avancement validé » (étapes validées / étapes applicables, BR034).
// Chaque action n'est proposée que si le serveur l'autorise (can_*), et y
// est revérifiée.
export default async function AvancementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getVerifiedUser();
  if (!user) {
    redirect("/connexion");
  }

  const supabase = await createClient();
  const [{ data: project }, { data: membership }] = await Promise.all([
    supabase.from("projects").select("id, name").eq("id", id).maybeSingle(),
    supabase.from("project_memberships").select("role").eq("project_id", id).eq("profile_id", user.id).is("revoked_at", null).maybeSingle(),
  ]);

  if (!project || !membership) {
    return <Unavailable title="Chantier inaccessible" explanation="Ce chantier n'existe pas ou vous n'y avez pas accès." />;
  }

  const [planRes, phasesRes, eventsRes, validatedRes] = await Promise.all([
    supabase.rpc("get_project_phase_plan", { p_project_id: id }),
    supabase.rpc("list_project_phase_details", { p_project_id: id }),
    supabase.rpc("list_phase_event_details", { p_project_id: id }),
    supabase.rpc("get_project_validated_progress", { p_project_id: id }),
  ]);
  if (planRes.error || phasesRes.error || eventsRes.error || validatedRes.error) {
    return <Unavailable title="Lecture impossible" explanation="Réessayez plus tard." />;
  }
  const plan: PlanView = Array.isArray(planRes.data) ? planRes.data[0] : planRes.data;
  const phases: PhaseDetail[] = phasesRes.data ?? [];
  const events: EventRow[] = eventsRes.data ?? [];
  const validated: ValidatedProgress = Array.isArray(validatedRes.data) ? validatedRes.data[0] : validatedRes.data;

  const isContractor = membership.role === "CONTRACTOR";
  let canUpdateProgress = isContractor;
  if (!canUpdateProgress && membership.role === "SITE_MANAGER") {
    const { data } = await supabase.rpc("has_project_permission", { p_project_uuid: id, p_permission_code: "PHASE_UPDATE_PROGRESS" });
    canUpdateProgress = data === true;
  }
  const revision = plan.revision ?? 0;
  // D177 : la date de la mesure déclarée ne vient que des événements qui la
  // font varier (publication, progression, restructuration), jamais d'une
  // déclaration, d'une décision du propriétaire ou d'un changement de dates.
  const lastDeclared = [...events].reverse().find((e) => e.event_type === "PLAN_PUBLISHED" || e.event_type === "PROGRESSION_UPDATED" || e.event_type === "STRUCTURE_CHANGED");
  const lastValidated = [...events].reverse().find((e) => e.event_type === "PHASE_VALIDATED");
  const histories = buildPhaseHistories(events);

  const toRows = (): Row[] =>
    phases.map((p) => ({
      phaseId: p.phase_id,
      label: p.label,
      weight: String(p.weight),
      progression: Number(p.progression),
      plannedStart: p.planned_start ?? "",
      plannedEnd: p.planned_end ?? "",
      locked: p.status === "VALIDEE",
    }));

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 sm:p-6">
      <h1 className="text-h1 font-bold text-ink">Avancement — {project.name}</h1>

      {plan.status === "ABSENT" || plan.status === "BROUILLON" ? (
        <>
          {isContractor ? (
            <>
              <AlertBanner
                variant="information"
                title="Plan des étapes en brouillon"
                explanation="Personnalisez les étapes, leurs poids et, si vous le souhaitez, leurs dates prévues (modèle par défaut proposé). La somme des poids doit être exactement 100 % avant publication. Rien n'est affiché au propriétaire tant que le plan n'est pas publié."
              />
              <DraftEditor projectId={id} expectedRevision={revision} initialRows={phases.length > 0 ? toRows() : DEFAULT_ROWS} />
            </>
          ) : (
            <AlertBanner variant="information" title="Avancement pas encore publié" explanation="L'entreprise n'a pas encore publié le plan des étapes de ce chantier." />
          )}
          {/* EC020 : aucune étape applicable — jamais 0 ni 100 %. */}
          <Card className="flex flex-col gap-1" data-testid="validated-progress">
            <h2 className="text-h2 font-semibold text-ink">Avancement validé</h2>
            <p className="text-body text-muted">Non calculable : aucune étape publiée.</p>
          </Card>
        </>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Card className="flex flex-col gap-2" data-testid="global-progress">
              <h2 className="text-h2 font-semibold text-ink">Avancement déclaré par l&apos;entreprise</h2>
              <p className="text-display font-bold text-ink">{formatPercent(plan.global_progress)}</p>
              <p className="text-caption text-muted">Moyenne des progressions déclarées, pondérée par le poids de chaque étape.</p>
              {lastDeclared ? (
                <p className="text-caption text-muted">
                  Dernière mise à jour le {stamp(lastDeclared.created_at_server)} par {ACTOR_LABEL[lastDeclared.actor_role]}.
                </p>
              ) : null}
              <StatusChip variant="info" label="Déclaré — aucune validation automatique" className="self-start" />
            </Card>
            <Card className="flex flex-col gap-2" data-testid="validated-progress">
              <h2 className="text-h2 font-semibold text-ink">Avancement validé</h2>
              {validated.computable ? (
                <>
                  <p className="text-display font-bold text-ink">{formatPercent(validated.validated_progress)}</p>
                  <p className="text-caption text-muted">
                    {validated.validated_count} étape{validated.validated_count > 1 ? "s" : ""} validée{validated.validated_count > 1 ? "s" : ""} par le propriétaire sur{" "}
                    {validated.applicable_count} étape{validated.applicable_count > 1 ? "s" : ""} publiée{validated.applicable_count > 1 ? "s" : ""}.
                  </p>
                  {lastValidated ? <p className="text-caption text-muted">Dernière validation le {stamp(lastValidated.created_at_server)}.</p> : null}
                </>
              ) : (
                <p className="text-body text-muted">Non calculable : aucune étape applicable.</p>
              )}
              <StatusChip variant="success" label="Validé par le propriétaire" className="self-start" />
            </Card>
          </div>

          <Card className="flex flex-col gap-4">
            <h2 className="text-h2 font-semibold text-ink">Étapes</h2>
            {phases.map((p) => {
              const st = STATUS[p.status];
              return (
                <div key={`${p.phase_id}-${revision}`} className="flex flex-col gap-2 border-b border-muted/20 pb-4 last:border-b-0 last:pb-0" data-testid={`etape-${p.position}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="break-words text-label font-semibold text-ink">
                      {p.position}. {p.label} <span className="font-normal text-muted">(poids {formatPercent(p.weight)})</span>
                    </p>
                    <StatusChip variant={st.chip} label={st.label} />
                  </div>
                  <dl className="grid grid-cols-1 gap-1 text-caption text-muted sm:grid-cols-2">
                    <div>
                      <dt className="inline font-semibold">Prévu : </dt>
                      <dd className="inline">
                        {p.planned_start ? `du ${day(p.planned_start)}` : "début non prévu"}
                        {p.planned_end ? ` au ${day(p.planned_end)}` : ""}
                      </dd>
                    </div>
                    {p.started_at ? (
                      <div>
                        <dt className="inline font-semibold">Commencée le : </dt>
                        <dd className="inline">{stamp(p.started_at)}</dd>
                      </div>
                    ) : null}
                    {p.declared_completed_at ? (
                      <div>
                        <dt className="inline font-semibold">Déclarée terminée le : </dt>
                        <dd className="inline">{stamp(p.declared_completed_at)}</dd>
                      </div>
                    ) : null}
                    {p.validated_at ? (
                      <div>
                        <dt className="inline font-semibold">Validée le : </dt>
                        <dd className="inline">{stamp(p.validated_at)}</dd>
                      </div>
                    ) : null}
                  </dl>
                  {p.status === "REFUSEE" && p.last_refusal_reason ? (
                    <p className="break-words text-caption text-danger">
                      Refusée le {p.refused_at ? stamp(p.refused_at) : "—"} — motif : {p.last_refusal_reason}
                    </p>
                  ) : null}
                  <ProgressForm
                    projectId={id}
                    phaseId={p.phase_id}
                    label="Progression déclarée"
                    expectedRevision={revision}
                    initialProgression={Number(p.progression)}
                    canEdit={canUpdateProgress && p.status !== "VALIDEE"}
                  />
                  {p.can_declare ? <DeclareCompleteForm projectId={id} phaseId={p.phase_id} expectedRevision={revision} label={p.label} /> : null}
                  {p.can_decide ? <DecisionForm projectId={id} phaseId={p.phase_id} expectedRevision={revision} /> : null}
                  {p.can_edit_schedule ? (
                    <Action title="Modifier les dates prévues">
                      <ScheduleForm projectId={id} phaseId={p.phase_id} expectedRevision={revision} plannedStart={p.planned_start} plannedEnd={p.planned_end} />
                    </Action>
                  ) : null}
                  <PhaseHistory entries={histories.get(p.phase_id) ?? []} />
                </div>
              );
            })}
          </Card>

          {isContractor ? <RestructureToggle projectId={id} expectedRevision={revision} initialRows={toRows()} /> : null}

          <Card className="flex flex-col gap-2">
            <h2 className="text-h2 font-semibold text-ink">Historique</h2>
            {events.length === 0 ? (
              <p className="text-body text-muted">Aucun événement.</p>
            ) : (
              <ol className="flex flex-col gap-2" data-testid="history">
                {events.map((e) => (
                  <li key={e.event_seq} className="break-words text-caption text-ink">
                    n° {e.event_seq} — {EVENT_LABEL[e.event_type] ?? e.event_type}
                    {e.phase_label ? ` (${e.phase_label})` : ""} par {ACTOR_LABEL[e.actor_role]}
                    {e.reason ? ` — motif : ${e.reason}` : ""} — à cet instant : déclaré {formatPercent(e.computed_global_progress)}
                    {e.computed_validated_progress !== null ? `, validé ${formatPercent(e.computed_validated_progress)}` : ""} · {stamp(e.created_at_server)}
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
