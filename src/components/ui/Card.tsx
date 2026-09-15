import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

// UI_KIT_SPEC.yaml card: padding {mobile: 16, desktop: 20}, radius: 12.
export function Card({ children, className, ...props }: CardProps) {
  return (
    <div
      className={cn("rounded-medium bg-surface p-4 shadow-card md:p-5", className)}
      {...props}
    >
      {children}
    </div>
  );
}
