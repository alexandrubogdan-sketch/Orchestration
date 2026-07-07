package domain

import "fmt"

// PaymentState is the canonical payment state machine — "the state
// machine is law." States and transitions here match the TS reference
// implementation's src/domain/stateMachine.ts exactly; if the two ever
// diverge, treat it as a bug in this file, not a deliberate change.
type PaymentState string

const (
	StateCreated        PaymentState = "created"
	StateRequiresAction PaymentState = "requires_action"
	StateAuthorizing    PaymentState = "authorizing"
	StateAuthorized     PaymentState = "authorized"
	StateCapturing      PaymentState = "capturing"
	StateCaptured       PaymentState = "captured"
	StateRefundPending  PaymentState = "refund_pending"
	StateRefunded       PaymentState = "refunded"
	StateDisputeOpened  PaymentState = "dispute_opened"
	StateDisputeWon     PaymentState = "dispute_won"
	StateDisputeLost    PaymentState = "dispute_lost"
	StateDeclined       PaymentState = "declined"
	StateVoided         PaymentState = "voided"
	StateFailed         PaymentState = "failed"
	StateSettled        PaymentState = "settled"
)

// PaymentStates enumerates every valid PaymentState, in the same order
// as the TS PAYMENT_STATES array.
var PaymentStates = []PaymentState{
	StateCreated,
	StateRequiresAction,
	StateAuthorizing,
	StateAuthorized,
	StateCapturing,
	StateCaptured,
	StateRefundPending,
	StateRefunded,
	StateDisputeOpened,
	StateDisputeWon,
	StateDisputeLost,
	StateDeclined,
	StateVoided,
	StateFailed,
	StateSettled,
}

// TerminalStates never have outgoing edges — once here, every future
// event for the payment is recorded as a late/duplicate timeline entry,
// never a state change. settled and refunded are deliberately NOT in
// this set: a settled payment can still be disputed (chargebacks land
// after settlement), and a refunded payment can receive further
// partial refunds.
var TerminalStates = map[PaymentState]struct{}{
	StateDeclined:    {},
	StateVoided:      {},
	StateFailed:      {},
	StateDisputeWon:  {},
	StateDisputeLost: {},
}

// IsTerminalState reports whether state is a terminal state.
func IsTerminalState(state PaymentState) bool {
	_, ok := TerminalStates[state]
	return ok
}

// CanonicalEventType is the set of normalized event types every PSP
// adapter must translate its own webhook/API events into before they
// reach the state machine.
type CanonicalEventType string

const (
	EventAuthenticationRequired  CanonicalEventType = "authentication_required"
	EventAuthenticationCompleted CanonicalEventType = "authentication_completed"
	EventAuthenticationFailed    CanonicalEventType = "authentication_failed"
	EventAuthorizationStarted    CanonicalEventType = "authorization_started"
	EventAuthorized              CanonicalEventType = "authorized"
	EventDeclined                CanonicalEventType = "declined"
	EventAuthorizationFailed     CanonicalEventType = "authorization_failed"
	EventCaptureStarted          CanonicalEventType = "capture_started"
	EventCaptured                CanonicalEventType = "captured"
	EventVoided                  CanonicalEventType = "voided"
	EventRefundStarted           CanonicalEventType = "refund_started"
	EventRefunded                CanonicalEventType = "refunded"
	EventSettled                 CanonicalEventType = "settled"
	EventDisputeOpened           CanonicalEventType = "dispute_opened"
	EventDisputeWon              CanonicalEventType = "dispute_won"
	EventDisputeLost             CanonicalEventType = "dispute_lost"
)

