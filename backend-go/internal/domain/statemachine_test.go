package domain

import (
	"math/rand"
	"testing"
)

func mustOutcome(t *testing.T, currentState PaymentState, event CanonicalEvent) TransitionOutcome {
	t.Helper()
	outcome, err := ApplyTransition(currentState, event)
	if err != nil {
		t.Fatalf("ApplyTransition(%q, %+v) unexpected error: %v", currentState, event, err)
	}
	return outcome
}

func assertTransitioned(t *testing.T, outcome TransitionOutcome, from, to PaymentState) {
	t.Helper()
	if outcome.Kind != TransitionKindTransitioned {
		t.Fatalf("outcome.Kind = %v, want transitioned", outcome.Kind)
	}
	if outcome.From != from || outcome.To != to {
		t.Fatalf("outcome = {from: %v, to: %v}, want {from: %v, to: %v}", outcome.From, outcome.To, from, to)
	}
}

func assertLate(t *testing.T, outcome TransitionOutcome, currentState PaymentState) {
	t.Helper()
	if outcome.Kind != TransitionKindLate {
		t.Fatalf("outcome.Kind = %v, want late", outcome.Kind)
	}
	if outcome.CurrentState != currentState {
		t.Fatalf("outcome.CurrentState = %v, want %v", outcome.CurrentState, currentState)
	}
}

func TestApplyTransition_HappyPath_CITCardPayment(t *testing.T) {
	outcome := mustOutcome(t, StateCreated, CanonicalEvent{Type: EventAuthorizationStarted})
	assertTransitioned(t, outcome, StateCreated, StateAuthorizing)

	outcome = mustOutcome(t, StateAuthorizing, CanonicalEvent{Type: EventAuthorized})
	assertTransitioned(t, outcome, StateAuthorizing, StateAuthorized)

	outcome = mustOutcome(t, StateAuthorized, CanonicalEvent{Type: EventCaptureStarted})
	assertTransitioned(t, outcome, StateAuthorized, StateCapturing)

	outcome = mustOutcome(t, StateCapturing, CanonicalEvent{Type: EventCaptured})
	assertTransitioned(t, outcome, StateCapturing, StateCaptured)

	outcome = mustOutcome(t, StateCaptured, CanonicalEvent{Type: EventSettled})
	assertTransitioned(t, outcome, StateCaptured, StateSettled)
}

func TestApplyTransition_3DSChallengePath(t *testing.T) {
	outcome := mustOutcome(t, StateCreated, CanonicalEvent{Type: EventAuthenticationRequired})
	assertTransitioned(t, outcome, StateCreated, StateRequiresAction)

	outcome = mustOutcome(t, StateRequiresAction, CanonicalEvent{Type: EventAuthenticationCompleted})
	assertTransitioned(t, outcome, StateRequiresAction, StateAuthorizing)
}

func TestApplyTransition_RefundPath_IncludingSecondPartialRefund(t *testing.T) {
	outcome := mustOutcome(t, StateCaptured, CanonicalEvent{Type: EventRefundStarted})
	assertTransitioned(t, outcome, StateCaptured, StateRefundPending)

	outcome = mustOutcome(t, StateRefundPending, CanonicalEvent{Type: EventRefunded})
	assertTransitioned(t, outcome, StateRefundPending, StateRefunded)

	// A second partial refund cycles back through refund_pending.
	outcome = mustOutcome(t, StateRefunded, CanonicalEvent{Type: EventRefundStarted})
	assertTransitioned(t, outcome, StateRefunded, StateRefundPending)
}

func TestApplyTransition_DisputeAfterSettlement(t *testing.T) {
	outcome := mustOutcome(t, StateSettled, CanonicalEvent{Type: EventDisputeOpened})
	assertTransitioned(t, outcome, StateSettled, StateDisputeOpened)
}

func TestApplyTransition_DisputeWonResolvesViaResolvedTarget(t *testing.T) {
	captured := StateCaptured
	outcome := mustOutcome(t, StateDisputeOpened, CanonicalEvent{Type: EventDisputeWon, ResolvedTarget: &captured})
	assertTransitioned(t, outcome, StateDisputeOpened, StateCaptured)

	settled := StateSettled
	outcome = mustOutcome(t, StateDisputeOpened, CanonicalEvent{Type: EventDisputeWon, ResolvedTarget: &settled})
	assertTransitioned(t, outcome, StateDisputeOpened, StateSettled)
}

