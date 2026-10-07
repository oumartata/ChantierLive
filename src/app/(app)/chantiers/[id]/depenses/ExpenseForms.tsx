"use client";

import { useActionState } from "react";
import { AlertBanner, Button, TextField } from "@/components/ui";
import {
  attachExpenseReceiptAction,
  cancelExpenseAction,
  correctExpenseAction,
  decideExpenseAction,
  saveExpenseDraftAction,
  setReceiptPolicyAction,
  submitExpenseAction,
  withdrawExpenseReceiptAction,
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
  no_receipt_reason: string | null;
  receipt_count: number;
  can_attach_receipt: boolean;
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

function ExpenseFields({ expense, today, phases, justificationRequired }: { expense?: ExpenseView; today: string; phases: PhaseOption[]; justificationRequired: boolean }) {
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
      <TextField
        label={justificationRequired ? "Justification si aucun reçu n'est joint" : "Justification si aucun reçu (facultative)"}
        name="no_receipt_reason"
        maxLength={1000}
        defaultValue={expense?.no_receipt_reason ?? ""}
      />
      {justificationRequired ? <p className="text-caption text-muted">Ce chantier exige un reçu ou une justification écrite de son absence pour envoyer la dépense.</p> : null}
    </>
  );
}

// Nouveau brouillon ou modification d'un brouillon (auteur seul, D187 H1).
export function ExpenseDraftForm({ projectId, today, phases, expense, justificationRequired }: { projectId: string; today: string; phases: PhaseOption[]; expense?: ExpenseView; justificationRequired: boolean }) {
  const [state, formAction, pending] = useActionState<ExpenseActionState, FormData>(saveExpenseDraftAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-3" data-testid={expense ? `brouillon-form-${expense.id}` : "nouvelle-depense"}>
      <Hidden projectId={projectId} expense={expense} />
      <ExpenseFields expense={expense} today={today} phases={phases} justificationRequired={justificationRequired} />
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
export function CorrectExpenseForm({ projectId, expense, today, phases, justificationRequired }: { projectId: string; expense: ExpenseView; today: string; phases: PhaseOption[]; justificationRequired: boolean }) {
  const [state, formAction, pending] = useActionState<ExpenseActionState, FormData>(correctExpenseAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <Hidden projectId={projectId} expense={expense} />
      <ExpenseFields expense={expense} today={today} phases={phases} justificationRequired={justificationRequired} />
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

// B032 : reçu facultatif (PDF, JPEG, PNG, WebP ; 10 Mo) ; type réel contrôlé par le serveur.
export function AttachReceiptForm({ projectId, expense }: { projectId: string; expense: ExpenseView }) {
  const [state, formAction, pending] = useActionState<ExpenseActionState, FormData>(attachExpenseReceiptAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-2" data-testid={`joindre-recu-${expense.id}`}>
      <Hidden projectId={projectId} expense={expense} />
      <label className="flex flex-col gap-1 text-label font-semibold text-ink">
        Fichier du reçu
        <input type="file" name="file" required accept="application/pdf,image/jpeg,image/png,image/webp" className="text-body font-normal text-ink" />
      </label>
      <p className="text-caption text-muted">PDF, JPEG, PNG ou WebP, 10 Mo au plus. Visible de l&apos;entreprise et du chef de chantier seulement.</p>
      <Feedback state={state} title="Reçu non joint" okText="Reçu joint." />
      <div>
        <Button type="submit" size="compact" variant="secondary" loading={pending}>
          Joindre le reçu
        </Button>
      </div>
    </form>
  );
}

// Retrait motivé : le reçu reste listé, son fichier est conservé mais n'est plus délivré.
export function WithdrawReceiptForm({ projectId, receiptId }: { projectId: string; receiptId: string }) {
  const [state, formAction, pending] = useActionState<ExpenseActionState, FormData>(withdrawExpenseReceiptAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="project_id" value={projectId} />
      <input type="hidden" name="receipt_id" value={receiptId} />
      <TextField label="Motif du retrait" name="reason" required minLength={3} maxLength={1000} />
      <Feedback state={state} title="Retrait impossible" />
      <div>
        <Button type="submit" size="compact" variant="danger" loading={pending}>
          Retirer le reçu
        </Button>
      </div>
    </form>
  );
}

// F5 C : réglage du chantier, désactivé par défaut, entreprise seule.
export function ReceiptPolicyForm({ projectId, required, revision }: { projectId: string; required: boolean; revision: number }) {
  const [state, formAction, pending] = useActionState<ExpenseActionState, FormData>(setReceiptPolicyAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-2" data-testid="reglage-justification">
      <input type="hidden" name="project_id" value={projectId} />
      <input type="hidden" name="expected_revision" value={revision} />
      <input type="hidden" name="required" value={required ? "0" : "1"} />
      <Feedback state={state} title="Réglage non enregistré" />
      <div>
        <Button type="submit" size="compact" variant="secondary" loading={pending}>
          {required ? "Rendre la justification facultative" : "Exiger une justification sans reçu"}
        </Button>
      </div>
    </form>
  );
}
