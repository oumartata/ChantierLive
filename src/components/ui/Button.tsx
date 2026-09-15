import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "regular" | "compact";

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  children: ReactNode;
  className?: string;
}

const BASE = cn(
  "inline-flex items-center justify-center gap-2 rounded-small px-4",
  "text-label font-semibold transition-colors",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
  "disabled:opacity-50 disabled:pointer-events-none"
);

// UI_KIT_SPEC.yaml: button.height = {regular: 48, compact: 40}.
// min-h-touch (44px, DESIGN_TOKENS.csv touch.minimum) is applied as a floor
// on "compact" because the quality gate "touch target 44x44 minimum" takes
// precedence over the raw compact height value.
const SIZE: Record<ButtonSize, string> = {
  regular: "h-12 px-4",
  compact: "h-10 min-h-touch px-3",
};

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-primary text-surface hover:bg-primary-dark active:bg-primary-dark",
  secondary: "bg-surface text-primary border border-primary hover:bg-sand active:bg-sand",
  ghost: "bg-transparent text-primary hover:bg-sand active:bg-sand",
  danger: "bg-danger text-surface hover:opacity-90 active:opacity-90",
};

export function Button({
  variant = "primary",
  size = "regular",
  loading = false,
  disabled,
  children,
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      type="button"
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={cn(BASE, SIZE[size], VARIANT[variant], className)}
      {...props}
    >
      {loading ? (
        <span
          aria-hidden="true"
          className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      ) : null}
      {children}
    </button>
  );
}
