"use client";

import { useActionState, useState } from "react";
import { Button, AlertBanner, TextField } from "@/components/ui";
import {
  authorizeChangeOrderExecutionAction,
  createChangeOrderEstimateAction,
  decideChangeOrderAction,
  proposeChangeOrderAction,
  type ChangeOrderActionState,
} from "./actions";

interface LineInput {
  label: string;
  unit: string;
  quantity: string;
  unit_price_fcfa: string;
}

const EMPTY_LINE: LineInput = { label: "", unit: "", quantity: "", unit_price_fcfa: "" };
const MAX_LINES = 200;

// Estimation privée d'avenant (D118) : nouvel avenant (changeOrderId absent)
// ou nouvelle version d'un avenant non accepté. Les valeurs restent en texte
// jusqu'au serveur, qui vérifie les formats et calcule seul les montants.
export function ChangeOrderEstimateForm({
  projectId,
  changeOrderId,
  expectedRevision,
  defaultTitle = "",
  defaultReason = "",
  submitLabel,
}: {
  projectId: string;
  changeOrderId?: string;
  expectedRevision: number;
  defaultTitle?: string;
  defaultReason?: string;
  submitLabel: string;
}) {
  const [title, setTitle] = useState(defaultTitle);
  const [reason, setReason] = useState(defaultReason);
  const [lines, setLines] = useState<LineInput[]>([{ ...EMPTY_LINE }]);
  const [state, formAction, pending] = useActionState<ChangeOrderActionState, FormData>(async (prev, formData) => {
    const result = await createChangeOrderEstimateAction(prev, formData);
    if (result === null) {
      setTitle(defaultTitle);
      setReason(defaultReason);
      setLines([{ ...EMPTY_LINE }]);
    }
    return result;
  }, null);

  function update(index: number, field: keyof LineInput, value: string) {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, [field]: value } : line)));
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="project_id" value={projectId} />
      <input type="hidden" name="change_order_id" value={changeOrderId ?? ""} />
      <input type="hidden" name="expected_revision" value={expectedRevision} />
      <input type="hidden" name="lines" value={JSON.stringify(lines)} />
      {state?.error ? <AlertBanner variant="error" title="Enregistrement impossible" explanation={state.error} /> : null}
      <TextField label="Titre de l'avenant" name="title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
      <TextField label="Motif" name="reason" value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
      {lines.map((line, index) => (
        <fieldset key={index} className="flex flex-col gap-2 border-b border-sand pb-3">
          <legend className="text-caption font-semibold text-ink">Ligne {index + 1}</legend>
          <TextField label="Prestation" value={line.label} onChange={(e) => update(index, "label", e.target.value)} />
          <TextField label="Unité (m², forfait…)" value={line.unit} onChange={(e) => update(index, "unit", e.target.value)} />
          <TextField label="Quantité" inputMode="decimal" value={line.quantity} onChange={(e) => update(index, "quantity", e.target.value)} />
          <TextField
            label="Prix unitaire (FCFA)"
            inputMode="numeric"
            value={line.unit_price_fcfa}
            onChange={(e) => update(index, "unit_price_fcfa", e.target.value)}
          />
          {lines.length > 1 ? (
            <Button
              type="button"
              size="compact"
              variant="secondary"
              onClick={() => setLines((current) => current.filter((_, i) => i !== index))}
            >
              Retirer la ligne {index + 1}
            </Button>
          ) : null}
        </fieldset>
      ))}
      {lines.length < MAX_LINES ? (
        <Button type="button" size="compact" variant="secondary" onClick={() => setLines((current) => [...current, { ...EMPTY_LINE }])}>
          Ajouter une ligne
        </Button>
      ) : null}
      <Button type="submit" size="compact" loading={pending}>
        {submitLabel}
      </Button>
    </form>
  );
}

export function ProposeChangeOrderButton({ projectId, versionId, expectedRevision }: { projectId: string; versionId: string; expectedRevision: number }) {
  const [state, formAction, pending] = useActionState<ChangeOrderActionState, FormData>(proposeChangeOrderAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="project_id" value={projectId} />
      <input type="hidden" name="version_id" value={versionId} />
      <input type="hidden" name="expected_revision" value={expectedRevision} />
      {state?.error ? <AlertBanner variant="error" title="Proposition impossible" explanation={state.error} /> : null}
      <Button type="submit" size="compact" loading={pending}>
        Proposer au client
      </Button>
    </form>
  );
}

// Décision du client (D117 : OWNER/PRIMARY seul, revérifié côté serveur).
export function DecideChangeOrderForm({ projectId, versionId, expectedRevision }: { projectId: string; versionId: string; expectedRevision: number }) {
  const [state, formAction, pending] = useActionState<ChangeOrderActionState, FormData>(decideChangeOrderAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="project_id" value={projectId} />
      <input type="hidden" name="version_id" value={versionId} />
      <input type="hidden" name="expected_revision" value={expectedRevision} />
      {state?.error ? <AlertBanner variant="error" title="Décision impossible" explanation={state.error} /> : null}
      <TextField label="Motif de décision (facultatif)" name="reason" maxLength={1000} />
      <div className="flex gap-2">
        <Button type="submit" name="decision" value="ACCEPTED" size="compact" loading={pending}>
          Accepter l&apos;avenant
        </Button>
        <Button type="submit" name="decision" value="REFUSED" variant="danger" size="compact" loading={pending}>
          Refuser
        </Button>
      </div>
    </form>
  );
}

// D125 : acte explicite du CONTRACTOR, unique, après acceptation.
export function AuthorizeExecutionButton({ projectId, changeOrderId, expectedRevision }: { projectId: string; changeOrderId: string; expectedRevision: number }) {
  const [state, formAction, pending] = useActionState<ChangeOrderActionState, FormData>(authorizeChangeOrderExecutionAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="project_id" value={projectId} />
      <input type="hidden" name="change_order_id" value={changeOrderId} />
      <input type="hidden" name="expected_revision" value={expectedRevision} />
      {state?.error ? <AlertBanner variant="error" title="Autorisation impossible" explanation={state.error} /> : null}
      <Button type="submit" size="compact" loading={pending}>
        Autoriser l&apos;exécution de cet avenant
      </Button>
    </form>
  );
}
