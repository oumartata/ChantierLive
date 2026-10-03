import { redirect } from "next/navigation";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { AlertBanner, Card, StatusChip } from "@/components/ui";
import { DraftEditor, ProgressForm, RestructureToggle, DEFAULT_ROWS, type Row } from "./PhasePlanForms";

interface PlanView {
  plan_id: string | null;
  project_id: string;
  status: "ABSENT" | "BROUILLON" | "PUBLIE";
  revision: number | null;
  published_at_server: string | null;
  published_by_profile_id: string | null;
  global_progress: string | number | null;
  last_event_at: string | null;
  last_event_by_role: "CONTRACTOR" | "SITE_MANAGER" | null;
}
interface PhaseRow {
  phase_id: string;
  position: number;
  label: string;
  weight: string | number;
  progression: string | number;
}
interface EventRow {
  event_seq: number;
  event_type: "PLAN_PUBLISHED" | "PROGRESSION_UPDATED" | "STRUCTURE_CHANGED";
  phase_id: string | null;
  phase_label: string | null;
  actor_role: "CONTRACTOR" | "SITE_MANAGER";
  reason: string | null;
  computed_global_progress: string | number;
  created_at_server: string;
}

const EVENT_LABEL: Record<EventRow["event_type"], string> = {
  PLAN_PUBLISHED: "Plan des étapes publié",
  PROGRESSION_UPDATED: "Progression mise à jour",
  STRUCTURE_CHANGED: "Étapes ou poids modifiés",
};
const ACTOR_LABEL: Record<string, string> = { CONTRACTOR: "l'entreprise", SITE_MANAGER: "le chef de chantier" };

function Unavailable({ title, explanation }: { title: string; explanation: string }) {
  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-h1 font-bold text-ink">Avancement</h1>
      <AlertBanner variant="warning" title={title} explanation={explanation} />
    </div>
  );
}

// M033 — Avancement des travaux. Étapes personnalisables (modèle par
// défaut à 6 étapes, défini côté application — jamais une table de
// modèles réutilisables, hors périmètre de ce lot), poids totalisant
// exactement 100 % avant publication, progression 0-100 % par étape,
// avancement global = Σ(poids×progression)/100, calculé et vérifié
// côté serveur uniquement. Affiché au propriétaire comme « déclaré par
// l'entreprise » : aucune validation par le propriétaire dans ce lot
// (PHASE_VALIDATE hors périmètre, non implémenté).
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

  const [planRes, phasesRes, eventsRes] = await Promise.all([
    supabase.rpc("get_project_phase_plan", { p_project_id: id }),
    supabase.rpc("list_project_phases", { p_project_id: id }),
    supabase.rpc("list_phase_events", { p_project_id: id }),
  ]);
  if (planRes.error || phasesRes.error || eventsRes.error) {
    return <Unavailable title="Lecture impossible" explanation="Réessayez plus tard." />;
  }
  const plan: PlanView = Array.isArray(planRes.data) ? planRes.data[0] : planRes.data;
  const phases: PhaseRow[] = phasesRes.data ?? [];
  const events: EventRow[] = eventsRes.data ?? [];

  const isContractor = membership.role === "CONTRACTOR";
  let canUpdateProgress = isContractor;
  if (!canUpdateProgress && membership.role === "SITE_MANAGER") {
    const { data } = await supabase.rpc("has_project_permission", { p_project_uuid: id, p_permission_code: "PHASE_UPDATE_PROGRESS" });
    canUpdateProgress = data === true;
  }

  const toRows = (): Row[] =>
    phases.map((p) => ({ phaseId: p.phase_id, label: p.label, weight: String(p.weight), progression: Number(p.progression) }));

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-h1 font-bold text-ink">Avancement — {project.name}</h1>

      {plan.status === "ABSENT" || plan.status === "BROUILLON" ? (
        isContractor ? (
          <>
            <AlertBanner
              variant="information"
              title="Plan des étapes en brouillon"
              explanation="Personnalisez les étapes et leurs poids (modèle par défaut proposé). La somme des poids doit être exactement 100 % avant publication. Aucun pourcentage d'avancement n'est affiché au propriétaire tant que le plan n'est pas publié."
            />
            <DraftEditor projectId={id} expectedRevision={plan.revision ?? 0} initialRows={phases.length > 0 ? toRows() : DEFAULT_ROWS} />
          </>
        ) : (
          <AlertBanner
            variant="information"
            title="Avancement pas encore publié"
            explanation="L'entreprise n'a pas encore publié le plan des étapes de ce chantier."
          />
        )
      ) : (
        <>
          <Card className="flex flex-col gap-2" data-testid="global-progress">
            <h2 className="text-h2 font-semibold text-ink">Avancement déclaré par l&apos;entreprise</h2>
            <p className="text-display font-bold text-ink">{Math.round(Number(plan.global_progress) * 100) / 100} %</p>
            {plan.last_event_at ? (
              <p className="text-caption text-muted">
                Dernière mise à jour le {new Date(plan.last_event_at).toLocaleString("fr-FR")}
                {plan.last_event_by_role ? ` par ${ACTOR_LABEL[plan.last_event_by_role]}` : ""}.
              </p>
            ) : null}
            <StatusChip variant="info" label="Déclaré par l'entreprise — aucune validation automatique" className="self-start" />
          </Card>

          <Card className="flex flex-col gap-4">
            <h2 className="text-h2 font-semibold text-ink">Étapes</h2>
            {phases.map((p) => (
              <ProgressForm
                key={p.phase_id}
                projectId={id}
                phaseId={p.phase_id}
                label={`${p.label} (poids ${p.weight} %)`}
                expectedRevision={plan.revision ?? 0}
                initialProgression={Number(p.progression)}
                canEdit={canUpdateProgress}
              />
            ))}
          </Card>

          {isContractor ? <RestructureToggle projectId={id} expectedRevision={plan.revision ?? 0} initialRows={toRows()} /> : null}

          <Card className="flex flex-col gap-2">
            <h2 className="text-h2 font-semibold text-ink">Historique</h2>
            {events.length === 0 ? (
              <p className="text-body text-muted">Aucun événement.</p>
            ) : (
              <ol className="flex flex-col gap-2" data-testid="history">
                {events.map((e) => (
                  <li key={e.event_seq} className="text-caption text-ink">
                    n° {e.event_seq} — {EVENT_LABEL[e.event_type]}
                    {e.phase_label ? ` (${e.phase_label})` : ""} par {ACTOR_LABEL[e.actor_role]}
                    {e.reason ? ` — motif : ${e.reason}` : ""} — avancement global à cet instant :{" "}
                    {Math.round(Number(e.computed_global_progress) * 100) / 100} % · {new Date(e.created_at_server).toLocaleString("fr-FR")}
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
