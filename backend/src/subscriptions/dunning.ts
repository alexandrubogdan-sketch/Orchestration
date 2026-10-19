import { canRetrySameInstrument } from '../routing/retryPolicy.js';

export const DUNNING_LADDER_HOURS: readonly number[] = [24, 72, 168] as const;

export interface DunningDecision {
  allowed: boolean;
  reason: string;
  nextStage: number;
  nextRetryAt?: Date;
}

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
