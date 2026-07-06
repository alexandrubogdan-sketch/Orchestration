import { isHardDecline, type NormalizedDecline } from '../domain/declines.js';

/**
 * T5.4: "Central retry-policy config; unit tests prove hard-decline
 * attempts are refused." One place every retry path (same-session
 * retries today; Milestone 8's dunning ladder later) must consult
 * before scheduling another attempt on the SAME instrument —
 * Non-negotiable #9's "retry counts/spacing per payment are capped in
 * one config."
 *
 * This governs same-instrument retries only. Cross-PSP failover for
 * `technical` failures is a completely separate decision, governed by
 * `isEligibleForPspFailover` (src/domain/declines.ts) and the circuit
 * breaker (T5.3) — a hard decline can still legitimately cause a
 * routing failover attempt on a *different* instrument or a customer
 * retry with a *different* card; what this module refuses is ever
 * re-trying the exact same card against a hard/fraud decline.
 */
export interface RetryPolicyConfig {
  /** Maximum total attempts (including the first) for a single payment. */
  maxAttemptsPerPayment: number;
  /** Minimum spacing between attempts on the same payment. */
  minSpacingMs: number;
}

export const RETRY_POLICY: RetryPolicyConfig = {
  maxAttemptsPerPayment: 3,
  minSpacingMs: 2_000,
};

export interface RetryDecision {
  allowed: boolean;
  reason: string;
}

/**
 * `attemptsSoFar` counts attempts already made (i.e. before the one
 * being considered) — passing `attemptsSoFar: config.maxAttemptsPerPayment`
 * means the payment has already used its full budget.
 */
export function canRetrySameInstrument(
  decline: Pick<NormalizedDecline, 'retryClass'>,
  attemptsSoFar: number,
  config: RetryPolicyConfig = RETRY_POLICY,
): RetryDecision {
  if (isHardDecline(decline)) {
    return { allowed: false, reason: 'hard decline: never retried on the same instrument' };
  }
  if (decline.retryClass === 'review') {
    return {
      allowed: false,
      reason: 'unmapped/review-class decline: requires manual review before any retry',
    };
  }
  if (attemptsSoFar >= config.maxAttemptsPerPayment) {
    return {
      allowed: false,
      reason: `max attempts per payment (${config.maxAttemptsPerPayment}) already reached`,
    };
  }
  return { allowed: true, reason: `retryClass "${decline.retryClass}" permits a further attempt` };
}

/** True if enough time has passed since the last attempt per `minSpacingMs`. */
export function hasSufficientSpacing(
  lastAttemptAt: Date,
  now: Date = new Date(),
  config: RetryPolicyConfig = RETRY_POLICY,
): boolean {
  return now.getTime() - lastAttemptAt.getTime() >= config.minSpacingMs;
}
