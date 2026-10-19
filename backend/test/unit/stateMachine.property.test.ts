import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  ALLOWED_TRANSITIONS,
  applyTransition,
  CANONICAL_EVENT_TYPES,
  PAYMENT_STATES,
  type CanonicalEvent,
  type PaymentState,
} from '../../src/domain/stateMachine.js';

const disputeResolutionTarget = fc.constantFrom<PaymentState>('captured', 'settled');
const nonDisputeWonEventTypes = CANONICAL_EVENT_TYPES.filter((type) => type !== 'dispute_won');

const eventArbitrary: fc.Arbitrary<CanonicalEvent> = fc.oneof(
  fc.constantFrom(...nonDisputeWonEventTypes).map((type): CanonicalEvent => ({ type })),
  disputeResolutionTarget.map((resolvedTarget): CanonicalEvent => ({
    type: 'dispute_won',
    resolvedTarget,
  })),
);

function runSequence(start: PaymentState, events: readonly CanonicalEvent[]): PaymentState {
  let state = start;
  for (const event of events) {
    const outcome = applyTransition(state, event);
    if (outcome.kind === 'transitioned') {
      state = outcome.to;
    }
  }
  return state;
}

describe('state machine properties', () => {
  it('every reported transition corresponds to a real edge in ALLOWED_TRANSITIONS', () => {
    fc.assert(
      fc.property(fc.array(eventArbitrary, { maxLength: 30 }), (events) => {
        let state: PaymentState = 'created';
        for (const event of events) {
          const outcome = applyTransition(state, event);

          if (outcome.kind === 'late') {
            expect(PAYMENT_STATES).toContain(outcome.currentState);
            continue;
          }

          expect(PAYMENT_STATES).toContain(outcome.to);
          const transitionsFromState = ALLOWED_TRANSITIONS[outcome.from];
          const declaredTarget = transitionsFromState?.[event.type];
          const declaredTargets = Array.isArray(declaredTarget) ? declaredTarget : [declaredTarget];
          expect(declaredTargets).toContain(outcome.to);
          state = outcome.to;
        }
      }),
    );
  });

  it('re-delivering the same event twice in a row is a no-op the second time', () => {
    fc.assert(
      fc.property(fc.array(eventArbitrary, { minLength: 1, maxLength: 20 }), (events) => {
        const stateBeforeLastEvent = runSequence('created', events.slice(0, -1));
        const lastEvent = events[events.length - 1]!;

        const firstOutcome = applyTransition(stateBeforeLastEvent, lastEvent);
        const stateAfterFirstDelivery =
          firstOutcome.kind === 'transitioned' ? firstOutcome.to : firstOutcome.currentState;

        const secondOutcome = applyTransition(stateAfterFirstDelivery, lastEvent);
        const stateAfterSecondDelivery =
          secondOutcome.kind === 'transitioned' ? secondOutcome.to : secondOutcome.currentState;

        expect(stateAfterSecondDelivery).toBe(stateAfterFirstDelivery);
      }),
    );
  });
});
