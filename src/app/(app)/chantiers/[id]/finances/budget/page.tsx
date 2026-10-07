import { notFound, redirect } from "next/navigation";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { AlertBanner, Card, EmptyState, StatusChip } from "@/components/ui";
import { formatFcfa } from "@/lib/entreprise/chantierSummary";
import { BudgetForm } from "./BudgetForm";

// SCR033 — B030 (M043, D183–D185). Budget prévisionnel interne : entreprise
// active seule. Pour tout autre rôle (propriétaire, copropriétaire, chef de
// chantier) la fonction en base refuse ; cette page n'affiche alors aucun
// chiffre, aucune date, aucun indice de l'existence d'un budget.

interface BudgetView {
  budget_id: string | null;
  revision: number | null;
  current_version_number: number | null;
  amount_fcfa: number | string | null;
  reason: string | null;
  updated_at_server: string | null;
}
interface VersionView {
  version_number: number;
  amount_fcfa: number | string;
  reason: string | null;
  author_is_me: boolean;
  created_at_server: string;
  is_current: boolean;
}

const stamp = (ts: string) =>
  new Date(ts).toLocaleString("fr-FR", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " (UTC)";

export default async function InternalBudgetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getVerifiedUser();
  if (!user) redirect("/connexion");

  const supabase = await createClient();
  const [budget, versions] = await Promise.all([
    supabase.rpc("get_internal_budget", { p_project_id: id }),
    supabase.rpc("list_internal_budget_versions", { p_project_id: id }),
  ]);
  if (budget.error || versions.error) {
    // D183 : pour tout rôle refusé, aucune page, aucun titre, aucun indice
    // de l'existence d'un budget interne — page introuvable.
    if (budget.error?.message === "not_authorized" || versions.error?.message === "not_authorized") notFound();
    return (
      <div className="mx-auto flex max-w-md flex-col gap-4 p-4 sm:p-6">
        <h1 className="text-h1 font-bold text-ink">Budget interne</h1>
        <AlertBanner variant="error" title="Lecture impossible" explanation="Réessayez plus tard." />
      </div>
    );
  }
  const current = (Array.isArray(budget.data) ? budget.data[0] : budget.data) as BudgetView | null;
  const hasBudget = !!current?.budget_id;
  const list = (versions.data ?? []) as VersionView[];

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-h1 font-bold text-ink">Budget interne</h1>
        <p className="text-body text-muted">
          Budget prévisionnel de l&apos;entreprise pour ce chantier. Il est distinct du montant contractuel, des paiements reçus et de l&apos;enveloppe indicative
          partagée, et n&apos;est jamais visible du propriétaire ni du chef de chantier.
        </p>
      </div>

      <Card className="flex flex-col gap-2" data-testid="budget-courant">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-h2 font-semibold text-ink">Budget en vigueur</h2>
          <StatusChip variant="neutral" label="Interne à l'entreprise" />
        </div>
        {hasBudget ? (
          <>
            <p className="text-display font-bold text-ink">{formatFcfa(String(current!.amount_fcfa))}</p>
            <p className="text-caption text-muted">
              Version {current!.current_version_number}
              {current!.updated_at_server ? `, le ${stamp(current!.updated_at_server)}` : ""}
              {current!.reason ? ` — ${current!.reason}` : ""}
            </p>
          </>
        ) : (
          <EmptyState title="Aucun budget déclaré" description="Déclarez le budget prévisionnel interne de ce chantier." />
        )}
      </Card>

      <Card className="flex flex-col gap-3">
        <h2 className="text-h2 font-semibold text-ink">{hasBudget ? "Réviser le budget" : "Déclarer le budget"}</h2>
        <BudgetForm key={current?.revision ?? 0} projectId={id} revision={current?.revision ?? 0} isRevision={hasBudget} />
      </Card>

      {list.length > 0 ? (
        <Card className="flex flex-col gap-2" data-testid="budget-historique">
          <h2 className="text-h2 font-semibold text-ink">Historique ({list.length})</h2>
          <ol className="flex flex-col gap-2">
            {list.map((v) => (
              <li key={v.version_number} className="flex flex-col gap-0.5 border-l-2 border-muted/30 pl-3">
                <p className="text-caption font-semibold text-ink">
                  Version {v.version_number}
                  {v.is_current ? " (en vigueur)" : ""} — {formatFcfa(String(v.amount_fcfa))}
                </p>
                <p className="break-words text-caption text-muted">
                  {v.author_is_me ? "Par vous" : "Par l'entreprise"}, le {stamp(v.created_at_server)}
                  {v.reason ? ` — motif : ${v.reason}` : ""}
                </p>
              </li>
            ))}
          </ol>
        </Card>
      ) : null}
    </div>
  );
}
