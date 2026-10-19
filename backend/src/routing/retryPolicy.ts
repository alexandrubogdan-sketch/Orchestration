import { isHardDecline, type NormalizedDecline } from '../domain/declines.js';

export interface RetryPolicyConfig {
  maxAttemptsPerPayment: number;

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

export function hasSufficientSpacing(
  lastAttemptAt: Date,
  now: Date = new Date(),
  config: RetryPolicyConfig = RETRY_POLICY,
): boolean {
  return now.getTime() - lastAttemptAt.getTime() >= config.minSpacingMs;
}
