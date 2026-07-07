/**
 * Classification of the `state` string returned by
 * `POST /checkout/{id}/confirm`.
 *
 * DELIBERATELY ISOLATED: the backend's confirm response is a live,
 * evolving contract (see payment-orchestrator-go's
 * internal/domain/statemachine.go for the canonical state enum:
 * created, requires_action, authorizing, authorized, capturing,
 * captured, refund_pending, refunded, dispute_opened, dispute_won,
 * dispute_lost, declined, voided, failed, settled). Rather than
 * scatter `state.includes("captured")`-style checks across the
 * session/confirm flow, every bit of that string matching lives in
 * this one function so a future contract clarification ("what does
 * `voided` mean for a checkout confirm?") is a one-file fix.
 *
 * Matching rules per the integration spec:
 *   - state contains "captured", "authorized", or "settled"
 *     -> terminal success.
 *   - state contains "declined" or "failed" -> hard failure.
 *   - anything else that arrives with a (PSP) clientSecret present
 *     -> drive 3DS using that secret, then re-check.
 *   - anything else with no clientSecret -> ambiguous/pending; treated
 *     as "requires action" so the merchant integrator can decide
 *     rather than the SDK silently assuming success.
 */

export type PaymentStateClassification =
  | "success"
  | "hard_failure"
  | "drive_action"
  | "pending";

export interface ClassifyPaymentStateInput {
  state: string;
  pspClientSecret?: string | null;
}

export function classifyPaymentState(
  input: ClassifyPaymentStateInput,
): PaymentStateClassification {
  const normalized = input.state.toLowerCase();

  if (
    normalized.includes("captured") ||
    normalized.includes("authorized") ||
    normalized.includes("settled")
  ) {
    return "success";
  }

  if (normalized.includes("declined") || normalized.includes("failed")) {
    return "hard_failure";
  }

  if (input.pspClientSecret) {
    return "drive_action";
  }

  return "pending";
}