func TestApplyTransition_DisputeWonMissingResolvedTargetErrors(t *testing.T) {
	_, err := ApplyTransition(StateDisputeOpened, CanonicalEvent{Type: EventDisputeWon})
	if err == nil {
		t.Fatal("expected InvalidTransitionError")
	}
	if _, ok := err.(*InvalidTransitionError); !ok {
		t.Fatalf("expected *InvalidTransitionError, got %T", err)
	}
}

func TestApplyTransition_DisputeWonInvalidResolvedTargetErrors(t *testing.T) {
	created := StateCreated
	_, err := ApplyTransition(StateDisputeOpened, CanonicalEvent{Type: EventDisputeWon, ResolvedTarget: &created})
	if err == nil {
		t.Fatal("expected InvalidTransitionError")
	}
	if _, ok := err.(*InvalidTransitionError); !ok {
		t.Fatalf("expected *InvalidTransitionError, got %T", err)
	}
}

func TestApplyTransition_TerminalStatesNeverMove(t *testing.T) {
	for state := range TerminalStates {
		outcome := mustOutcome(t, state, CanonicalEvent{Type: EventAuthorized})
		assertLate(t, outcome, state)
	}
}

func TestApplyTransition_RecognizedButInapplicableEventIsLate(t *testing.T) {
	// "authorized" is only valid from "authorizing"; replaying it once
	// the payment has already moved to "authorized" must not error.
	outcome := mustOutcome(t, StateAuthorized, CanonicalEvent{Type: EventAuthorized})
	assertLate(t, outcome, StateAuthorized)
}

func TestApplyTransition_DuplicateCapturedEventIsLate(t *testing.T) {
	outcome := mustOutcome(t, StateCaptured, CanonicalEvent{Type: EventCaptured})
	assertLate(t, outcome, StateCaptured)
}

func TestApplyTransition_UnknownEventTypeErrors(t *testing.T) {
	_, err := ApplyTransition(StateCreated, CanonicalEvent{Type: CanonicalEventType("not_a_real_event")})
	if err == nil {
		t.Fatal("expected InvalidTransitionError")
	}
	if _, ok := err.(*InvalidTransitionError); !ok {
		t.Fatalf("expected *InvalidTransitionError, got %T", err)
	}
}

func TestAllowedTransitionsTableSanity_TargetsAreKnownStates(t *testing.T) {
	knownStates := make(map[PaymentState]struct{}, len(PaymentStates))
	for _, s := range PaymentStates {
		knownStates[s] = struct{}{}
	}
	for _, state := range PaymentStates {
		transitions, ok := AllowedTransitions[state]
		if !ok {
			continue
		}
		for eventType, target := range transitions {
			targets := target.multiple
			if !target.isMultiple {
				targets = []PaymentState{target.single}
			}
			for _, to := range targets {
				if _, known := knownStates[to]; !known {
					t.Errorf("state %q event %q targets unknown state %q", state, eventType, to)
				}
			}
		}
	}
}

func TestAllowedTransitionsTableSanity_NoTerminalStateHasOutgoingTransitions(t *testing.T) {
	for state := range TerminalStates {
		if transitions, ok := AllowedTransitions[state]; ok {
			t.Errorf("terminal state %q has outgoing transitions defined: %v", state, transitions)
		}
	}
}

// --- Property-style tests, ported from
// test/unit/stateMachine.property.test.ts. The original TS suite uses
// fast-check; here we use a manual randomized loop (500+ iterations per
// property, well above the TS default of 100 runs) to avoid adding an
// extra dependency, per the task brief's stated preference.
//
// Property 2's scope, as documented in the original TS suite: the
// correct guarantee is per-event ("redelivering the identical event
// twice in a row is a no-op the second time"), not per-sequence —
// replaying an entire arbitrary sequence twice is NOT generally a
// no-op (fast-check found a real counterexample during TS development;
// see the TS file's docblock). We port the correctly-scoped property
// only.

var nonDisputeWonEventTypes = func() []CanonicalEventType {
	var out []CanonicalEventType
	for _, et := range CanonicalEventTypes {
		if et != EventDisputeWon {
			out = append(out, et)
		}
	}
	return out
}()

var disputeResolutionTargets = []PaymentState{StateCaptured, StateSettled}

func randomCanonicalEvent(rng *rand.Rand) CanonicalEvent {
	// Roughly half the mass on dispute_won (matching fc.oneof's equal
	// weighting across its two branches), half spread across every
	// other event type.
	if rng.Intn(2) == 0 {
		target := disputeResolutionTargets[rng.Intn(len(disputeResolutionTargets))]
		return CanonicalEvent{Type: EventDisputeWon, ResolvedTarget: &target}
	}
	et := nonDisputeWonEventTypes[rng.Intn(len(nonDisputeWonEventTypes))]
	return CanonicalEvent{Type: et}
}

