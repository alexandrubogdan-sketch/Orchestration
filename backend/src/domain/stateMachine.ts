/**
 * The canonical payment state machine — "the state machine is law"
 * (Non-negotiable #5). States and transitions here match
 * docs/design.md §2 exactly; if the two ever diverge, docs/design.md is
 * a bug, not this file (SPEC.md: "Keep docs/design.md in sync... a
 * divergence without an ADR is a defect").
 *
 * This module is split into a pure core (`applyTransition`, below) and
 * a DB-effectful shell (`transition`, in src/domain/stateMachineDb.ts).
 * The pure core is what Milestone 1's property tests (T1.7) exercise —
 * "random sequences of canonical events never yield a state outside the
 * transition table" and "replaying any event sequence twice is a
 * no-op" are both statements about this function alone, with no
 * database involved.
 */

export const PAYMENT_STATES = [
  'created',
  'requires_action',
  'authorizing',
  'authorized',
  'capturing',
  'captured',
  'refund_pending',
  'refunded',
  'dispute_opened',
  'dispute_won',
  'dispute_lost',
  'declined',
  'voided',
  'failed',
  'settled',
] as const;

export type PaymentState = (typeof PAYMENT_STATES)[number];

/**
 * Terminal states never have outgoing edges — once here, every future
 * event for the payment is recorded as a late/duplicate timeline entry,
 * never a state change. `settled` and `refunded` are deliberately NOT
 * in this set: a settled payment can still be disputed (chargebacks
 * land after settlement), and a refunded payment can receive further
 * partial refunds — see docs/design.md §2, rule 3.
 */
export const TERMINAL_STATES: ReadonlySet<PaymentState> = new Set([
  'declined',
  'voided',
  'failed',
  'dispute_won',
  'dispute_lost',
]);

export const CANONICAL_EVENT_TYPES = [
  'authentication_required',
  'authentication_completed',
  'authentication_failed',
  'authorization_started',
  'authorized',
  'declined',
  'authorization_failed',
  'capture_started',
  'captured',
  'voided',
  'refund_started',
  'refunded',
  'settled',
  'dispute_opened',
  'dispute_won',
  'dispute_lost',
] as const;

export type CanonicalEventType = (typeof CANONICAL_EVENT_TYPES)[number];

export interface CanonicalEvent {
  type: CanonicalEventType;
  /**
   * Required only for events whose target state is ambiguous from
   * table shape alone (currently just `dispute_won`, which can return
   * the payment to whichever state it was in before the dispute opened
   * — `captured` or `settled`). Validated against the allowed target
   * set for the current state/event pair.
   */
  resolvedTarget?: PaymentState | undefined;
  /** Present on `declined` events; carried through onto payment_events. */
  declineCode?: string | undefined;
}

type TransitionTable = {
  [S in PaymentState]?: {
    [E in CanonicalEventType]?: PaymentState | readonly PaymentState[];
  };
};

/**
 * The allowed-transitions table — docs/design.md §2, translated
 * directly into code. Read as: "from this state, this event moves the
 * payment to that state (or one of those states)."
 */
export const ALLOWED_TRANSITIONS: TransitionTable = {
  created: {
    authentication_required: 'requires_action',
    authorization_started: 'authorizing',
  },
  requires_action: {
    authentication_completed: 'authorizing',
    authentication_failed: 'declined',
  },
  authorizing: {
    authorized: 'authorized',
    declined: 'declined',
    authorization_failed: 'failed',
  },
  authorized: {
    capture_started: 'capturing',
    voided: 'voided',
  },
  capturing: {
    captured: 'captured',
    declined: 'declined',
  },
  captured: {
    refund_started: 'refund_pending',
    dispute_opened: 'dispute_opened',
    settled: 'settled',
  },
  refund_pending: {
    refunded: 'refunded',
    declined: 'declined',
  },
  refunded: {
    // Further partial refunds cycle back through refund_pending.
    refund_started: 'refund_pending',
  },
  settled: {
    // Chargebacks can land after settlement — see TERMINAL_STATES doc.
    dispute_opened: 'dispute_opened',
  },
  dispute_opened: {
    dispute_won: ['captured', 'settled'],
    dispute_lost: 'dispute_lost',
  },
};

export class InvalidTransitionError extends Error {
  constructor(
    public readonly currentState: PaymentState,
    public readonly event: CanonicalEvent,
    message: string,
  ) {
    super(message);
    this.name = 'InvalidTransitionError';
  }
}

export type TransitionOutcome =
  | { kind: 'transitioned'; from: PaymentState; to: PaymentState }
  | { kind: 'late'; currentState: PaymentState };

/** True if `eventType` appears anywhere in the table, from any source state. */
function isKnownEventType(eventType: CanonicalEventType): boolean {
  return PAYMENT_STATES.some((state) => {
    const transitions = ALLOWED_TRANSITIONS[state];
    return transitions !== undefined && eventType in transitions;
  });
}

/**
 * Pure transition function — no I/O, no side effects. Given the
 * payment's current state and a canonical event, returns what should
 * happen:
 *
 * - `{kind: 'transitioned', from, to}` — the event is valid from the
 *   current state; the caller should update `payments.state` and
 *   insert exactly one `payment_events` row in the same transaction
 *   (Non-negotiable #10).
 * - `{kind: 'late', currentState}` — the event is a recognized
 *   canonical event type, but not valid from the payment's current
 *   state (e.g. a duplicate webhook, or one that arrived out of order
 *   after the payment already moved past it). The caller should record
 *   a `late_event` timeline row and must NOT change `payments.state`
 *   (Non-negotiable #5: "never regress state").
 *
 * Throws `InvalidTransitionError` only when `eventType` is not a
 * recognized canonical event at all — this is the one case that's a
 * genuine invariant violation (an upstream normalizer producing a
 * canonical event type this state machine has never heard of), not a
 * timing artifact of distributed webhook delivery.
 */
export function applyTransition(
  currentState: PaymentState,
  event: CanonicalEvent,
): TransitionOutcome {
  if (TERMINAL_STATES.has(currentState)) {
    return { kind: 'late', currentState };
  }

  const transitionsFromState = ALLOWED_TRANSITIONS[currentState];
  const target = transitionsFromState?.[event.type];

  if (target === undefined) {
    if (!isKnownEventType(event.type)) {
      throw new InvalidTransitionError(
        currentState,
        event,
        `Unknown canonical event type "${event.type}" — not present anywhere in ALLOWED_TRANSITIONS`,
      );
    }
    // Recognized event, just not valid from here right now: duplicate
    // or out-of-order delivery. Record, don't reject, don't regress.
    return { kind: 'late', currentState };
  }

  if (Array.isArray(target)) {
    if (event.resolvedTarget === undefined || !target.includes(event.resolvedTarget)) {
      throw new InvalidTransitionError(
        currentState,
        event,
        `Event "${event.type}" from "${currentState}" is ambiguous and requires resolvedTarget ` +
          `to be one of: ${target.join(', ')}`,
      );
    }
    return { kind: 'transitioned', from: currentState, to: event.resolvedTarget };
  }

  return { kind: 'transitioned', from: currentState, to: target as PaymentState };
}
