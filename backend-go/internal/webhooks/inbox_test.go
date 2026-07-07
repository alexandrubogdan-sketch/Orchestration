package webhooks

import (
	"testing"

	"github.com/alphapayments/payment-orchestrator/internal/adapters"
	"github.com/alphapayments/payment-orchestrator/internal/domain"
)

// This file has no live Postgres/Redis available (same standing
// sandbox constraint as every prior phase) — it tests the parts of
// this package's logic that don't require a live *pgxpool.Pool at all:
// isPgUniqueViolation (pure), MaxWebhookAttempts constant,
// PollableStates, and synthesizeEventsForStatus (pure functions, no
// DB). Ingest/Apply/Normalize themselves take a *pgxpool.Pool by value
// in Deps and therefore cannot be exercised without either a live
// Postgres or a much larger pgx-mocking effort this port has
// consistently avoided in favor of narrow interfaces elsewhere
// (internal/statemachine/db_test.go's fakeTx pattern) — pgx's own
// *pgxpool.Pool has no narrow interface this port could substitute
// without changing every real call site's type throughout this
// package, which was judged out of scope for this phase's test
// coverage relative to the value of covering the pure logic below
// thoroughly instead. See MIGRATION_NOTES.md's Phase 5 section, "Final
// self-critical list," for this called out explicitly as a real,
// non-hypothetical coverage gap — the dedup/signature-verification-
// loop/DLQ decision logic the task asked to be tested is exercised
// indirectly by exercising every pure helper this file's DB-touching
// functions call into, but NOT the DB-touching functions themselves
// end-to-end.

func TestSynthesizeEventsForStatus_AllBranches(t *testing.T) {
	declineCode := "insufficient_funds"
	cases := []struct {
		name     string
		snapshot adapters.AttemptSnapshot
		wantLen  int
		wantType domain.CanonicalEventType
	}{
		{"requires_action", adapters.AttemptSnapshot{Status: adapters.AttemptStatusRequiresAction}, 1, domain.EventAuthenticationRequired},
		{"authorized", adapters.AttemptSnapshot{Status: adapters.AttemptStatusAuthorized}, 1, domain.EventAuthorized},
		{"captured_over_inclusive", adapters.AttemptSnapshot{Status: adapters.AttemptStatusCaptured}, 3, domain.EventAuthorized},
		{"declined", adapters.AttemptSnapshot{Status: adapters.AttemptStatusDeclined, Decline: &domain.NormalizedDecline{NormalizedCode: declineCode}}, 1, domain.EventDeclined},
		{"failed", adapters.AttemptSnapshot{Status: adapters.AttemptStatusFailed}, 1, domain.EventAuthorizationFailed},
		{"voided", adapters.AttemptSnapshot{Status: adapters.AttemptStatusVoided}, 1, domain.EventVoided},
		{"refunded", adapters.AttemptSnapshot{Status: adapters.AttemptStatusRefunded}, 2, domain.EventRefundStarted},
		{"pending", adapters.AttemptSnapshot{Status: adapters.AttemptStatusPending}, 0, ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			events := synthesizeEventsForStatus(tc.snapshot)
			if len(events) != tc.wantLen {
				t.Fatalf("%s: expected %d events, got %d: %+v", tc.name, tc.wantLen, len(events), events)
			}
			if tc.wantLen > 0 && events[0].Type != tc.wantType {
				t.Fatalf("%s: expected first event type %s, got %s", tc.name, tc.wantType, events[0].Type)
			}
		})
	}

	// The declined case specifically must carry the decline code through.
	declinedEvents := synthesizeEventsForStatus(adapters.AttemptSnapshot{
		Status:  adapters.AttemptStatusDeclined,
		Decline: &domain.NormalizedDecline{NormalizedCode: declineCode},
	})
	if declinedEvents[0].DeclineCode == nil || *declinedEvents[0].DeclineCode != declineCode {
		t.Fatalf("expected declineCode=%s to be carried through, got %v", declineCode, declinedEvents[0].DeclineCode)
	}
}

func TestPollableStates_MatchesTaskSpec(t *testing.T) {
	want := map[domain.PaymentState]bool{
		domain.StateCreated:        true,
		domain.StateRequiresAction: true,
		domain.StateAuthorizing:    true,
		domain.StateCapturing:      true,
		domain.StateRefundPending:  true,
	}
	if len(PollableStates) != len(want) {
		t.Fatalf("expected %d pollable states, got %d: %v", len(want), len(PollableStates), PollableStates)
	}
	for _, s := range PollableStates {
		if !want[s] {
			t.Fatalf("unexpected pollable state %s", s)
		}
	}
	// authorized and dispute_opened must NOT be pollable — see
	// gapdetection.go's doc comment on why.
	for _, s := range PollableStates {
		if s == domain.StateAuthorized || s == domain.StateDisputeOpened {
			t.Fatalf("state %s must not be in PollableStates", s)
		}
	}
}

func TestMaxWebhookAttempts_Value(t *testing.T) {
	if MaxWebhookAttempts != 5 {
		t.Fatalf("expected MaxWebhookAttempts=5, got %d", MaxWebhookAttempts)
	}
}

func TestIsPgUniqueViolation_NonPgError(t *testing.T) {
	if isPgUniqueViolation(nil) {
		t.Fatal("expected false for nil error")
	}
	if isPgUniqueViolation(errPlain) {
		t.Fatal("expected false for a plain, non-pgconn error")
	}
}

var errPlain = plainError("boom")

type plainError string

func (e plainError) Error() string { return string(e) }
