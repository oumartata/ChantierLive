// B044 — tableaux de bord par rôle (D189 : T1 à T7 ; PROPOSITION_B044_TABLEAUX_DE_BORD.md).
//
// Aucune migration (T7) : chaque indicateur est composé à partir de fonctions
// existantes, qui revérifient chacune le droit de l'appelant (BR068). Ce
// module ne contient aucune requête propre et aucun import : il reçoit le
// client de l'utilisateur, ce qui permet de le tester tel quel avec de vrais
// comptes (scripts/test-dashboard.mjs).
//
// Règles tenues ici :
// - Propriétaire (principal ou copropriétaire) : seules des fonctions
//   lisibles par lui sont appelées ; jamais dépenses, budget interne, reçus,
//   demandes internes (D183). Le module ne les appelle QUE pour l'entreprise
//   ou le chef de chantier.
// - Chef de chantier : jamais le budget ni l'alerte de dépassement (D185,
//   D187 H3) ; aucune fonction de budget n'est appelée pour lui.
// - « Avancement déclaré par l'entreprise » et « Avancement validé » : deux
//   valeurs séparées, jamais combinées (D177).
// - Aucun total entre chantiers : chaque carte est calculée seule.
// - Chaque section distingue erreur et absence de données (BR070).

export interface RpcClient {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export type DashboardRole = "OWNER_PRIMARY" | "CO_OWNER" | "CONTRACTOR" | "SITE_MANAGER";

export type Section<T> = { kind: "ok"; value: T } | { kind: "error" };

export interface ProjectRef {
  id: string;
  name: string;
  status: string;
  budget: string | null;
}

export interface DeclaredProgress {
  planPublished: boolean;
  percent: number | null;
  lastEventAt: string | null;
}
export interface ValidatedProgress {
  computable: boolean;
  validated: number;
  applicable: number;
}
export interface IncidentSummary {
  open: number;
  high: number;
  latestAt: string | null;
}
export interface OverdueSummary {
  count: number;
  labels: string[];
}

export interface OwnerCard {
  kind: "owner";
  role: "OWNER_PRIMARY" | "CO_OWNER";
  project: ProjectRef;
  declared: Section<DeclaredProgress>;
  validated: Section<ValidatedProgress>;
  finance: Section<{ contract: string | null; recognized: string | null; remainingDue: string | null; pendingCount: number }>;
  decisions: Section<{ quotePending: boolean; changeOrdersPending: number; phasesToValidate: number; canDecide: boolean }>;
  incidents: Section<IncidentSummary>;
  lastActivityAt: string | null;
}

export interface ContractorCard {
  kind: "contractor";
  project: ProjectRef;
  declared: Section<DeclaredProgress>;
  validated: Section<ValidatedProgress>;
  overdue: Section<OverdueSummary>;
  incidents: Section<IncidentSummary>;
  requests: Section<{ expensesSubmitted: number; paymentsToConfirm: number; phasesAwaitingValidation: number }>;
  lastActivityAt: string | null;
}

export interface SiteManagerCard {
  kind: "site_manager";
  project: ProjectRef;
  journalToday: Section<{ draft: boolean; published: boolean }>;
  incidents: Section<IncidentSummary>;
  myExpenses: Section<{ drafts: number; submitted: number }>;
  overdue: Section<OverdueSummary>;
}

export type DashboardCard = OwnerCard | ContractorCard | SiteManagerCard;

// ---------------------------------------------------------------------------
// Fonctions pures (testées sans base).
// ---------------------------------------------------------------------------
const rowsOf = (data: unknown): Record<string, unknown>[] => (Array.isArray(data) ? (data as Record<string, unknown>[]) : data ? [data as Record<string, unknown>] : []);
const firstOf = (data: unknown): Record<string, unknown> | null => rowsOf(data)[0] ?? null;
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** Date ISO la plus récente (ou null). */
export function latestOf(dates: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const d of dates) {
    if (!d) continue;
    const ms = Date.parse(d);
    if (Number.isFinite(ms) && ms > bestMs) {
      bestMs = ms;
      best = d;
    }
  }
  return best;
}

/**
 * T2 A : étape active d'un plan PUBLIÉ, non validée, dont la fin prévue est
 * strictement antérieure à « aujourd'hui » (date du serveur, AAAA-MM-JJ).
 */
export function overduePhases(planStatus: string | null, phases: { label: string; status: string; planned_end: string | null }[], today: string): OverdueSummary {
  if (planStatus !== "PUBLIE") return { count: 0, labels: [] };
  const late = phases.filter((p) => p.status !== "VALIDEE" && !!p.planned_end && p.planned_end < today);
  return { count: late.length, labels: late.map((p) => p.label) };
}