func runSequence(t *testing.T, start PaymentState, events []CanonicalEvent) PaymentState {
	t.Helper()
	state := start
	for _, event := range events {
		outcome, err := ApplyTransition(state, event)
		if err != nil {
			// Every event here is drawn from CanonicalEventTypes plus a
			// valid ResolvedTarget for dispute_won, so it is always a
			// known event type and never triggers InvalidTransitionError.
			t.Fatalf("unexpected error applying %+v from %q: %v", event, state, err)
		}
		if outcome.Kind == TransitionKindTransitioned {
			state = outcome.To
		}
	}
	return state
}

func TestProperty_EveryTransitionCorrespondsToARealTableEdge(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	const trials = 500
	const maxSeqLen = 30

	for trial := 0; trial < trials; trial++ {
		seqLen := rng.Intn(maxSeqLen + 1)
		state := StateCreated
		for i := 0; i < seqLen; i++ {
			event := randomCanonicalEvent(rng)
			outcome, err := ApplyTransition(state, event)
			if err != nil {
				t.Fatalf("trial %d step %d: unexpected error: %v", trial, i, err)
			}

			if outcome.Kind == TransitionKindLate {
				if !containsState(PaymentStates, outcome.CurrentState) {
					t.Fatalf("trial %d step %d: late outcome has unknown state %q", trial, i, outcome.CurrentState)
				}
				continue
			}

			if !containsState(PaymentStates, outcome.To) {
				t.Fatalf("trial %d step %d: transitioned outcome has unknown target %q", trial, i, outcome.To)
			}
			transitionsFromState, ok := AllowedTransitions[outcome.From]
			if !ok {
				t.Fatalf("trial %d step %d: transitioned outcome.From %q has no table entry", trial, i, outcome.From)
			}
			declaredTarget, ok := transitionsFromState[event.Type]
			if !ok {
				t.Fatalf("trial %d step %d: no declared transition for event %q from %q", trial, i, event.Type, outcome.From)
			}
			declaredTargets := declaredTarget.multiple
			if !declaredTarget.isMultiple {
				declaredTargets = []PaymentState{declaredTarget.single}
			}
			if !containsState(declaredTargets, outcome.To) {
				t.Fatalf("trial %d step %d: outcome.To %q not among declared targets %v", trial, i, outcome.To, declaredTargets)
			}
			state = outcome.To
		}
	}
}

func TestProperty_RedeliveringSameEventTwiceIsNoOpSecondTime(t *testing.T) {
	rng := rand.New(rand.NewSource(99))
	const trials = 500
	const maxSeqLen = 20

	for trial := 0; trial < trials; trial++ {
		seqLen := rng.Intn(maxSeqLen) + 1 // minLength: 1
		events := make([]CanonicalEvent, seqLen)
		for i := range events {
			events[i] = randomCanonicalEvent(rng)
		}

		stateBeforeLastEvent := runSequence(t, StateCreated, events[:len(events)-1])
		lastEvent := events[len(events)-1]

		firstOutcome, err := ApplyTransition(stateBeforeLastEvent, lastEvent)
		if err != nil {
			t.Fatalf("trial %d: unexpected error on first delivery: %v", trial, err)
		}
		stateAfterFirstDelivery := stateBeforeLastEvent
		if firstOutcome.Kind == TransitionKindTransitioned {
			stateAfterFirstDelivery = firstOutcome.To
		} else {
			stateAfterFirstDelivery = firstOutcome.CurrentState
		}

		secondOutcome, err := ApplyTransition(stateAfterFirstDelivery, lastEvent)
		if err != nil {
			t.Fatalf("trial %d: unexpected error on second delivery: %v", trial, err)
		}
		stateAfterSecondDelivery := stateAfterFirstDelivery
		if secondOutcome.Kind == TransitionKindTransitioned {
			stateAfterSecondDelivery = secondOutcome.To
		} else {
			stateAfterSecondDelivery = secondOutcome.CurrentState
		}

		if stateAfterSecondDelivery != stateAfterFirstDelivery {
			t.Fatalf(
				"trial %d: re-delivering %+v twice from %q was not a no-op: first=%q second=%q",
				trial, lastEvent, stateBeforeLastEvent, stateAfterFirstDelivery, stateAfterSecondDelivery,
			)
		}
	}
}