// CanonicalEventTypes enumerates every valid CanonicalEventType, in the
// same order as the TS CANONICAL_EVENT_TYPES array.
var CanonicalEventTypes = []CanonicalEventType{
	EventAuthenticationRequired,
	EventAuthenticationCompleted,
	EventAuthenticationFailed,
	EventAuthorizationStarted,
	EventAuthorized,
	EventDeclined,
	EventAuthorizationFailed,
	EventCaptureStarted,
	EventCaptured,
	EventVoided,
	EventRefundStarted,
	EventRefunded,
	EventSettled,
	EventDisputeOpened,
	EventDisputeWon,
	EventDisputeLost,
}

// CanonicalEvent is a normalized event fed into ApplyTransition.
type CanonicalEvent struct {
	Type CanonicalEventType

	// ResolvedTarget is required only for events whose target state is
	// ambiguous from table shape alone (currently just dispute_won,
	// which can return the payment to whichever state it was in before
	// the dispute opened — captured or settled). Validated against the
	// allowed target set for the current state/event pair.
	ResolvedTarget *PaymentState

	// DeclineCode is present on declined events; carried through onto
	// payment_events in a later phase.
	DeclineCode *string
}

// transitionTarget represents the right-hand side of one
// state+event -> target(s) table entry: either exactly one target
// state, or (for the ambiguous dispute_won case) a set of allowed
// target states requiring CanonicalEvent.ResolvedTarget to disambiguate.
type transitionTarget struct {
	single     PaymentState
	multiple   []PaymentState
	isMultiple bool
}

func single(state PaymentState) transitionTarget {
	return transitionTarget{single: state}
}

func multiple(states ...PaymentState) transitionTarget {
	return transitionTarget{multiple: states, isMultiple: true}
}

// ALLOWED_TRANSITIONS — the allowed-transitions table, translated
// directly from the TS source. Read as: "from this state, this event
// moves the payment to that state (or one of those states)." States
// with NO entry here (the terminal states) must have zero outgoing
// edges — enforced by TestAllowedTransitionsTableSanity.
var AllowedTransitions = map[PaymentState]map[CanonicalEventType]transitionTarget{
	StateCreated: {
		EventAuthenticationRequired: single(StateRequiresAction),
		EventAuthorizationStarted:   single(StateAuthorizing),
	},
	StateRequiresAction: {
		EventAuthenticationCompleted: single(StateAuthorizing),
		EventAuthenticationFailed:    single(StateDeclined),
	},
	StateAuthorizing: {
		EventAuthorized:          single(StateAuthorized),
		EventDeclined:            single(StateDeclined),
		EventAuthorizationFailed: single(StateFailed),
	},
	StateAuthorized: {
		EventCaptureStarted: single(StateCapturing),
		EventVoided:         single(StateVoided),
	},
	StateCapturing: {
		EventCaptured: single(StateCaptured),
		EventDeclined: single(StateDeclined),
	},
	StateCaptured: {
		EventRefundStarted: single(StateRefundPending),
		EventDisputeOpened: single(StateDisputeOpened),
		EventSettled:       single(StateSettled),
	},
	StateRefundPending: {
		EventRefunded: single(StateRefunded),
		EventDeclined: single(StateDeclined),
	},
	StateRefunded: {
		// Further partial refunds cycle back through refund_pending.
		EventRefundStarted: single(StateRefundPending),
	},
	StateSettled: {
		// Chargebacks can land after settlement — see TerminalStates doc.
		EventDisputeOpened: single(StateDisputeOpened),
	},
	StateDisputeOpened: {
		EventDisputeWon:  multiple(StateCaptured, StateSettled),
		EventDisputeLost: single(StateDisputeLost),
	},
	// No entries at all for: declined, voided, failed, dispute_won,
	// dispute_lost — these are the terminal states and must have zero
	// outgoing edges.
}

// InvalidTransitionError is returned only when an event type is not a
// recognized canonical event at all, or when an ambiguous transition
// (dispute_won) is missing or has an invalid ResolvedTarget — the
// genuine invariant-violation cases, not timing artifacts of
// distributed webhook delivery.
type InvalidTransitionError struct {
	CurrentState PaymentState
	Event        CanonicalEvent
	Message      string
}

