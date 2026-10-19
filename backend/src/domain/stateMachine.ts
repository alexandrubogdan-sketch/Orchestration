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

  resolvedTarget?: PaymentState | undefined;

  declineCode?: string | undefined;
}

type TransitionTable = {
  [S in PaymentState]?: {
    [E in CanonicalEventType]?: PaymentState | readonly PaymentState[];
  };
};

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
    refund_started: 'refund_pending',
  },
  settled: {
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

function isKnownEventType(eventType: CanonicalEventType): boolean {
  return PAYMENT_STATES.some((state) => {
    const transitions = ALLOWED_TRANSITIONS[state];
    return transitions !== undefined && eventType in transitions;
  });
}

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
