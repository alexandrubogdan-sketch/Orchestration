import { Badge, type BadgeTone } from "@/components/ui/badge";
import type { PaymentState, RetryAttemptOutcome } from "@/lib/types";

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

const RETRY_ATTEMPT_OUTCOME_TONE: Record<RetryAttemptOutcome, BadgeTone> = {
  succeeded: "success",
  declined: "danger",
  failed: "danger",
};

export function RetryOutcomeBadge({ outcome }: { outcome: RetryAttemptOutcome }) {
  return <Badge tone={RETRY_ATTEMPT_OUTCOME_TONE[outcome]}>{outcome}</Badge>;
}
