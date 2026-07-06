import { cn } from "@/lib/utils";
import { AlertTriangle, Info, Lightbulb, ShieldAlert } from "lucide-react";
import type { HTMLAttributes } from "react";

export type CalloutTone = "info" | "warning" | "danger" | "tip";

const TONE_CLASSES: Record<CalloutTone, string> = {
  info: "border-info/30 bg-info-bg text-info",
  warning: "border-warning/30 bg-warning-bg text-warning",
  danger: "border-danger/30 bg-danger-bg text-danger",
  tip: "border-accent/30 bg-accent/10 text-accent",
};

const TONE_ICON: Record<CalloutTone, typeof Info> = {
  info: Info,
  warning: AlertTriangle,
  danger: ShieldAlert,
  tip: Lightbulb,
};

export interface CalloutProps extends HTMLAttributes<HTMLDivElement> {
  tone?: CalloutTone;
  title?: string;
}

/**
 * Docs-only callout box. Used to flag known gaps, mock-only behavior,
 * and other "be honest about it" notes — matching the tone the backend's
 * ADRs and this frontend's README already use.
 */
export function Callout({ tone = "info", title, className, children, ...props }: CalloutProps) {
  const Icon = TONE_ICON[tone];
  return (
    <div
      className={cn(
        "flex gap-3 rounded-lg border px-4 py-3 text-sm leading-relaxed",
        TONE_CLASSES[tone],
        className,
      )}
      {...props}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="text-foreground">
        {title ? <div className="mb-1 font-semibold">{title}</div> : null}
        <div className="text-muted-foreground">{children}</div>
      </div>
    </div>
  );
}
