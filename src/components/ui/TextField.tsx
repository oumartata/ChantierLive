import { useId, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export interface TextFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "id"> {
  label: string;
  error?: string;
  className?: string;
}

// UI_KIT_SPEC.yaml text_field: "libellé toujours visible" — pas de mode
// "placeholder seul comme libellé" (voir CONTENT_RULES.yaml
// accessibility.placeholder_as_only_label: false).
export function TextField({
  label,
  error,
  required,
  disabled,
  className,
  ...props
}: TextFieldProps) {
  const id = useId();
  const errorId = error ? `${id}-error` : undefined;

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <label htmlFor={id} className="text-label font-semibold text-ink">
        {label}
        {required ? (
          <span aria-hidden="true" className="text-danger">
            {" "}
            *
          </span>
        ) : null}
      </label>
      <input
        id={id}
        required={required}
        disabled={disabled}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={errorId}
        className={cn(
          "h-12 rounded-small border bg-surface px-4 text-body text-ink",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
          "disabled:cursor-not-allowed disabled:opacity-50",
          error ? "border-danger" : "border-muted"
        )}
        {...props}
      />
      {error ? (
        <p id={errorId} role="alert" className="text-caption text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
