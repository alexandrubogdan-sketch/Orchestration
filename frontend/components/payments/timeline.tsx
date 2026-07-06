import { Badge } from "@/components/ui/badge";
import type { PaymentTimelineEvent, TimelineEventType } from "@/lib/types";
import { cn, formatDateTime } from "@/lib/utils";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock,
  Coins,
  RefreshCcw,
  ScanFace,
  Undo2,
} from "lucide-react";

const EVENT_META: Record<
  TimelineEventType,
  { label: string; icon: typeof Clock; tone: "success" | "danger" | "warning" | "info" | "neutral" }
> = {
  started: { label: "Payment started", icon: Clock, tone: "neutral" },
  authentication_required: { label: "3DS authentication required", icon: ScanFace, tone: "warning" },
  authorized: { label: "Authorized", icon: CheckCircle2, tone: "info" },
  pending: { label: "Pending", icon: Clock, tone: "neutral" },
  captured: { label: "Captured", icon: Coins, tone: "success" },
  declined: { label: "Declined", icon: Ban, tone: "danger" },
  refund_pending: { label: "Refund initiated", icon: Undo2, tone: "warning" },
  refunded: { label: "Refunded", icon: Undo2, tone: "neutral" },
  settled: { label: "Settled", icon: CheckCircle2, tone: "success" },
  dispute_opened: { label: "Dispute opened", icon: AlertTriangle, tone: "danger" },
  dispute_closed: { label: "Dispute closed", icon: CheckCircle2, tone: "success" },
  late_event: { label: "Late / duplicate event recorded", icon: RefreshCcw, tone: "neutral" },
  invariant_violation: { label: "Invariant violation", icon: AlertTriangle, tone: "danger" },
};

const TONE_DOT: Record<string, string> = {
  success: "bg-success",
  danger: "bg-danger",
  warning: "bg-warning",
  info: "bg-info",
  neutral: "bg-muted",
};

export function PaymentTimeline({ events }: { events: PaymentTimelineEvent[] }) {
  return (
    <ol className="relative flex flex-col gap-6 pl-6">
      <div className="absolute top-1 bottom-1 left-[7px] w-px bg-border" aria-hidden />
      {events.map((event) => {
        const meta = EVENT_META[event.type];
        const Icon = meta.icon;
        return (
          <li key={event.id} className="relative">
            <span
              className={cn(
                "absolute -left-6 top-0.5 h-3.5 w-3.5 rounded-full ring-4 ring-surface",
                TONE_DOT[meta.tone],
              )}
              aria-hidden
            />
            <div className="flex items-center gap-2">
              <Icon className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">{meta.label}</span>
              {event.declineCode ? (
                <Badge tone="danger" className="font-mono text-[10px]">
                  {event.declineCode}
                </Badge>
              ) : null}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">{formatDateTime(event.occurredAt)}</div>
          </li>
        );
      })}
    </ol>
  );
}
