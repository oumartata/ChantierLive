import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type StatusChipVariant = "neutral" | "info" | "attention" | "success" | "danger";

export interface StatusChipProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: StatusChipVariant;
  label: string;
}

const VARIANT: Record<StatusChipVariant, string> = {
  neutral: "bg-sand text-ink",
  info: "bg-sand text-primary-dark",
  attention: "bg-action/10 text-action",
  success: "bg-success/10 text-success",
  danger: "bg-danger/10 text-danger",
};

// UI_KIT_SPEC.yaml status_chip: "icône ou mot obligatoire; couleur seule
// interdite" — le libellé texte est donc une prop obligatoire, jamais
// seulement une couleur.
export function StatusChip({ variant = "neutral", label, className, ...props }: StatusChipProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-small px-2 py-1 text-caption font-semibold",
        VARIANT[variant],
        className
      )}
      {...props}
    >
      {label}
    </span>
  );
}
