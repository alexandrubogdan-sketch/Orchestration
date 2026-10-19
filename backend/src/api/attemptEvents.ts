import type { AttemptResult } from '../adapters/types.js';
import type { CanonicalEvent } from '../domain/stateMachine.js';

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
