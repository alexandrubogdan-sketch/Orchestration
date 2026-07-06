import { cn } from "@/lib/utils";
import type { HTMLAttributes } from "react";

export type BadgeTone = "success" | "warning" | "danger" | "info" | "neutral" | "accent";

const TONE_CLASSES: Record<BadgeTone, string> = {
  success: "bg-success-bg text-success",
  warning: "bg-warning-bg text-warning",
  danger: "bg-danger-bg text-danger",
  info: "bg-info-bg text-info",
  neutral: "bg-neutral-bg text-muted-foreground",
  accent: "bg-accent/10 text-accent",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export function Badge({ tone = "neutral", className, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium capitalize",
        TONE_CLASSES[tone],
        className,
      )}
      {...props}
    />
  );
}