/** Incidents ouverts : ni clos ni annulés ; gravité élevée ou urgente mise à part. */
export function incidentSummary(rows: { status: string; severity: string; updated_at_server?: string | null }[]): IncidentSummary {
  const open = rows.filter((r) => r.status !== "CLOS" && r.status !== "ANNULE");
  return {
    open: open.length,
    high: open.filter((r) => r.severity === "ELEVEE" || r.severity === "URGENTE").length,
    latestAt: latestOf(rows.map((r) => r.updated_at_server ?? null)),
  };
}

// ---------------------------------------------------------------------------
// Composition (une carte par chantier, jamais d'agrégat entre chantiers).
// ---------------------------------------------------------------------------
async function call(client: RpcClient, fn: string, args: Record<string, unknown>) {
  const r = await client.rpc(fn, args);
  return r.error ? { ok: false as const } : { ok: true as const, data: r.data };
}

async function progress(client: RpcClient, projectId: string) {
  const [plan, validated] = await Promise.all([
    call(client, "get_project_phase_plan", { p_project_id: projectId }),
    call(client, "get_project_validated_progress", { p_project_id: projectId }),
  ]);
  const planRow = plan.ok ? firstOf(plan.data) : null;
  const declared: Section<DeclaredProgress> = plan.ok
    ? {
        kind: "ok",
        value: {
          planPublished: planRow?.status === "PUBLIE",
          percent: planRow?.status === "PUBLIE" && planRow.global_progress !== null && planRow.global_progress !== undefined ? Number(planRow.global_progress) : null,
          lastEventAt: str(planRow?.last_event_at),
        },
      }
    : { kind: "error" };
  const vRow = validated.ok ? firstOf(validated.data) : null;
  const validatedSection: Section<ValidatedProgress> = validated.ok
    ? { kind: "ok", value: { computable: vRow?.computable === true, validated: Number(vRow?.validated_count ?? 0), applicable: Number(vRow?.applicable_count ?? 0) } }
    : { kind: "error" };
  return { declared, validated: validatedSection, planStatus: str(planRow?.status) };
}

async function sharedActivity(client: RpcClient, projectId: string) {
  const [logs, media, docs] = await Promise.all([
    call(client, "list_published_daily_logs", { p_project_id: projectId, p_limit: 5, p_offset: 0 }),
    call(client, "list_project_media", { p_project_id: projectId }),
    call(client, "list_project_documents", { p_project_id: projectId }),
  ]);
  return latestOf([
    ...(logs.ok ? rowsOf(logs.data).map((r) => str(r.current_published_at_server)) : []),
    ...(media.ok ? rowsOf(media.data).map((r) => str(r.published_at_server)) : []),
    ...(docs.ok ? rowsOf(docs.data).filter((r) => r.status !== "BROUILLON").map((r) => str(r.current_version_at) ?? str(r.published_at_server)) : []),
  ]);
}

async function incidentsOf(client: RpcClient, projectId: string): Promise<Section<IncidentSummary>> {
  const r = await call(client, "list_project_incidents", { p_project_id: projectId, p_limit: 200, p_offset: 0 });
  if (!r.ok) return { kind: "error" };
  return { kind: "ok", value: incidentSummary(rowsOf(r.data) as { status: string; severity: string; updated_at_server: string | null }[]) };
}

async function phasesOf(client: RpcClient, projectId: string) {
  const r = await call(client, "list_project_phase_details", { p_project_id: projectId });
  return r.ok ? { ok: true as const, rows: rowsOf(r.data) } : { ok: false as const, rows: [] };
}

export async function loadOwnerCard(client: RpcClient, project: ProjectRef, role: "OWNER_PRIMARY" | "CO_OWNER"): Promise<OwnerCard> {
  const [prog, finance, quote, changeOrders, phases, incidents, activity] = await Promise.all([
    progress(client, project.id),
    call(client, "get_project_financial_summary", { p_project_id: project.id }),
    call(client, "get_quote_state", { p_project_id: project.id }),
    call(client, "list_change_orders", { p_project_id: project.id }),
    phasesOf(client, project.id),
    incidentsOf(client, project.id),
    sharedActivity(client, project.id),
  ]);
  const f = finance.ok ? firstOf(finance.data) : null;
  const q = quote.ok ? firstOf(quote.data) : null;
  const decisionsOk = quote.ok && changeOrders.ok && phases.ok;
  return {
    kind: "owner",
    role,
    project,
    declared: prog.declared,
    validated: prog.validated,
    finance: finance.ok
      ? { kind: "ok", value: { contract: str(f?.contract_amount_fcfa), recognized: str(f?.recognized_fcfa), remainingDue: str(f?.remaining_due_fcfa), pendingCount: Number(f?.pending_count ?? 0) } }
      : { kind: "error" },
    decisions: decisionsOk
      ? {
          kind: "ok",
          value: {
            quotePending: !!q?.pending_version_id,
            changeOrdersPending: rowsOf(changeOrders.ok ? changeOrders.data : null).filter((c) => c.is_pending === true || c.status === "PROPOSED").length,
            phasesToValidate: phases.rows.filter((p) => p.status === "TERMINEE").length,
            canDecide: role === "OWNER_PRIMARY",
          },
        }
      : { kind: "error" },
    incidents,
    lastActivityAt: latestOf([activity, prog.declared.kind === "ok" ? prog.declared.value.lastEventAt : null, incidents.kind === "ok" ? incidents.value.latestAt : null]),
  };
}

