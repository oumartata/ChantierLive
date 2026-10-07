import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { AlertBanner, Card, EmptyState, StatusChip } from "@/components/ui";
import { formatFcfa } from "@/lib/entreprise/chantierSummary";
import { getPhaseOptions } from "@/lib/phases/phaseOptions";
import {
  CancelExpenseForm,
  CorrectExpenseForm,
  DecideExpenseForm,
  ExpenseDraftForm,
  SubmitExpenseForm,
  type ExpenseView,
} from "./ExpenseForms";
import { DECISION_LABEL, STATUS, categoryLabel, roleLabel } from "./labels";

// SCR035 (liste), avec la saisie SCR034 et la décision SCR036 sur la même page — B031 (M045 ; D183, D184 F3/F4/F7/F8/F10, D185, D187). Dépenses
// internes : entreprise et chef de chantier actifs seulement. Pour tout
// autre rôle (propriétaire, copropriétaire, ex-membre, non-membre), la
// fonction en base refuse et la page est introuvable (aucun chiffre, aucun
// indice). Le chef de chantier voit les dépenses et leurs totaux, jamais le
// budget ni l'alerte de dépassement (D185, D187 H3).

interface Totals {
  engaged_fcfa: number | string;
  pending_fcfa: number | string;
  engaged_count: number;
  pending_count: number;
  refused_count: number;
  cancelled_count: number;
  by_category: Record<string, number | string> | null;
}
interface BudgetAlert {
  has_budget: boolean;
  budget_fcfa: number | string | null;
  engaged_fcfa: number | string;
  over_budget: boolean;
  overrun_fcfa: number | string;
}
interface HistoryEntry {
  kind: string;
  version_number: number;
  amount_fcfa: number | string | null;
  expense_date: string | null;
  category: string | null;
  supplier: string | null;
  note: string | null;
  reason: string | null;
  actor_role: string;
  author_is_me: boolean;
  created_at_server: string;
}

const stamp = (ts: string) =>
  new Date(ts).toLocaleString("fr-FR", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " (UTC)";
const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("fr-FR", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });
const fcfa = (v: number | string | null | undefined) => formatFcfa(String(v ?? 0));

