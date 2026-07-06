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

/**
 * T1.7 property tests (see docs/adr/0004-property-testing-fast-check.md
 * for why fast-check). Two properties, straight from SPEC.md:
 *
 * 1. "random sequences of canonical events never yield a state outside
 *    the transition table" — every transition the pure state machine
 *    reports must correspond to a real edge in ALLOWED_TRANSITIONS.
 * 2. "replaying any event sequence twice is a no-op."
 *
 * Property 2's scope was corrected by this very test suite during
 * development: the first formulation tried ("run an arbitrary sequence,
 * then run the *whole sequence* again from the end state") is FALSE in
 * general — fast-check found a real counterexample:
 * `[authorized, authorization_started]` from `created` ends at
 * `authorizing` (the first event is late from `created`, the second
 * transitions); replaying the same two events again from `authorizing`
 * ends at `authorized` instead (now the first event is a real
 * transition, since state has moved). That's not a state-machine bug —
 * it's that "replay the sequence" isn't the guarantee SPEC.md's
 * webhook-dedup concern actually needs. In the real pipeline (Milestone
 * 3), the exact same *event* is what gets redelivered at-least-once
 * (deduped upstream by `webhook_inbox`'s unique `(psp,
 * provider_event_id)` constraint before it ever reaches this state
 * machine), not an arbitrary already-applied *sequence*. The correctly
 * scoped property is per-event: delivering the identical event twice in
 * immediate succession must be a no-op the second time. That's what the
 * second test below checks, and it holds for every event in
 * ALLOWED_TRANSITIONS by construction (no event's target state accepts
 * that same event type as a further transition).
 */

const disputeResolutionTarget = fc.constantFrom<PaymentState>('captured', 'settled');
const nonDisputeWonEventTypes = CANONICAL_EVENT_TYPES.filter((type) => type !== 'dispute_won');

// fc.oneof (rather than .chain()) so each branch's shape is a plain,
// independently-typed Arbitrary<CanonicalEvent> — chaining on a union
// discriminant here confuses TS into unifying the branches into a
// single shape instead of a proper union.
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