export async function loadContractorCard(client: RpcClient, project: ProjectRef, today: string): Promise<ContractorCard> {
  const [prog, phases, incidents, expenses, payments, activity] = await Promise.all([
    progress(client, project.id),
    phasesOf(client, project.id),
    incidentsOf(client, project.id),
    call(client, "list_project_expenses", { p_project_id: project.id }),
    call(client, "list_advance_payments", { p_project_id: project.id }),
    sharedActivity(client, project.id),
  ]);
  const requestsOk = expenses.ok && payments.ok && phases.ok;
  return {
    kind: "contractor",
    project,
    declared: prog.declared,
    validated: prog.validated,
    overdue: phases.ok ? { kind: "ok", value: overduePhases(prog.planStatus, phases.rows as { label: string; status: string; planned_end: string | null }[], today) } : { kind: "error" },
    incidents,
    requests: requestsOk
      ? {
          kind: "ok",
          value: {
            expensesSubmitted: rowsOf(expenses.ok ? expenses.data : null).filter((e) => e.status === "SOUMISE").length,
            paymentsToConfirm: rowsOf(payments.ok ? payments.data : null).filter((p) => p.can_confirm === true).length,
            phasesAwaitingValidation: phases.rows.filter((p) => p.status === "TERMINEE").length,
          },
        }
      : { kind: "error" },
    lastActivityAt: latestOf([activity, prog.declared.kind === "ok" ? prog.declared.value.lastEventAt : null, incidents.kind === "ok" ? incidents.value.latestAt : null]),
  };
}

export async function loadSiteManagerCard(client: RpcClient, project: ProjectRef, today: string): Promise<SiteManagerCard> {
  const [drafts, logs, incidents, expenses, prog, phases] = await Promise.all([
    call(client, "list_my_daily_log_drafts", { p_project_id: project.id }),
    call(client, "list_published_daily_logs", { p_project_id: project.id, p_limit: 5, p_offset: 0 }),
    incidentsOf(client, project.id),
    call(client, "list_project_expenses", { p_project_id: project.id }),
    progress(client, project.id),
    phasesOf(client, project.id),
  ]);
  const mine = rowsOf(expenses.ok ? expenses.data : null).filter((e) => e.author_is_me === true);
  return {
    kind: "site_manager",
    project,
    journalToday:
      drafts.ok && logs.ok
        ? {
            kind: "ok",
            value: {
              draft: rowsOf(drafts.data).some((d) => d.log_date === today),
              published: rowsOf(logs.data).some((l) => l.log_date === today),
            },
          }
        : { kind: "error" },
    incidents,
    myExpenses: expenses.ok ? { kind: "ok", value: { drafts: mine.filter((e) => e.status === "BROUILLON").length, submitted: mine.filter((e) => e.status === "SOUMISE").length } } : { kind: "error" },
    overdue: phases.ok ? { kind: "ok", value: overduePhases(prog.planStatus, phases.rows as { label: string; status: string; planned_end: string | null }[], today) } : { kind: "error" },
  };
}

export async function loadCard(client: RpcClient, project: ProjectRef, role: DashboardRole, today: string): Promise<DashboardCard> {
  switch (role) {
    case "OWNER_PRIMARY":
    case "CO_OWNER":
      return loadOwnerCard(client, project, role);
    case "CONTRACTOR":
      return loadContractorCard(client, project, today);
    case "SITE_MANAGER":
      return loadSiteManagerCard(client, project, today);
  }
}

export function dashboardRole(role: string, ownerProfile: string | null): DashboardRole | null {
  if (role === "CONTRACTOR") return "CONTRACTOR";
  if (role === "SITE_MANAGER") return "SITE_MANAGER";
  if (role === "OWNER" && ownerProfile === "PRIMARY") return "OWNER_PRIMARY";
  if (role === "OWNER" && ownerProfile === "CO_OWNER") return "CO_OWNER";
  return null;
}