func (e *InvalidTransitionError) Error() string {
	return e.Message
}

func newInvalidTransitionError(currentState PaymentState, event CanonicalEvent, format string, args ...any) *InvalidTransitionError {
	return &InvalidTransitionError{
		CurrentState: currentState,
		Event:        event,
		Message:      fmt.Sprintf(format, args...),
	}
}

// TransitionKind discriminates the two possible TransitionOutcome
// shapes.
type TransitionKind string

const (
	TransitionKindTransitioned TransitionKind = "transitioned"
	TransitionKindLate         TransitionKind = "late"
)

// TransitionOutcome is the result of ApplyTransition: either the
// payment moved from From to To, or the event was recognized but not
// applicable from CurrentState right now (a late/duplicate/out-of-order
// event).
type TransitionOutcome struct {
	Kind TransitionKind

	// Populated when Kind == TransitionKindTransitioned.
	From PaymentState
	To   PaymentState

	// Populated when Kind == TransitionKindLate.
	CurrentState PaymentState
}

// isKnownEventType reports whether eventType appears anywhere in
// AllowedTransitions, from any source state.
func isKnownEventType(eventType CanonicalEventType) bool {
	for _, transitions := range AllowedTransitions {
		if _, ok := transitions[eventType]; ok {
			return true
		}
	}
	return false
}

// ApplyTransition is the pure transition function — no I/O, no side
// effects. Given the payment's current state and a canonical event, it
// returns what should happen:
//
//   - {Kind: transitioned, From, To} — the event is valid from the
//     current state; the caller should update payments.state and insert
//     exactly one payment_events row in the same transaction.
//   - {Kind: late, CurrentState} — the event is a recognized canonical
//     event type, but not valid from the payment's current state (e.g. a
//     duplicate webhook, or one that arrived out of order after the
//     payment already moved past it). The caller should record a
//     late_event timeline row and must NOT change payments.state (never
//     regress state).
//
// Returns InvalidTransitionError only when eventType is not a
// recognized canonical event at all.
func ApplyTransition(currentState PaymentState, event CanonicalEvent) (TransitionOutcome, error) {
	if IsTerminalState(currentState) {
		return TransitionOutcome{Kind: TransitionKindLate, CurrentState: currentState}, nil
	}

	transitionsFromState, hasState := AllowedTransitions[currentState]
	var target transitionTarget
	var hasTarget bool
	if hasState {
		target, hasTarget = transitionsFromState[event.Type]
	}

	if !hasTarget {
		if !isKnownEventType(event.Type) {
			return TransitionOutcome{}, newInvalidTransitionError(
				currentState, event,
				`Unknown canonical event type "%s" — not present anywhere in ALLOWED_TRANSITIONS`,
				event.Type,
			)
		}
		// Recognized event, just not valid from here right now:
		// duplicate or out-of-order delivery. Record, don't reject,
		// don't regress.
		return TransitionOutcome{Kind: TransitionKindLate, CurrentState: currentState}, nil
	}

	if target.isMultiple {
		if event.ResolvedTarget == nil || !containsState(target.multiple, *event.ResolvedTarget) {
			return TransitionOutcome{}, newInvalidTransitionError(
				currentState, event,
				`Event "%s" from "%s" is ambiguous and requires resolvedTarget to be one of: %s`,
				event.Type, currentState, joinStates(target.multiple),
			)
		}
		return TransitionOutcome{Kind: TransitionKindTransitioned, From: currentState, To: *event.ResolvedTarget}, nil
	}

	return TransitionOutcome{Kind: TransitionKindTransitioned, From: currentState, To: target.single}, nil
}

func containsState(states []PaymentState, target PaymentState) bool {
	for _, s := range states {
		if s == target {
			return true
		}
	}
	return false
}

func joinStates(states []PaymentState) string {
	result := ""
	for i, s := range states {
		if i > 0 {
			result += ", "
		}
		result += string(s)
	}
	return result
}
