"use client";

import { useActionState, useState } from "react";
import { Button, AlertBanner, TextField } from "@/components/ui";
import { createEstimateAction, type QuoteActionState } from "./actions";

interface LineInput {
  label: string;
  unit: string;
  quantity: string;
  unit_price_fcfa: string;
}

const EMPTY_LINE: LineInput = { label: "", unit: "", quantity: "", unit_price_fcfa: "" };

// Estimation privée (D116) : les valeurs restent en texte jusqu'au serveur,
// qui vérifie les formats et calcule seul les montants (D115).
export function EstimateForm({ projectId, expectedRevision }: { projectId: string; expectedRevision: number }) {
  const [state, formAction, pending] = useActionState<QuoteActionState, FormData>(createEstimateAction, null);
  const [lines, setLines] = useState<LineInput[]>([{ ...EMPTY_LINE }]);

  function update(index: number, field: keyof LineInput, value: string) {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, [field]: value } : line)));
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="project_id" value={projectId} />
      <input type="hidden" name="expected_revision" value={expectedRevision} />
      <input type="hidden" name="lines" value={JSON.stringify(lines)} />
      {state?.error ? <AlertBanner variant="error" title="Estimation impossible" explanation={state.error} /> : null}
      {lines.map((line, index) => (
        <fieldset key={index} className="flex flex-col gap-2 border-b border-sand pb-3">
          <legend className="text-caption font-semibold text-ink">Ligne {index + 1}</legend>
          <TextField label="Prestation" value={line.label} onChange={(e) => update(index, "label", e.target.value)} />
          <TextField label="Unité (m², forfait…)" value={line.unit} onChange={(e) => update(index, "unit", e.target.value)} />
          <TextField label="Quantité" inputMode="decimal" value={line.quantity} onChange={(e) => update(index, "quantity", e.target.value)} />
          <TextField label="Prix unitaire (FCFA)" inputMode="numeric" value={line.unit_price_fcfa} onChange={(e) => update(index, "unit_price_fcfa", e.target.value)} />
        </fieldset>
      ))}
      <Button type="button" size="compact" variant="secondary" onClick={() => setLines((current) => [...current, { ...EMPTY_LINE }])}>
        Ajouter une ligne
      </Button>
      <Button type="submit" size="compact" loading={pending}>
        Enregistrer l&apos;estimation
      </Button>
    </form>
  );
}
