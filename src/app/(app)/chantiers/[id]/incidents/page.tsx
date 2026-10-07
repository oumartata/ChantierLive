import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { AlertBanner, Card, EmptyState, StatusChip } from "@/components/ui";
import { buttonClassName } from "@/components/ui/Button";
import {
  AssignIncidentForm,
  CloseIncidentButton,
  CorrectIncidentForm,
  TransitionForm,
  type IncidentView,
  type MemberOption,
} from "./IncidentForms";
import { STATUS, formatDay, formatStamp, roleLabel, severityOf, typeLabel } from "./labels";
import { getPhaseOptions, phaseLinkLabel } from "@/lib/phases/phaseOptions";

// SCR042 — B024 (M038/M038b/M038c, D159–D167). Lecture par tout membre
// actif, propriétaires compris (list_project_incidents) ; chaque action
// n'est proposée que si le serveur l'autorise (can_update, can_close,
// can_assign), et y est revérifiée.

interface IncidentRow extends IncidentView {
  reporter_role: string;
  reporter_owner_profile: string | null;
  reporter_is_me: boolean;
  assignee_role: string | null;
  assignee_owner_profile: string | null;
  assignee_is_me: boolean;
  resolution: string | null;
  linked_incident_id: string | null;
  created_at_server: string;
  closed_at_server: string | null;
  phase_label: string | null;
  phase_archived: boolean | null;
}

interface IncidentEvent {
  id: string;
  event_type: "CREATION" | "CORRECTION" | "DESIGNATION" | "TRANSITION";
  actor_profile_id: string;
  actor_role: string;
  actor_owner_profile: string | null;
  from_status: string | null;
  to_status: string | null;
  changes: Record<string, { old: unknown; new: unknown } | unknown>;
  reason: string | null;
  created_at_server: string;
}

const FIELD_LABEL: Record<string, string> = { incident_type: "Type", severity: "Gravité", occurred_at: "Date", description: "Description", phase_id: "Étape" };

function fieldValue(field: string, v: unknown, phaseLabels?: Map<string, string>): string {
  if (v === null || v === undefined || v === "") return field === "phase_id" ? "aucune" : "—";
  if (field === "phase_id") return phaseLinkLabel(String(v), phaseLabels ?? new Map()) ?? "aucune";
  if (field === "incident_type") return typeLabel(String(v));
  if (field === "severity") return severityOf(String(v)).label;
  if (field === "occurred_at") return formatStamp(String(v));
  return String(v);
}

