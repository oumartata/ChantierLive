import { cn } from "@/lib/cn";

export type SkeletonVariant = "list" | "card" | "detail";

export interface SkeletonProps {
  variant?: SkeletonVariant;
  className?: string;
}

const VARIANT: Record<SkeletonVariant, string> = {
  list: "h-6 w-full",
  card: "h-32 w-full rounded-medium",
  detail: "h-48 w-full rounded-medium",
};

// UI_COMPONENTS.csv C033: "Chargement sans déplacement majeur" — dimensions
// fixes par variante pour éviter tout saut de mise en page.
export function Skeleton({ variant = "card", className }: SkeletonProps) {
  return (
    <div
      role="presentation"
      aria-hidden="true"
      className={cn("animate-pulse rounded-small bg-muted/20", VARIANT[variant], className)}
    />
  );
}
