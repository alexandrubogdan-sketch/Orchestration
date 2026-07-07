import { Badge, type BadgeTone } from "@/components/ui/badge";
import type { PaymentState } from "@/lib/types";

const PAYMENT_STATE_TONE: Record<PaymentState, BadgeTone> = {
  created: "neutral",
  requires_action: "warning",
  authorizing: "neutral",
  authorized: "info",
  capturing: "info",
  captured: "success",
  refund_pending: "warning",
  refunded: "neutral",
  dispute_opened: "danger",
  dispute_won: "success",
  dispute_lost: "danger",
  declined: "danger",
  voided: "neutral",
  failed: "danger",
  settled: "success",
};

export function PaymentStateBadge({ state }: { state: PaymentState }) {
  return <Badge tone={PAYMENT_STATE_TONE[state]}>{state.replace(/_/g, " ")}</Badge>;
}
