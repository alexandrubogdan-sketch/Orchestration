import type { AttemptResult } from '../adapters/types.js';
import type { CanonicalEvent } from '../domain/stateMachine.js';

/**
 * Maps a synchronous `AttemptResult` (from `adapter.createPayment`/
 * `capture`/`void`) to the canonical event(s) needed to walk the state
 * machine there from the payment's current state — the API-response
 * counterpart to what an async webhook does via `normalizeEvent`
 * (Milestone 3). Both paths ultimately call
 * `applyCanonicalEvents`/`transition()`, so a payment created via a
 * synchronous PSP response and one confirmed later via webhook end up
 * in the exact same place through the exact same law (Non-negotiable
 * #5) — this module just describes what the FIRST synchronous
 * response, specifically, implies.
 */
export function initialAttemptEvents(result: AttemptResult): CanonicalEvent[] {
  if (result.status === 'requires_action') {
    return [{ type: 'authentication_required' }];
  }

  const events: CanonicalEvent[] = [{ type: 'authorization_started' }];
  switch (result.status) {
    case 'authorized':
      events.push({ type: 'authorized' });
      break;
    case 'captured':
      events.push({ type: 'authorized' }, { type: 'capture_started' }, { type: 'captured' });
      break;
    case 'declined':
      events.push({ type: 'declined', declineCode: result.decline?.normalizedCode });
      break;
    case 'failed':
      events.push({ type: 'authorization_failed' });
      break;
    default:
      // 'pending': the payment sits in 'authorizing' awaiting a webhook
      // (Milestone 3) or a gap-detection poll (T3.5) to move it further.
      break;
  }
  return events;
}

export function captureAttemptEvents(result: AttemptResult): CanonicalEvent[] {
  if (result.status === 'captured') {
    return [{ type: 'capture_started' }, { type: 'captured' }];
  }
  if (result.status === 'declined') {
    return [{ type: 'declined', declineCode: result.decline?.normalizedCode }];
  }
  return [];
}

export function voidAttemptEvents(result: AttemptResult): CanonicalEvent[] {
  return result.status === 'voided' ? [{ type: 'voided' }] : [];
}

export function refundAttemptEvents(): CanonicalEvent[] {
  return [{ type: 'refund_started' }, { type: 'refunded' }];
}