function EventLine({ e, memberLabel, me, phaseLabels }: { e: IncidentEvent; memberLabel: (id: string | null) => string; me: string; phaseLabels: Map<string, string> }) {
  const who = `${roleLabel(e.actor_role, e.actor_owner_profile)}${e.actor_profile_id === me ? " (vous)" : ""}`;
  const changes = e.changes as Record<string, { old: unknown; new: unknown }>;
  let what: string;
  if (e.event_type === "CREATION") what = "Déclaration";
  else if (e.event_type === "CORRECTION") what = "Correction";
  else if (e.event_type === "DESIGNATION") what = "Désignation";
  else what = `${STATUS[e.from_status ?? ""]?.label ?? e.from_status} → ${STATUS[e.to_status ?? ""]?.label ?? e.to_status}`;
  return (
    <li className="flex flex-col gap-1 border-l-2 border-muted/30 pl-3">
      <p className="text-caption font-semibold text-ink">
        {what} — {who}, le {formatStamp(e.created_at_server)}
      </p>
      {e.event_type === "CORRECTION"
        ? Object.entries(changes).map(([k, c]) => (
            <p key={k} className="break-words text-caption text-muted">
              {FIELD_LABEL[k] ?? k} : {fieldValue(k, c.old, phaseLabels)} → {fieldValue(k, c.new, phaseLabels)}
            </p>
          ))
        : null}
      {e.event_type === "DESIGNATION" ? (
        <p className="text-caption text-muted">
          Responsable : {memberLabel((changes.assignee_profile_id?.new as string) ?? null)}
          {changes.due_date?.new ? `, échéance le ${formatDay(String(changes.due_date.new))}` : ", sans échéance"}
        </p>
      ) : null}
      {e.event_type === "TRANSITION" && changes.resolution?.new ? (
        <p className="break-words text-caption text-muted">Résolution : {String(changes.resolution.new)}</p>
      ) : null}
      {e.reason ? <p className="break-words text-caption text-muted">Motif : {e.reason}</p> : null}
    </li>
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

export default async function IncidentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getVerifiedUser();
  if (!user) redirect("/connexion");

  const supabase = await createClient();
  const [{ data: project }, incidents, { data: memberRows }] = await Promise.all([
    supabase.from("projects").select("id, name").eq("id", id).maybeSingle(),
    supabase.rpc("list_project_incidents", { p_project_id: id, p_limit: 100 }),
    supabase.from("project_memberships").select("profile_id, role, owner_profile").eq("project_id", id).is("revoked_at", null),
  ]);

  if (!project || (incidents.error && incidents.error.message === "not_authorized")) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-4 p-4 sm:p-6">
        <h1 className="text-h1 font-bold text-ink">Incidents</h1>
        <AlertBanner variant="warning" title="Incidents non accessibles" explanation="Les incidents sont réservés aux membres actifs de ce chantier." />
      </div>
    );
  }
  if (incidents.error) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-4 p-4 sm:p-6">
        <h1 className="text-h1 font-bold text-ink">Incidents</h1>
        <AlertBanner variant="error" title="Lecture impossible" explanation="Les incidents n'ont pas pu être lus. Réessayez plus tard." />
      </div>
    );
  }

  const rows = (incidents.data ?? []) as IncidentRow[];
  // Membres actifs, désignés par leur rôle (les profils n'ont pas de nom) ;
  // numérotés quand un rôle se répète.
  const members: MemberOption[] = [];
  const counts = new Map<string, number>();
  for (const m of (memberRows ?? []) as { profile_id: string; role: string; owner_profile: string | null }[]) {
    if (!["OWNER", "CONTRACTOR", "SITE_MANAGER"].includes(m.role)) continue;
    const base = roleLabel(m.role, m.owner_profile);
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    members.push({ profile_id: m.profile_id, label: `${base}${n > 1 ? ` ${n}` : ""}${m.profile_id === user.id ? " (vous)" : ""}` });
  }
  const memberLabel = (pid: string | null) => (pid ? members.find((m) => m.profile_id === pid)?.label ?? "Ancien membre" : "aucun");
  const histories = new Map<string, IncidentEvent[]>();
  await Promise.all(
    rows.map(async (r) => {
      const { data } = await supabase.rpc("get_incident_history", { p_incident_id: r.id });
      histories.set(r.id, (data ?? []) as IncidentEvent[]);
    })
  );
  const now = new Date().toISOString().slice(0, 16);
  // D182 : étapes proposées (actives, plan publié) et libellés.
  const { options: phaseOptions, labels: phaseLabels } = await getPhaseOptions(supabase, id);
  const open = rows.filter((r) => !["CLOS", "ANNULE"].includes(r.status)).length;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-col gap-3">
        <h1 className="text-h1 font-bold text-ink">Incidents — {project.name}</h1>
        <p className="text-body text-muted">
          {rows.length === 0 ? "Aucun incident signalé." : `${open} en cours de traitement sur ${rows.length} au total.`} Chaque changement est conservé dans l&apos;historique.
        </p>
        <div>
          <Link href={`/chantiers/${id}/incidents/nouveau`} className={buttonClassName("primary", "regular")}>
            Signaler un incident
          </Link>
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState title="Aucun incident" description="Les incidents signalés sur ce chantier apparaîtront ici." />
      ) : (
        rows.map((r) => {
          const sev = severityOf(r.severity);
          const st = STATUS[r.status] ?? { label: r.status, chip: "neutral" as const };
          const history = histories.get(r.id) ?? [];
          const terminal = r.status === "CLOS" || r.status === "ANNULE";
          return (
            <Card key={`${r.id}-${r.revision}`} className="flex flex-col gap-3" data-testid={`incident-${r.id}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-label font-semibold text-ink">{typeLabel(r.incident_type)}</p>
                <div className="flex flex-wrap gap-2">
                  <StatusChip variant={sev.chip} label={`Gravité ${sev.label.toLowerCase()}`} />
                  <StatusChip variant={st.chip} label={st.label} />
                </div>
              </div>
              <p className="whitespace-pre-line break-words text-body text-ink">{r.description}</p>
              <dl className="grid grid-cols-1 gap-1 text-caption text-muted sm:grid-cols-2">
                <div>
                  <dt className="inline font-semibold">Survenu le : </dt>
                  <dd className="inline">{formatStamp(r.occurred_at)}</dd>
                </div>
                <div>
                  <dt className="inline font-semibold">Signalé par : </dt>
                  <dd className="inline">
                    {roleLabel(r.reporter_role, r.reporter_owner_profile)}
                    {r.reporter_is_me ? " (vous)" : ""}
                  </dd>
                </div>
                <div>
                  <dt className="inline font-semibold">Responsable : </dt>
                  <dd className="inline">{r.assignee_profile_id ? memberLabel(r.assignee_profile_id) : "aucun"}</dd>
                </div>
                <div>
                  <dt className="inline font-semibold">Échéance : </dt>
                  <dd className="inline">{r.due_date ? formatDay(r.due_date) : "aucune"}</dd>
                </div>
              </dl>
              {r.phase_id ? (
                <p className="text-caption text-ink" data-testid="incident-etape">
                  Étape : <span className="font-semibold">{phaseLinkLabel(r.phase_id, phaseLabels, r.phase_label, r.phase_archived)}</span>
                </p>
              ) : null}
              {r.resolution ? <p className="break-words text-body text-ink">Résolution : {r.resolution}</p> : null}
              {r.linked_incident_id ? <p className="text-caption text-muted">Fait suite à un incident clos.</p> : null}

              {r.can_update && (r.status === "OUVERT" || r.status === "AFFECTE") ? (
                <Action title="Démarrer le traitement">
                  <TransitionForm projectId={id} incident={r} to="EN_COURS" field={{ name: "note", label: "Note (facultative)", required: false }} submitLabel="Passer en cours" />
                </Action>
              ) : null}
              {r.can_update && r.status === "EN_COURS" ? (
                <Action title="Marquer résolu">
                  <TransitionForm projectId={id} incident={r} to="RESOLU" field={{ name: "resolution", label: "Résolution", required: true }} submitLabel="Marquer résolu" />
                </Action>
              ) : null}
              {r.can_update && r.status === "RESOLU" ? (
                <Action title="Reprendre le traitement">
                  <TransitionForm projectId={id} incident={r} to="EN_COURS" field={{ name: "note", label: "Motif de la reprise", required: true }} submitLabel="Reprendre" hint="La résolution actuelle est retirée ; elle reste dans l'historique." />
                </Action>
              ) : null}
              {r.can_close && r.status === "RESOLU" ? (
                <div>
                  <CloseIncidentButton projectId={id} incident={r} />
                </div>
              ) : null}
              {r.can_assign ? (
                <Action title={r.assignee_profile_id ? "Changer le responsable ou l'échéance" : "Désigner un responsable"}>
                  <AssignIncidentForm projectId={id} incident={r} members={members} />
                </Action>
              ) : null}
              {r.can_update ? (
                <Action title="Corriger l'incident">
                  <CorrectIncidentForm projectId={id} incident={r} now={now} phases={phaseOptions} />
                </Action>
              ) : null}
              {r.can_close && r.status === "OUVERT" ? (
                <Action title="Annuler l'incident">
                  <TransitionForm projectId={id} incident={r} to="ANNULE" field={{ name: "note", label: "Motif de l'annulation", required: true }} submitLabel="Annuler l'incident" hint="Réservé à un incident déclaré par erreur. Un incident annulé ne peut plus évoluer." />
                </Action>
              ) : null}
              {r.status === "CLOS" ? (
                <Link href={`/chantiers/${id}/incidents/nouveau?lie=${r.id}`} className="text-label font-semibold text-primary">
                  Le problème revient ? Signaler un nouvel incident lié
                </Link>
              ) : null}

              <details className="rounded-small border border-muted/30 px-3 py-2">
                <summary className="cursor-pointer text-label font-semibold text-primary">Historique ({history.length})</summary>
                <ol className="mt-3 flex flex-col gap-3">
                  {history.map((e) => (
                    <EventLine key={e.id} e={e} memberLabel={memberLabel} me={user.id} phaseLabels={phaseLabels} />
                  ))}
                </ol>
              </details>
              {terminal ? <p className="text-caption text-muted">{r.status === "CLOS" ? "Clos" : "Annulé"} le {r.closed_at_server ? formatStamp(r.closed_at_server) : "—"}.</p> : null}
            </Card>
          );
        })
      )}
    </div>
  );
}
