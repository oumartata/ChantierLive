import { cn } from "@/lib/cn";

export type ToastVariant = "success" | "info" | "error";

export interface ToastProps {
  variant?: ToastVariant;
  message: string;
  className?: string;
}

const VARIANT: Record<ToastVariant, string> = {
  success: "bg-success text-surface",
  info: "bg-ink text-surface",
  error: "bg-danger text-surface",
};

export function Toast({ variant = "info", message, className }: ToastProps) {
  return (
    <div
      role="status"
      aria-live={variant === "error" ? "assertive" : "polite"}
      className={cn(
        "rounded-medium px-4 py-3 text-label font-semibold shadow-modal",
        VARIANT[variant],
        className
      )}
    >
      {message}
    </div>
  );
}
