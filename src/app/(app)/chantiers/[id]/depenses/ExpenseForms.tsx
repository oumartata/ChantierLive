"use client";

import { useActionState } from "react";
import { AlertBanner, Button, TextField } from "@/components/ui";
import {
  cancelExpenseAction,
  correctExpenseAction,
  decideExpenseAction,
  saveExpenseDraftAction,
  submitExpenseAction,
  type ExpenseActionState,
} from "./actions";
import { CATEGORIES } from "./labels";
import type { PhaseOption } from "@/lib/phases/phaseOptions";

export interface ExpenseView {
  id: string;
  status: string;
  created_by_role: string;
  author_is_me: boolean;
  revision: number;
  amount_fcfa: number | string | null;
  expense_date: string | null;
  category: string | null;
  supplier: string | null;
  note: string | null;
  phase_id: string | null;
  phase_label: string | null;
  version_number: number | null;
  created_at_server: string;
  submitted_at_server: string | null;
  last_reason: string | null;
  can_edit_draft: boolean;
  can_submit: boolean;
  can_decide: boolean;
  can_dispute: boolean;
  can_correct: boolean;
  can_cancel: boolean;
}

const FIELD = "w-full rounded-small border border-muted/40 bg-surface px-4 py-2 text-body font-normal text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

function Select({ name, label, options, defaultValue, required }: { name: string; label: string; options: { value: string; label: string }[]; defaultValue?: string; required?: boolean }) {
  return (
    <label className="flex flex-col gap-1 text-label font-semibold text-ink">
      {label}
      <select name={name} defaultValue={defaultValue ?? ""} required={required} className={`${FIELD} h-12`}>
        {required ? null : <option value="">—</option>}
        {required && !defaultValue ? <option value="" disabled>Choisir…</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Feedback({ state, title, okText }: { state: ExpenseActionState; title: string; okText?: string }) {
  if (state && "error" in state) return <AlertBanner variant="error" title={title} explanation={state.error} />;
  if (state && "ok" in state && okText) return <p className="text-caption text-muted">{okText}</p>;
  return null;
}

function Hidden({ projectId, expense }: { projectId: string; expense?: ExpenseView }) {
  return (
    <>
      <input type="hidden" name="project_id" value={projectId} />
      <input type="hidden" name="expense_id" value={expense?.id ?? ""} />
      <input type="hidden" name="expected_revision" value={expense?.revision ?? ""} />
    </>
  );
}

function ExpenseFields({ expense, today, phases }: { expense?: ExpenseView; today: string; phases: PhaseOption[] }) {
  // F10 : étape facultative ; un lien actuel vers une étape retirée reste proposé tel quel.
  const current = expense?.phase_id ?? null;
  const phaseOptions = current && !phases.some((p) => p.value === current) ? [{ value: current, label: "Étape retirée (lien actuel)" }, ...phases] : phases;
  return (
    <>
      <TextField label="Montant (FCFA)" name="amount" inputMode="numeric" required defaultValue={expense?.amount_fcfa != null ? String(expense.amount_fcfa) : ""} />
      <TextField label="Date de la dépense" name="expense_date" type="date" required max={today} defaultValue={expense?.expense_date ?? today} />
      <Select name="category" label="Catégorie" options={CATEGORIES} defaultValue={expense?.category ?? undefined} required />
      <TextField label="Fournisseur (facultatif)" name="supplier" maxLength={200} defaultValue={expense?.supplier ?? ""} />
      <TextField label="Note (facultative)" name="note" maxLength={1000} defaultValue={expense?.note ?? ""} />
      <Select name="phase_id" label="Étape concernée (facultative)" options={phaseOptions} defaultValue={current ?? undefined} />
    </>
  );
}

// Nouveau brouillon ou modification d'un brouillon (auteur seul, D187 H1).
export function ExpenseDraftForm({ projectId, today, phases, expense }: { projectId: string; today: string; phases: PhaseOption[]; expense?: ExpenseView }) {
  const [state, formAction, pending] = useActionState<ExpenseActionState, FormData>(saveExpenseDraftAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-3" data-testid={expense ? `brouillon-form-${expense.id}` : "nouvelle-depense"}>
      <Hidden projectId={projectId} expense={expense} />
      <ExpenseFields expense={expense} today={today} phases={phases} />
      <p className="text-caption text-muted">Le brouillon n&apos;est visible que par vous, jusqu&apos;à son envoi.</p>
      <Feedback state={state} title="Brouillon non enregistré" okText={expense ? undefined : "Brouillon enregistré."} />
      <div>
        <Button type="submit" variant={expense ? "secondary" : "primary"} size={expense ? "compact" : "regular"} loading={pending}>
          {expense ? "Enregistrer le brouillon" : "Créer le brouillon"}
        </Button>
      </div>
    </form>
  );
}

// Envoi : soumission à l'entreprise (chef de chantier) ou enregistrement
// approuvé directement (entreprise), F4.
export function SubmitExpenseForm({ projectId, expense, isContractor }: { projectId: string; expense: ExpenseView; isContractor: boolean }) {
  const [state, formAction, pending] = useActionState<ExpenseActionState, FormData>(submitExpenseAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <Hidden projectId={projectId} expense={expense} />
      <p className="text-caption text-muted">
        {isContractor ? "La dépense sera enregistrée comme approuvée et comptée dans le total engagé." : "La dépense sera envoyée à l'entreprise, qui l'approuvera ou la refusera."}
      </p>
      <Feedback state={state} title="Envoi impossible" />
      <div>
        <Button type="submit" size="compact" loading={pending}>
          {isContractor ? "Enregistrer la dépense" : "Soumettre à l'entreprise"}
        </Button>
      </div>
    </form>
  );
}

// Décision de l'entreprise : approbation, refus motivé (définitif, H4) ou
// contestation motivée.
export function DecideExpenseForm({ projectId, expense, decision }: { projectId: string; expense: ExpenseView; decision: "APPROUVEE" | "REFUSEE" | "CONTESTEE" }) {
  const [state, formAction, pending] = useActionState<ExpenseActionState, FormData>(decideExpenseAction, null);
  const needsReason = decision !== "APPROUVEE";
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <Hidden projectId={projectId} expense={expense} />
      <input type="hidden" name="decision" value={decision} />
      {needsReason ? <TextField label={decision === "REFUSEE" ? "Motif du refus" : "Motif de la contestation"} name="reason" required minLength={3} maxLength={1000} /> : null}
      {decision === "REFUSEE" ? <p className="text-caption text-muted">Un refus est définitif : la dépense reste visible mais n&apos;est jamais comptée.</p> : null}
      {decision === "CONTESTEE" ? <p className="text-caption text-muted">Une dépense contestée reste comptée jusqu&apos;à sa correction ou son annulation.</p> : null}
      <Feedback state={state} title="Décision impossible" />
      <div>
        <Button type="submit" size="compact" variant={decision === "APPROUVEE" ? "primary" : decision === "REFUSEE" ? "danger" : "secondary"} loading={pending}>
          {decision === "APPROUVEE" ? "Approuver" : decision === "REFUSEE" ? "Refuser" : "Contester"}
        </Button>
      </div>
    </form>
  );
}

// Correction liée (F7) : nouvelle version motivée ; l'ancienne reste dans l'historique.
export function CorrectExpenseForm({ projectId, expense, today, phases }: { projectId: string; expense: ExpenseView; today: string; phases: PhaseOption[] }) {
  const [state, formAction, pending] = useActionState<ExpenseActionState, FormData>(correctExpenseAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <Hidden projectId={projectId} expense={expense} />
      <ExpenseFields expense={expense} today={today} phases={phases} />
      <TextField label="Motif de la correction" name="reason" required minLength={3} maxLength={1000} />
      <p className="text-caption text-muted">La version corrigée remplace l&apos;actuelle dans les totaux ; l&apos;actuelle reste consultable dans l&apos;historique.</p>
      <Feedback state={state} title="Correction impossible" />
      <div>
        <Button type="submit" size="compact" loading={pending}>
          Enregistrer la correction
        </Button>
      </div>
    </form>
  );
}

// Annulation (contre-écriture motivée, F7) : la dépense sort des totaux et reste visible.
export function CancelExpenseForm({ projectId, expense }: { projectId: string; expense: ExpenseView }) {
  const [state, formAction, pending] = useActionState<ExpenseActionState, FormData>(cancelExpenseAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <Hidden projectId={projectId} expense={expense} />
      <TextField label="Motif de l'annulation" name="reason" required minLength={3} maxLength={1000} />
      <p className="text-caption text-muted">L&apos;annulation est définitive : la dépense reste visible avec son motif et sort du total engagé.</p>
      <Feedback state={state} title="Annulation impossible" />
      <div>
        <Button type="submit" size="compact" variant="danger" loading={pending}>
          Annuler la dépense
        </Button>
      </div>
    </form>
  );
}
