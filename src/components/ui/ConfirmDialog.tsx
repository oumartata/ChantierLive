"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

export type ConfirmDialogVariant = "standard" | "double_confirmation";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  consequence: string;
  permanence?: string;
  variant?: ConfirmDialogVariant;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

// CONTENT_RULES.yaml confirmations.structure: [action, consequence,
// permanence, confirm_or_cancel]. Utilise <dialog> natif : piégeage du
// focus et fermeture au clavier (Échap) fournis par le navigateur, sans
// dépendance supplémentaire.
export function ConfirmDialog({
  open,
  title,
  consequence,
  permanence,
  variant = "standard",
  confirmLabel = "Confirmer",
  cancelLabel = "Annuler",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const requiresAcknowledgement = variant === "double_confirmation";
  const canConfirm = !requiresAcknowledgement || acknowledged;

  return (
    <dialog
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      className={cn(
        "w-full max-w-[520px] rounded-large bg-surface p-6 text-ink shadow-modal",
        "backdrop:bg-ink/40"
      )}
    >
      <p className="text-h2 font-semibold">{title}</p>
      <p className="pt-2 text-body">{consequence}</p>
      {permanence ? <p className="pt-1 text-caption text-muted">{permanence}</p> : null}
      {requiresAcknowledgement ? (
        // key={open}: force un remontage à chaque ouverture pour repartir
        // d'une case non cochée, sans réinitialiser l'état via un effet.
        <AcknowledgementCheckbox key={String(open)} onChange={setAcknowledged} />
      ) : null}
      <div className="mt-6 flex justify-end gap-3">
        <Button variant="ghost" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button variant="danger" onClick={onConfirm} disabled={!canConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}

function AcknowledgementCheckbox({ onChange }: { onChange: (checked: boolean) => void }) {
  const id = useId();
  const [checked, setChecked] = useState(false);

  // Synchronise l'état local vers le parent, y compris à l'état initial
  // (non coché) juste après le remontage déclenché par key={open} — sans
  // quoi le bouton Confirmer pourrait rester activé d'une ouverture à l'autre.
  useEffect(() => {
    onChange(checked);
  }, [checked, onChange]);

  return (
    <label htmlFor={id} className="mt-4 flex items-center gap-2 text-body">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => setChecked(event.target.checked)}
        className="h-4 w-4"
      />
      J&apos;ai compris les conséquences de cette action.
    </label>
  );
}