function Fold({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <details className="rounded-small border border-muted/30 px-3 py-2" data-testid={testId}>
      <summary className="cursor-pointer text-label font-semibold text-primary">{title}</summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

export default async function ExpensesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getVerifiedUser();
  if (!user) redirect("/connexion");

  const supabase = await createClient();
  const [list, totals, alert, project] = await Promise.all([
    supabase.rpc("list_project_expenses", { p_project_id: id }),
    supabase.rpc("get_expense_totals", { p_project_id: id }),
    supabase.rpc("get_expense_budget_alert", { p_project_id: id }),
    supabase.from("projects").select("id, name").eq("id", id).maybeSingle(),
  ]);
  if (list.error || totals.error) {
    // D183 : rôle refusé — page introuvable, sans titre ni indice.
    if (list.error?.message === "not_authorized" || totals.error?.message === "not_authorized") notFound();
    return (
      <div className="mx-auto flex max-w-md flex-col gap-4 p-4 sm:p-6">
        <h1 className="text-h1 font-bold text-ink">Dépenses</h1>
        <AlertBanner variant="error" title="Lecture impossible" explanation="Réessayez plus tard." />
      </div>
    );
  }
  // Alerte : l'entreprise seule l'obtient (la base refuse le chef de chantier).
  const isContractor = !alert.error;
  const budgetAlert = (isContractor ? (Array.isArray(alert.data) ? alert.data[0] : alert.data) : null) as BudgetAlert | null;
  const t = (Array.isArray(totals.data) ? totals.data[0] : totals.data) as Totals;
  const rows = (list.data ?? []) as ExpenseView[];
  const histories = new Map<string, HistoryEntry[]>();
  await Promise.all(
    rows
      .filter((r) => r.status !== "BROUILLON")
      .map(async (r) => {
        const { data } = await supabase.rpc("get_expense_history", { p_expense_id: r.id });
        histories.set(r.id, (data ?? []) as HistoryEntry[]);
      })
  );
  const { options: phases } = await getPhaseOptions(supabase, id);
  const today = new Date().toISOString().slice(0, 10);

  const groups: { key: string; title: string; items: ExpenseView[] }[] = [
    { key: "brouillons", title: "Mes brouillons", items: rows.filter((r) => r.status === "BROUILLON") },
    { key: "attente", title: "En attente de décision", items: rows.filter((r) => r.status === "SOUMISE") },
    { key: "engagees", title: "Dépenses engagées", items: rows.filter((r) => r.status === "APPROUVEE" || r.status === "CONTESTEE") },
    { key: "exclues", title: "Refusées et annulées", items: rows.filter((r) => r.status === "REFUSEE" || r.status === "ANNULEE") },
  ];
  const byCategory = Object.entries(t.by_category ?? {}).sort((a, b) => Number(b[1]) - Number(a[1]));

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-h1 font-bold text-ink">Dépenses{project.data ? ` — ${project.data.name}` : ""}</h1>
        <p className="text-body text-muted">
          Dépenses internes du chantier, partagées entre l&apos;entreprise et le chef de chantier. Elles ne sont jamais visibles du propriétaire.
        </p>
      </div>

      {budgetAlert?.over_budget ? (
        <div data-testid="alerte-depassement">
        <AlertBanner
          variant="warning"
          title="Budget interne dépassé"
          explanation={`Le total engagé (${fcfa(budgetAlert.engaged_fcfa)}) dépasse le budget interne (${fcfa(budgetAlert.budget_fcfa)}) de ${fcfa(budgetAlert.overrun_fcfa)}. L'enregistrement des dépenses reste possible.`}
        />
        </div>
      ) : null}

      <Card className="flex flex-col gap-3" data-testid="depenses-totaux">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-h2 font-semibold text-ink">Totaux</h2>
          <StatusChip variant="neutral" label="Interne à l'entreprise" />
        </div>
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-caption font-semibold text-muted">Total engagé</dt>
            <dd className="text-display font-bold text-ink" data-testid="total-engage">
              {fcfa(t.engaged_fcfa)}
            </dd>
            <dd className="text-caption text-muted">
              {t.engaged_count} dépense{t.engaged_count > 1 ? "s" : ""} approuvée{t.engaged_count > 1 ? "s" : ""}, contestées comprises
            </dd>
          </div>
          <div>
            <dt className="text-caption font-semibold text-muted">En attente de décision</dt>
            <dd className="text-h2 font-semibold text-ink" data-testid="total-attente">
              {fcfa(t.pending_fcfa)}
            </dd>
            <dd className="text-caption text-muted">
              {t.pending_count} dépense{t.pending_count > 1 ? "s" : ""} soumise{t.pending_count > 1 ? "s" : ""}, non comptée{t.pending_count > 1 ? "s" : ""} dans le total
            </dd>
          </div>
        </dl>
        {isContractor && budgetAlert?.has_budget && !budgetAlert.over_budget ? (
          <p className="text-caption text-muted" data-testid="budget-comparaison">
            Budget interne : {fcfa(budgetAlert.budget_fcfa)} — reste {fcfa(Number(budgetAlert.budget_fcfa) - Number(budgetAlert.engaged_fcfa))}.
          </p>
        ) : null}
        {byCategory.length > 0 ? (
          <ul className="flex flex-col gap-1 border-t border-muted/20 pt-2">
            {byCategory.map(([cat, amount]) => (
              <li key={cat} className="flex justify-between gap-2 text-caption text-ink">
                <span>{categoryLabel(cat)}</span>
                <span className="font-semibold">{fcfa(amount)}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="text-caption text-muted">
          Refusées ({t.refused_count}) et annulées ({t.cancelled_count}) restent consultables mais ne sont pas comptées ; seule la version en vigueur d&apos;une dépense corrigée l&apos;est.
        </p>
      </Card>

      <Card className="flex flex-col gap-3">
        <h2 className="text-h2 font-semibold text-ink">Nouvelle dépense</h2>
        <ExpenseDraftForm projectId={id} today={today} phases={phases} />
      </Card>

      {rows.length === 0 ? <EmptyState title="Aucune dépense" description="Les dépenses enregistrées sur ce chantier apparaîtront ici." /> : null}

      {groups
        .filter((g) => g.items.length > 0)
        .map((g) => (
          <section key={g.key} className="flex flex-col gap-3" data-testid={`groupe-${g.key}`}>
            <h2 className="text-h2 font-semibold text-ink">
              {g.title} ({g.items.length})
            </h2>
            {g.items.map((r) => {
              const st = STATUS[r.status] ?? { label: r.status, chip: "neutral" as const };
              const history = histories.get(r.id) ?? [];
              return (
                <Card key={`${r.id}-${r.revision}`} className="flex flex-col gap-3" data-testid={`depense-${r.id}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-h2 font-semibold text-ink">{r.amount_fcfa != null ? fcfa(r.amount_fcfa) : "—"}</p>
                    <StatusChip variant={st.chip} label={st.label} />
                  </div>
                  <dl className="grid grid-cols-1 gap-1 text-caption text-muted sm:grid-cols-2">
                    <div>
                      <dt className="inline font-semibold">Catégorie : </dt>
                      <dd className="inline">{categoryLabel(r.category)}</dd>
                    </div>
                    <div>
                      <dt className="inline font-semibold">Date : </dt>
                      <dd className="inline">{r.expense_date ? day(r.expense_date) : "—"}</dd>
                    </div>
                    {r.supplier ? (
                      <div>
                        <dt className="inline font-semibold">Fournisseur : </dt>
                        <dd className="inline break-words">{r.supplier}</dd>
                      </div>
                    ) : null}
                    {r.phase_id ? (
                      <div>
                        <dt className="inline font-semibold">Étape : </dt>
                        <dd className="inline">{r.phase_label ?? "étape retirée"}</dd>
                      </div>
                    ) : null}
                    <div>
                      <dt className="inline font-semibold">Saisie par : </dt>
                      <dd className="inline">
                        {r.author_is_me ? "vous" : roleLabel(r.created_by_role)}
                        {r.version_number && r.version_number > 1 ? ` — version ${r.version_number}` : ""}
                      </dd>
                    </div>
                  </dl>
                  {r.note ? <p className="whitespace-pre-line break-words text-body text-ink">{r.note}</p> : null}
                  {r.last_reason && r.status !== "APPROUVEE" ? (
                    <p className="break-words text-caption text-ink">
                      <span className="font-semibold">Motif : </span>
                      {r.last_reason}
                    </p>
                  ) : null}

                  {r.can_edit_draft ? (
                    <Fold title="Modifier le brouillon">
                      <ExpenseDraftForm projectId={id} today={today} phases={phases} expense={r} />
                    </Fold>
                  ) : null}
                  {r.can_submit ? <SubmitExpenseForm projectId={id} expense={r} isContractor={isContractor} /> : null}
                  {r.can_decide ? (
                    <div className="flex flex-col gap-2" data-testid={`decision-${r.id}`}>
                      <DecideExpenseForm projectId={id} expense={r} decision="APPROUVEE" />
                      <Fold title="Refuser la dépense">
                        <DecideExpenseForm projectId={id} expense={r} decision="REFUSEE" />
                      </Fold>
                    </div>
                  ) : null}
                  {r.can_dispute ? (
                    <Fold title="Contester la dépense">
                      <DecideExpenseForm projectId={id} expense={r} decision="CONTESTEE" />
                    </Fold>
                  ) : null}
                  {r.can_correct ? (
                    <Fold title="Corriger la dépense">
                      <CorrectExpenseForm projectId={id} expense={r} today={today} phases={phases} />
                    </Fold>
                  ) : null}
                  {r.can_cancel ? (
                    <Fold title="Annuler la dépense">
                      <CancelExpenseForm projectId={id} expense={r} />
                    </Fold>
                  ) : null}

                  {history.length > 0 ? (
                    <Fold title={`Historique (${history.length})`} testId={`historique-${r.id}`}>
                      <ol className="flex flex-col gap-2">
                        {history.map((h, i) => (
                          <li key={`${h.kind}-${i}`} className="flex flex-col gap-0.5 border-l-2 border-muted/30 pl-3">
                            <p className="text-caption font-semibold text-ink">
                              {h.kind === "VERSION"
                                ? `Version ${h.version_number} — ${fcfa(h.amount_fcfa)}, ${categoryLabel(h.category)}${h.expense_date ? `, ${day(h.expense_date)}` : ""}`
                                : `${DECISION_LABEL[h.kind.replace("DECISION:", "")] ?? h.kind} (version ${h.version_number})`}
                            </p>
                            <p className="break-words text-caption text-muted">
                              Par {h.author_is_me ? "vous" : roleLabel(h.actor_role)}, le {stamp(h.created_at_server)}
                              {h.reason ? ` — motif : ${h.reason}` : ""}
                            </p>
                          </li>
                        ))}
                      </ol>
                    </Fold>
                  ) : null}
                </Card>
              );
            })}
          </section>
        ))}
    </div>
  );
}
