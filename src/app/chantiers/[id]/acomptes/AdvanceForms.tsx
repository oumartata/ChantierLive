"use client";

import { startTransition, useActionState, useState } from "react";
import { Button, AlertBanner, TextField } from "@/components/ui";
import {
  actOnAdvanceAction,
  attachAdvanceReceiptAction,
  declareAdvanceAction,
  setAdvanceRequirementAction,
  type AdvanceActionState,
} from "./actions";

type Action = (prev: AdvanceActionState, formData: FormData) => Promise<AdvanceActionState>;

// Un operation_uuid par saisie : un nouvel envoi après une réponse perdue
// réutilise le même identifiant (rejeu idempotent côté serveur) ; il n'est
// renouvelé qu'après un succès confirmé.
// L'UUID initial vient du rendu serveur (prop) : identique au HTML hydraté,
// jamais retiré au hasard une seconde fois côté client.
function useOperation(action: Action, initialOperationUuid: string) {
  const [operationUuid, setOperationUuid] = useState(initialOperationUuid);
  const [state, formAction, pending] = useActionState<AdvanceActionState, FormData>(async (prev, formData) => {
    const result = await action(prev, formData);
    if (result && "ok" in result) setOperationUuid(crypto.randomUUID());
    return result;
  }, null);
  return { operationUuid, state, formAction, pending, error: state && "error" in state ? state.error : null };
}

const MODES: [string, string][] = [
  ["ORANGE_MONEY", "Orange Money"],
  ["MOOV_MONEY", "Moov Money"],
  ["CASH", "Espèces"],
  ["BANK", "Virement bancaire"],
  ["OTHER", "Autre"],
];

export function RequirementForm({ projectId, expectedRevision, hasRequirement, initialOperationUuid }: { projectId: string; expectedRevision: number; hasRequirement: boolean; initialOperationUuid: string }) {
  const op = useOperation(setAdvanceRequirementAction, initialOperationUuid);
  return (
    <form action={op.formAction} className="flex flex-col gap-2">
      <input type="hidden" name="project_id" value={projectId} />
      <input type="hidden" name="operation_uuid" value={op.operationUuid} />
      <input type="hidden" name="expected_revision" value={expectedRevision} />
      {op.error ? <AlertBanner variant="error" title="Enregistrement impossible" explanation={op.error} /> : null}
      <TextField label="Avance exigée (FCFA)" name="amount" inputMode="numeric" required />
      <Button type="submit" size="compact" loading={op.pending}>
        {hasRequirement ? "Enregistrer une nouvelle version" : "Fixer l'avance exigée"}
      </Button>
    </form>
  );
}

export function DeclareForm({ projectId, expectedRevision, isContractor, initialOperationUuid }: { projectId: string; expectedRevision: number; isContractor: boolean; initialOperationUuid: string }) {
  const op = useOperation(declareAdvanceAction, initialOperationUuid);
  return (
    <form action={op.formAction} className="flex flex-col gap-2">
      <input type="hidden" name="project_id" value={projectId} />
      <input type="hidden" name="operation_uuid" value={op.operationUuid} />
      <input type="hidden" name="expected_revision" value={expectedRevision} />
      {op.error ? <AlertBanner variant="error" title="Déclaration impossible" explanation={op.error} /> : null}
      <TextField label={isContractor ? "Montant reçu (FCFA)" : "Montant payé (FCFA)"} name="amount" inputMode="numeric" required />
      <TextField label="Date du versement" name="payment_date" type="date" required />
      <label className="flex flex-col gap-1 text-label text-ink">
        Mode de versement
        <select name="mode" required className="rounded-md border border-sand p-2 text-body text-ink">
          {MODES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <TextField label="Référence de l'opérateur (facultatif)" name="reference" maxLength={120} />
      <label className="flex items-start gap-2 text-caption text-ink">
        <input type="checkbox" name="disclaimer_ack" required className="mt-1" />
        J&apos;ai compris que ChantierLive enregistre une déclaration : l&apos;application ne détient, ne reçoit ni ne transfère aucun argent.
      </label>
      <Button type="submit" size="compact" loading={op.pending}>
        {isContractor ? "Déclarer un versement reçu" : "Déclarer un versement effectué"}
      </Button>
    </form>
  );
}

export function AdvanceActions({
  projectId,
  advanceId,
  expectedRevision,
  confirmLabel,
  canConfirm,
  canDispute,
  canCancel,
  initialOperationUuid,
}: {
  initialOperationUuid: string;
  projectId: string;
  advanceId: string;
  expectedRevision: number;
  confirmLabel: string;
  canConfirm: boolean;
  canDispute: boolean;
  canCancel: boolean;
}) {
  const op = useOperation(actOnAdvanceAction, initialOperationUuid);
  if (!canConfirm && !canDispute && !canCancel) return null;
  return (
    <form action={op.formAction} className="flex flex-col gap-2">
      <input type="hidden" name="project_id" value={projectId} />
      <input type="hidden" name="advance_id" value={advanceId} />
      <input type="hidden" name="operation_uuid" value={op.operationUuid} />
      <input type="hidden" name="expected_revision" value={expectedRevision} />
      {op.error ? <AlertBanner variant="error" title="Action impossible" explanation={op.error} /> : null}
      {canDispute || canCancel ? <TextField label="Motif (contestation ou annulation)" name="reason" maxLength={1000} /> : null}
      <div className="flex flex-wrap gap-2">
        {canConfirm ? (
          <Button type="submit" name="command" value="CONFIRM" size="compact" loading={op.pending}>
            {confirmLabel}
          </Button>
        ) : null}
        {canDispute ? (
          <Button type="submit" name="command" value="DISPUTE" variant="secondary" size="compact" loading={op.pending}>
            Contester
          </Button>
        ) : null}
        {canCancel ? (
          <Button type="submit" name="command" value="CANCEL" variant="danger" size="compact" loading={op.pending}>
            Annuler ma déclaration
          </Button>
        ) : null}
      </div>
    </form>
  );
}

export function ReceiptForm({ projectId, advanceId, initialOperationUuid }: { projectId: string; advanceId: string; initialOperationUuid: string }) {
  const op = useOperation(attachAdvanceReceiptAction, initialOperationUuid);
  // Soumission sans réinitialisation automatique du formulaire (React 19) :
  // après un échec, le fichier choisi et l'operation_uuid sont conservés pour
  // une nouvelle tentative idempotente.
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        startTransition(() => op.formAction(formData));
      }}
      className="flex flex-col gap-2"
    >
      <input type="hidden" name="project_id" value={projectId} />
      <input type="hidden" name="advance_id" value={advanceId} />
      <input type="hidden" name="operation_uuid" value={op.operationUuid} />
      {op.error ? <AlertBanner variant="error" title="Justificatif refusé" explanation={op.error} /> : null}
      <label className="flex flex-col gap-1 text-label text-ink">
        Justificatif (facultatif, PDF, JPEG ou PNG, 10 Mo au plus)
        <input type="file" name="file" accept="application/pdf,image/jpeg,image/png" required className="text-caption" />
      </label>
      <Button type="submit" size="compact" variant="secondary" loading={op.pending}>
        Joindre le justificatif
      </Button>
    </form>
  );
}
