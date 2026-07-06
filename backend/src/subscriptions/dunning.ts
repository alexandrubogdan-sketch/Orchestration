import { canRetrySameInstrument } from '../routing/retryPolicy.js';

/**
 * T8.2: "Dunning ladder engine." A subscription only ever reaches
 * `past_due` (and therefore this ladder) via
 * `markSubscriptionPastDue`, which the renewal dispatcher (T8.1) only
 * calls for a NON-hard decline — a hard/fraud decline cancels the
 * subscription immediately instead. So by the time this module is
 * consulted, "is this retryable at all" has already been answered;
 * this ladder's job is purely "how many more times, how far apart."
 *
 * Delays are hours after the PREVIOUS attempt, indexed by
 * `dunning_stage` (1-based: stage 1 is the first dunning retry after
 * the original renewal failure, ..., stage `DUNNING_LADDER.length` is
 * the last one before giving up).
 */
export const DUNNING_LADDER_HOURS: readonly number[] = [24, 72, 168] as const;

export interface DunningDecision {
  allowed: boolean;
  reason: string;
  nextStage: number;
  nextRetryAt?: Date;
}

/**
 * `currentStage` is the subscription's `dunning_stage` BEFORE this
 * attempt (0 the first time a renewal failed and handed off here).
 * Reuses `canRetrySameInstrument` (Milestone 5, T5.4) purely for its
 * attempt-cap check — the synthetic `retryClass` passed in is always
 * a retryable one by construction (see the module docblock), so that
 * function's hard-decline branch is intentionally unreachable from
 * this call site, not dead code left in by mistake.
 */
export function evaluateDunningStep(currentStage: number, now: Date = new Date()): DunningDecision {
  const decision = canRetrySameInstrument({ retryClass: 'same_instrument_later' }, currentStage, {
    maxAttemptsPerPayment: DUNNING_LADDER_HOURS.length,
    minSpacingMs: 0,
  });

  if (!decision.allowed) {
    return { allowed: false, reason: 'dunning ladder exhausted', nextStage: currentStage };
  }

  const nextStage = currentStage + 1;
  const delayHours = DUNNING_LADDER_HOURS[currentStage]!;
  const nextRetryAt = new Date(now.getTime() + delayHours * 60 * 60 * 1000);
  return {
    allowed: true,
    reason: `stage ${nextStage} of ${DUNNING_LADDER_HOURS.length}, next retry in ${delayHours}h if this one also fails`,
    nextStage,
    nextRetryAt,
  };
}
