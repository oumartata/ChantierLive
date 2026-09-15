import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface EmptyStateProps {
  title: string;
  description: string;
  action?: ReactNode;
  className?: string;
}

// UI_COMPONENTS.csv C016: "Expliquer l'absence et l'action suivante".
export function EmptyState({ title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-2 rounded-medium bg-sand p-6 text-center",
        className
      )}
    >
      <p className="text-h3 text-ink">{title}</p>
      <p className="text-body text-muted">{description}</p>
      {action ? <div className="pt-2">{action}</div> : null}
    </div>
  );
}
