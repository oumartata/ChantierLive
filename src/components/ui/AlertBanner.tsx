import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type AlertBannerVariant = "information" | "warning" | "error" | "offline";

export interface AlertBannerProps {
  variant?: AlertBannerVariant;
  title: string;
  explanation: string;
  action?: ReactNode;
  className?: string;
}

const VARIANT: Record<AlertBannerVariant, { container: string; icon: string }> = {
  information: { container: "border-primary/30 bg-sand text-ink", icon: "i" },
  warning: { container: "border-action/40 bg-action/10 text-ink", icon: "!" },
  error: { container: "border-danger/40 bg-danger/10 text-ink", icon: "!" },
  offline: { container: "border-muted/40 bg-muted/10 text-ink", icon: "~" },
};

// UI_KIT_SPEC.yaml alert_banner.structure: [icon, title, explanation, optional_action]
export function AlertBanner({
  variant = "information",
  title,
  explanation,
  action,
  className,
}: AlertBannerProps) {
  const isUrgent = variant === "error" || variant === "warning";
  return (
    <div
      role={isUrgent ? "alert" : "status"}
      className={cn("flex gap-3 rounded-medium border p-4", VARIANT[variant].container, className)}
    >
      <span
        aria-hidden="true"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-small bg-surface text-label font-bold"
      >
        {VARIANT[variant].icon}
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-label font-semibold">{title}</p>
        <p className="text-body">{explanation}</p>
        {action ? <div className="pt-1">{action}</div> : null}
      </div>
    </div>
  );
}
