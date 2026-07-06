import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TRANSITIONS,
  applyTransition,
  InvalidTransitionError,
  PAYMENT_STATES,
  TERMINAL_STATES,
} from '../../src/domain/stateMachine.js';

describe('applyTransition — happy paths', () => {
  it('walks the full CIT card-payment happy path', () => {
    let state = applyTransition('created', { type: 'authorization_started' });
    expect(state).toEqual({ kind: 'transitioned', from: 'created', to: 'authorizing' });

    state = applyTransition('authorizing', { type: 'authorized' });
    expect(state).toEqual({ kind: 'transitioned', from: 'authorizing', to: 'authorized' });

    state = applyTransition('authorized', { type: 'capture_started' });
    expect(state).toEqual({ kind: 'transitioned', from: 'authorized', to: 'capturing' });

    state = applyTransition('capturing', { type: 'captured' });
    expect(state).toEqual({ kind: 'transitioned', from: 'capturing', to: 'captured' });

    state = applyTransition('captured', { type: 'settled' });
    expect(state).toEqual({ kind: 'transitioned', from: 'captured', to: 'settled' });
  });

  it('walks the 3DS challenge path', () => {
    let state = applyTransition('created', { type: 'authentication_required' });
    expect(state).toEqual({ kind: 'transitioned', from: 'created', to: 'requires_action' });

    state = applyTransition('requires_action', { type: 'authentication_completed' });
    expect(state).toEqual({ kind: 'transitioned', from: 'requires_action', to: 'authorizing' });
  });

  it('walks the refund path, including a second partial refund', () => {
    let state = applyTransition('captured', { type: 'refund_started' });
    expect(state).toEqual({ kind: 'transitioned', from: 'captured', to: 'refund_pending' });

    state = applyTransition('refund_pending', { type: 'refunded' });
    expect(state).toEqual({ kind: 'transitioned', from: 'refund_pending', to: 'refunded' });

    // A second partial refund cycles back through refund_pending.
    state = applyTransition('refunded', { type: 'refund_started' });
    expect(state).toEqual({ kind: 'transitioned', from: 'refunded', to: 'refund_pending' });
  });

  it('allows a dispute after settlement (settled is not a strict sink)', () => {
    const state = applyTransition('settled', { type: 'dispute_opened' });
    expect(state).toEqual({ kind: 'transitioned', from: 'settled', to: 'dispute_opened' });
  });

  it('resolves dispute_won back to the state the dispute opened from, via resolvedTarget', () => {
    const wonFromCaptured = applyTransition('dispute_opened', {
      type: 'dispute_won',
      resolvedTarget: 'captured',
    });
    expect(wonFromCaptured).toEqual({
      kind: 'transitioned',
      from: 'dispute_opened',
      to: 'captured',
    });

    const wonFromSettled = applyTransition('dispute_opened', {
      type: 'dispute_won',
      resolvedTarget: 'settled',
    });
    expect(wonFromSettled).toEqual({ kind: 'transitioned', from: 'dispute_opened', to: 'settled' });
  });

  it('throws when dispute_won is missing the required resolvedTarget', () => {
    expect(() => applyTransition('dispute_opened', { type: 'dispute_won' })).toThrow(
      InvalidTransitionError,
    );
  });

  it('throws when resolvedTarget is not one of the allowed targets', () => {
    expect(() =>
      applyTransition('dispute_opened', { type: 'dispute_won', resolvedTarget: 'created' }),
    ).toThrow(InvalidTransitionError);
  });
});

describe('applyTransition — terminal states never move', () => {
  it.each([...TERMINAL_STATES])(
    'any event from terminal state "%s" is late, not an error',
    (state) => {
      const outcome = applyTransition(state, { type: 'authorized' });
      expect(outcome).toEqual({ kind: 'late', currentState: state });
    },
  );
});

describe('applyTransition — late / out-of-order events', () => {
  it('records a recognized-but-inapplicable event as late rather than throwing', () => {
    // "authorized" is only valid from "authorizing"; replaying it once
    // the payment has already moved to "authorized" must not throw.
    const outcome = applyTransition('authorized', { type: 'authorized' });
    expect(outcome).toEqual({ kind: 'late', currentState: 'authorized' });
  });

  it('a duplicate "captured" webhook after capture already recorded is late, not an error', () => {
    const outcome = applyTransition('captured', { type: 'captured' });
    expect(outcome).toEqual({ kind: 'late', currentState: 'captured' });
  });
});

describe('applyTransition — genuinely invalid events', () => {
  it('throws InvalidTransitionError for an event type absent from the whole table', () => {
    expect(() =>
      // @ts-expect-error deliberately invalid event type for the test
      applyTransition('created', { type: 'not_a_real_event' }),
    ).toThrow(InvalidTransitionError);
  });
});

describe('ALLOWED_TRANSITIONS table sanity', () => {
  it('every target state referenced in the table is a known PaymentState', () => {
    for (const state of PAYMENT_STATES) {
      const transitions = ALLOWED_TRANSITIONS[state];
      if (!transitions) continue;
      for (const target of Object.values(transitions)) {
        const targets = Array.isArray(target) ? target : [target];
        for (const t of targets) {
          expect(PAYMENT_STATES).toContain(t);
        }
      }
    }
  });

  it('no terminal state has any outgoing transitions defined', () => {
    for (const state of TERMINAL_STATES) {
      expect(ALLOWED_TRANSITIONS[state]).toBeUndefined();
    }
  });
});
