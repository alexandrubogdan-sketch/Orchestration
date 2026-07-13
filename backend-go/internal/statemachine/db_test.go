package statemachine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/alphapayments/payment-orchestrator/internal/domain"
)

// This file has NO live Postgres available in this sandbox (see
// MIGRATION_NOTES.md's standing constraint, true again this phase) —
// every prior DB-touching package in this port (internal/api/pgstore.go,
// internal/routing/rules.go) tested against a hand-rolled fake
// satisfying a narrow package-local interface instead of a live
// database, and this file follows the exact same convention:
// fakeTx below satisfies this package's Querier interface (QueryRow +
// Exec, the exact pgx.Tx method subset transitionInTx actually calls)
// entirely in memory, mirroring Phase 4's fakeScriptRunner pattern.
//
// This is the highest-priority test file in Phase 5 — every state
// transition in this project's money/state model ultimately runs
// through transitionInTx, so its correctness here matters more than
// almost anything else ported this phase.

// fakeRow is a minimal in-memory payments row, keyed by id.
type fakeRow struct {
	id               string
	merchantEntityID string
	productID        string
	customerID       string
	amountMinorUnits int64
	currency         string
	state            string
	citMit           string
	createdAt        time.Time
	updatedAt        time.Time
}

// fakeTx is a hand-rolled in-memory fake satisfying this package's
// Querier interface — no live pgx.Tx, no live Postgres. It supports
// exactly the four SQL shapes transitionInTx issues:
//   - SELECT ... FROM payments WHERE id = $1 FOR UPDATE
//   - INSERT INTO payment_events (...) — three literal variants (see
//     Exec's own doc comment for why each is parsed differently)
//   - UPDATE payments SET state = $1, updated_at = now() WHERE id = $2 RETURNING ...
//   - INSERT INTO outbox (...)  (via outbox.InsertEvent, which calls Exec)
type fakeTx struct {
	payments map[string]*fakeRow

	paymentEventsInserted []fakePaymentEvent
	outboxInserted        []fakeOutboxRow

	// forceNotFound, when true, makes the next SELECT ... FOR UPDATE
	// call behave as if the row doesn't exist — used to simulate a
	// payment that doesn't exist.
	forceNotFound bool
}

type fakePaymentEvent struct {
	EventType   string
	FromState   string
	ToState     *string
	DeclineCode *string
	Metadata    map[string]any
}

type fakeOutboxRow struct {
	AggregateType string
	AggregateID   string
	EventType     string
	Payload       map[string]any
}

// fakeRowScanner adapts a fixed set of destination pointers to pgx.Row.
type fakeRowScanner struct {
	scan func(dest ...any) error
}

func (f fakeRowScanner) Scan(dest ...any) error { return f.scan(dest...) }

func newFakeTx(row *fakeRow) *fakeTx {
	payments := make(map[string]*fakeRow)
	if row != nil {
		payments[row.id] = row
	}
	return &fakeTx{payments: payments}
}

func (f *fakeTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	switch {
	case containsSQL(sql, "FOR UPDATE"):
		id, _ := args[0].(string)
		row, ok := f.payments[id]
		if !ok || f.forceNotFound {
			return fakeRowScanner{scan: func(dest ...any) error { return pgx.ErrNoRows }}
		}
		return fakeRowScanner{scan: func(dest ...any) error {
			return scanFakeRow(dest, row)
		}}
	case containsSQL(sql, "UPDATE payments SET state"):
		newState, _ := args[0].(string)
		id, _ := args[1].(string)
		row, ok := f.payments[id]
		if !ok {
			return fakeRowScanner{scan: func(dest ...any) error { return pgx.ErrNoRows }}
		}
		row.state = newState
		row.updatedAt = time.Now()
		return fakeRowScanner{scan: func(dest ...any) error {
			return scanFakeRow(dest, row)
		}}
	default:
		return fakeRowScanner{scan: func(dest ...any) error {
			return fmt.Errorf("fakeTx: unrecognized QueryRow SQL: %s", sql)
		}}
	}
}

func scanFakeRow(dest []any, row *fakeRow) error {
	if len(dest) != 10 {
		return fmt.Errorf("fakeTx: expected 10 scan destinations, got %d", len(dest))
	}
	*(dest[0].(*string)) = row.id
	*(dest[1].(*string)) = row.merchantEntityID
	*(dest[2].(*string)) = row.productID
	*(dest[3].(*string)) = row.customerID
	*(dest[4].(*int64)) = row.amountMinorUnits
	*(dest[5].(*string)) = row.currency
	*(dest[6].(*string)) = row.state
	*(dest[7].(*string)) = row.citMit
	*(dest[8].(*time.Time)) = row.createdAt
	*(dest[9].(*time.Time)) = row.updatedAt
	return nil
}

// Exec parses each of the three literal SQL shapes db.go's insert
// helpers issue. Two of the three (invariant_violation, late_event)
// hardcode event_type/to_state as SQL literals rather than bind
// parameters, so those calls carry only 5 args
// (id, paymentId, fromState, declineCode, metadata) — a DIFFERENT
// positional shape than insertTransitionEvent's 6 args
// (id, paymentId, eventType, fromState, toState, declineCode; metadata
// there is itself a literal '{}'). This fake distinguishes the three
// shapes by matching on the literal text of the SQL itself, exactly
// mirroring which literal each real query embeds, rather than assuming
// one fixed argument layout for every "INSERT INTO payment_events" call.
func (f *fakeTx) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	switch {
	case containsSQL(sql, "'invariant_violation'"):
		// args: id, paymentId, fromState, declineCode, metadata
		ev := fakePaymentEvent{
			EventType: "invariant_violation",
			FromState: args[2].(string),
		}
		if declineCode, ok := args[3].(*string); ok {
			ev.DeclineCode = declineCode
		}
		ev.Metadata = decodeMetadataArg(args[4])
		f.paymentEventsInserted = append(f.paymentEventsInserted, ev)
		return pgconn.CommandTag{}, nil
	case containsSQL(sql, "'late_event'"):
		// args: id, paymentId, fromState, declineCode, metadata
		ev := fakePaymentEvent{
			EventType: "late_event",
			FromState: args[2].(string),
		}
		if declineCode, ok := args[3].(*string); ok {
			ev.DeclineCode = declineCode
		}
		ev.Metadata = decodeMetadataArg(args[4])
		f.paymentEventsInserted = append(f.paymentEventsInserted, ev)
		return pgconn.CommandTag{}, nil
	case containsSQL(sql, "INSERT INTO payment_events"):
		// insertTransitionEvent's shape: id, paymentId, eventType,
		// fromState, toState, declineCode (metadata is the literal '{}').
		ev := fakePaymentEvent{
			EventType: args[2].(string),
			FromState: args[3].(string),
		}
		if toState, ok := args[4].(string); ok {
			ev.ToState = &toState
		}
		if declineCode, ok := args[5].(*string); ok {
			ev.DeclineCode = declineCode
		}
		f.paymentEventsInserted = append(f.paymentEventsInserted, ev)
		return pgconn.CommandTag{}, nil
	case containsSQL(sql, "INSERT INTO outbox"):
		var payload map[string]any
		payloadRaw, _ := args[4].([]byte)
		_ = json.Unmarshal(payloadRaw, &payload)
		f.outboxInserted = append(f.outboxInserted, fakeOutboxRow{
			AggregateType: args[1].(string),
			AggregateID:   args[2].(string),
			EventType:     args[3].(string),
			Payload:       payload,
		})
		return pgconn.CommandTag{}, nil
	default:
		return pgconn.CommandTag{}, fmt.Errorf("fakeTx: unrecognized Exec SQL: %s", sql)
	}
}

func decodeMetadataArg(arg any) map[string]any {
	var metadataRaw []byte
	switch v := arg.(type) {
	case []byte:
		metadataRaw = v
	case string:
		metadataRaw = []byte(v)
	}
	var metadata map[string]any
	if len(metadataRaw) > 0 {
		_ = json.Unmarshal(metadataRaw, &metadata)
	}
	return metadata
}

func containsSQL(sql string, needle string) bool {
	return len(sql) >= len(needle) && indexOf(sql, needle) >= 0
}

func indexOf(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}

// alwaysStable is a stableNameLookup that maps every event type to
// itself as its "stable name" — used by tests that want to assert
// outbox-row behavior without depending on internal/api/timeline.go's
// actual mapping table (a cross-package dependency this test file
// deliberately avoids per this package's own doc comment on why
// StableNameLookup is injected rather than imported).
func alwaysStable(eventType domain.CanonicalEventType) (string, bool) {
	return string(eventType), true
}

func neverStable(eventType domain.CanonicalEventType) (string, bool) {
	return "", false
}

func TestTransitionInTx_Transitioned_WritesEventUpdatesStateAndEnqueuesOutbox(t *testing.T) {
	row := &fakeRow{
		id:               "payment-1",
		merchantEntityID: "entity-1",
		productID:        "product-1",
		customerID:       "customer-1",
		amountMinorUnits: 1050,
		currency:         "USD",
		state:            string(domain.StateAuthorizing),
		citMit:           "cit",
		createdAt:        time.Now(),
		updatedAt:        time.Now(),
	}
	tx := newFakeTx(row)

	result, err := transitionInTx(context.Background(), tx, "payment-1", domain.CanonicalEvent{Type: domain.EventAuthorized}, alwaysStable, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Outcome != "transitioned" {
		t.Fatalf("expected outcome=transitioned, got %s", result.Outcome)
	}
	if result.From != domain.StateAuthorizing || result.To != domain.StateAuthorized {
		t.Fatalf("expected authorizing->authorized, got %s->%s", result.From, result.To)
	}
	if row.state != string(domain.StateAuthorized) {
		t.Fatalf("expected payments.state updated to authorized, got %s", row.state)
	}

	if len(tx.paymentEventsInserted) != 1 {
		t.Fatalf("expected exactly one payment_events row, got %d", len(tx.paymentEventsInserted))
	}
	ev := tx.paymentEventsInserted[0]
	if ev.EventType != string(domain.EventAuthorized) {
		t.Fatalf("expected event_type=authorized, got %s", ev.EventType)
	}
	if ev.FromState != string(domain.StateAuthorizing) {
		t.Fatalf("expected from_state=authorizing, got %s", ev.FromState)
	}
	if ev.ToState == nil || *ev.ToState != string(domain.StateAuthorized) {
		t.Fatalf("expected to_state=authorized, got %v", ev.ToState)
	}

	if len(tx.outboxInserted) != 1 {
		t.Fatalf("expected exactly one outbox row (stable name present), got %d", len(tx.outboxInserted))
	}
	outboxRow := tx.outboxInserted[0]
	if outboxRow.AggregateType != "payment" || outboxRow.AggregateID != "payment-1" {
		t.Fatalf("unexpected outbox aggregate fields: %+v", outboxRow)
	}
	if outboxRow.EventType != OutboundWebhookOutboxEventType {
		t.Fatalf("expected event_type=%s, got %s", OutboundWebhookOutboxEventType, outboxRow.EventType)
	}
	data, ok := outboxRow.Payload["data"].(map[string]any)
	if !ok {
		t.Fatalf("expected payload.data to be a map, got %T", outboxRow.Payload["data"])
	}
	if data["state"] != string(domain.StateAuthorized) {
		t.Fatalf("expected payload.data.state=authorized, got %v", data["state"])
	}
}

func TestTransitionInTx_Late_DoesNotTouchStateWritesOnlyLateEvent(t *testing.T) {
	row := &fakeRow{
		id:        "payment-2",
		productID: "product-1",
		state:     string(domain.StateAuthorized),
		createdAt: time.Now(),
		updatedAt: time.Now(),
	}
	tx := newFakeTx(row)

	// authorized has no "authorized" transition defined again — but it
	// IS a known event type (valid from authorizing), so from
	// "authorized" it's a recognized-but-not-applicable-here late event.
	result, err := transitionInTx(context.Background(), tx, "payment-2", domain.CanonicalEvent{Type: domain.EventAuthorized}, alwaysStable, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Outcome != "late" {
		t.Fatalf("expected outcome=late, got %s", result.Outcome)
	}
	if row.state != string(domain.StateAuthorized) {
		t.Fatalf("expected payments.state to remain unchanged (authorized), got %s", row.state)
	}
	if len(tx.paymentEventsInserted) != 1 {
		t.Fatalf("expected exactly one payment_events row, got %d", len(tx.paymentEventsInserted))
	}
	ev := tx.paymentEventsInserted[0]
	if ev.EventType != "late_event" {
		t.Fatalf("expected event_type=late_event, got %s", ev.EventType)
	}
	if ev.ToState != nil {
		t.Fatalf("expected to_state=NULL for a late event, got %v", *ev.ToState)
	}
	if len(tx.outboxInserted) != 0 {
		t.Fatalf("expected zero outbox rows for a late event, got %d", len(tx.outboxInserted))
	}
}

func TestTransitionInTx_InvalidTransition_WritesInvariantViolationThenReturnsError(t *testing.T) {
	row := &fakeRow{
		id:        "payment-3",
		productID: "product-1",
		state:     string(domain.StateDeclined), // terminal state
		createdAt: time.Now(),
		updatedAt: time.Now(),
	}
	tx := newFakeTx(row)

	// A terminal state always produces "late", never InvalidTransitionError
	// per domain.ApplyTransition's own short-circuit — so to exercise the
	// InvalidTransitionError path we need a genuinely unknown event type.
	result, err := transitionInTx(context.Background(), tx, "payment-3", domain.CanonicalEvent{Type: domain.CanonicalEventType("not_a_real_event")}, alwaysStable, nil)
	if err == nil {
		t.Fatalf("expected an error, got outcome=%s", result.Outcome)
	}
	invalidErr, ok := err.(*domain.InvalidTransitionError)
	if !ok {
		t.Fatalf("expected *domain.InvalidTransitionError, got %T: %v", err, err)
	}
	if len(tx.paymentEventsInserted) != 1 {
		t.Fatalf("expected exactly one payment_events row (invariant_violation), got %d", len(tx.paymentEventsInserted))
	}
	ev := tx.paymentEventsInserted[0]
	if ev.EventType != "invariant_violation" {
		t.Fatalf("expected event_type=invariant_violation, got %s", ev.EventType)
	}
	if ev.ToState != nil {
		t.Fatalf("expected to_state=NULL for invariant_violation, got %v", *ev.ToState)
	}
	if ev.Metadata["attemptedEvent"] != "not_a_real_event" {
		t.Fatalf("expected metadata.attemptedEvent=not_a_real_event, got %v", ev.Metadata["attemptedEvent"])
	}
	if ev.Metadata["reason"] == nil || ev.Metadata["reason"] == "" {
		t.Fatalf("expected metadata.reason to be populated, got %v", ev.Metadata["reason"])
	}
	if invalidErr.Message == "" {
		t.Fatalf("expected a non-empty InvalidTransitionError message")
	}
	if row.state != string(domain.StateDeclined) {
		t.Fatalf("expected payments.state to remain unchanged, got %s", row.state)
	}
	if len(tx.outboxInserted) != 0 {
		t.Fatalf("expected zero outbox rows on an invalid transition, got %d", len(tx.outboxInserted))
	}
}

func TestTransitionInTx_TransitionedWithoutStableName_DoesNotEnqueueOutboxRow(t *testing.T) {
	row := &fakeRow{
		id:               "payment-4",
		merchantEntityID: "entity-1",
		productID:        "product-1",
		amountMinorUnits: 500,
		currency:         "EUR",
		state:            string(domain.StateAuthorizing),
		createdAt:        time.Now(),
		updatedAt:        time.Now(),
	}
	tx := newFakeTx(row)

	result, err := transitionInTx(context.Background(), tx, "payment-4", domain.CanonicalEvent{Type: domain.EventAuthorized}, neverStable, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Outcome != "transitioned" {
		t.Fatalf("expected outcome=transitioned, got %s", result.Outcome)
	}
	if len(tx.paymentEventsInserted) != 1 {
		t.Fatalf("expected exactly one payment_events row, got %d", len(tx.paymentEventsInserted))
	}
	if len(tx.outboxInserted) != 0 {
		t.Fatalf("expected zero outbox rows when stableName reports no stable name, got %d", len(tx.outboxInserted))
	}
}

func TestTransitionInTx_NilStableNameLookup_NeverEnqueuesOutboxRow(t *testing.T) {
	row := &fakeRow{
		id:        "payment-5",
		productID: "product-1",
		state:     string(domain.StateAuthorizing),
		createdAt: time.Now(),
		updatedAt: time.Now(),
	}
	tx := newFakeTx(row)

	result, err := transitionInTx(context.Background(), tx, "payment-5", domain.CanonicalEvent{Type: domain.EventAuthorized}, nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Outcome != "transitioned" {
		t.Fatalf("expected outcome=transitioned, got %s", result.Outcome)
	}
	if len(tx.outboxInserted) != 0 {
		t.Fatalf("expected zero outbox rows with a nil stableName lookup, got %d", len(tx.outboxInserted))
	}
}

func TestTransitionInTx_PaymentNotFound(t *testing.T) {
	tx := newFakeTx(nil)
	_, err := transitionInTx(context.Background(), tx, "does-not-exist", domain.CanonicalEvent{Type: domain.EventAuthorized}, alwaysStable, nil)
	if err == nil {
		t.Fatal("expected an error")
	}
	notFound, ok := err.(*PaymentNotFoundError)
	if !ok {
		t.Fatalf("expected *PaymentNotFoundError, got %T: %v", err, err)
	}
	if notFound.PaymentID != "does-not-exist" {
		t.Fatalf("expected PaymentID=does-not-exist, got %s", notFound.PaymentID)
	}
}

func TestTransitionInTx_DisputeWon_RequiresResolvedTarget(t *testing.T) {
	row := &fakeRow{
		id:        "payment-6",
		productID: "product-1",
		state:     string(domain.StateDisputeOpened),
		createdAt: time.Now(),
		updatedAt: time.Now(),
	}
	tx := newFakeTx(row)

	// No ResolvedTarget supplied -> ambiguous -> InvalidTransitionError,
	// and an invariant_violation row should still be written (this is
	// the exact case domain.ApplyTransition's own doc comment calls out
	// as "the genuine invariant-violation case, not a timing artifact").
	_, err := transitionInTx(context.Background(), tx, "payment-6", domain.CanonicalEvent{Type: domain.EventDisputeWon}, alwaysStable, nil)
	if err == nil {
		t.Fatal("expected an error for an unresolved ambiguous dispute_won event")
	}
	if len(tx.paymentEventsInserted) != 1 || tx.paymentEventsInserted[0].EventType != "invariant_violation" {
		t.Fatalf("expected exactly one invariant_violation row, got %+v", tx.paymentEventsInserted)
	}

	// Now with a valid ResolvedTarget, it should transition cleanly.
	tx2 := newFakeTx(&fakeRow{id: "payment-6", productID: "product-1", state: string(domain.StateDisputeOpened), createdAt: time.Now(), updatedAt: time.Now()})
	resolved := domain.StateCaptured
	result, err := transitionInTx(context.Background(), tx2, "payment-6", domain.CanonicalEvent{Type: domain.EventDisputeWon, ResolvedTarget: &resolved}, alwaysStable, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.To != domain.StateCaptured {
		t.Fatalf("expected resolved target captured, got %s", result.To)
	}
}

// Regression tests for the backend review's confirmed ledger write /
// state transition atomicity bug (2026-07-10): recordLedgerEntry
// (a LedgerEntryWriter) must be invoked, with the POST-transition
// payment row and toState, on a "transitioned" outcome and on that
// outcome only — never for "late" or an invalid/rejected transition,
// both of which return before reaching that point. See
// LedgerEntryWriter's doc comment in db.go for the full history of the
// bug this closes.

// recordedLedgerCall captures one recordLedgerEntry invocation for
// assertion purposes.
type recordedLedgerCall struct {
	payment PaymentRow
	toState domain.PaymentState
}

// spyLedgerWriter returns a LedgerEntryWriter that appends every call
// it receives to calls (a pointer so the closure can mutate the
// caller's slice), optionally returning err on every call — used to
// simulate a failing ledger write for the propagation test below.
func spyLedgerWriter(calls *[]recordedLedgerCall, err error) LedgerEntryWriter {
	return func(_ context.Context, _ Querier, payment PaymentRow, toState domain.PaymentState) error {
		*calls = append(*calls, recordedLedgerCall{payment: payment, toState: toState})
		return err
	}
}

func TestTransitionInTx_Transitioned_CallsRecordLedgerEntryWithUpdatedRowAndToState(t *testing.T) {
	row := &fakeRow{
		id:               "payment-7",
		merchantEntityID: "entity-1",
		productID:        "product-1",
		amountMinorUnits: 2500,
		currency:         "USD",
		state:            string(domain.StateAuthorizing),
		createdAt:        time.Now(),
		updatedAt:        time.Now(),
	}
	tx := newFakeTx(row)

	var calls []recordedLedgerCall
	result, err := transitionInTx(context.Background(), tx, "payment-7", domain.CanonicalEvent{Type: domain.EventAuthorized}, alwaysStable, spyLedgerWriter(&calls, nil))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(calls) != 1 {
		t.Fatalf("expected exactly one recordLedgerEntry call, got %d", len(calls))
	}
	if calls[0].toState != domain.StateAuthorized {
		t.Errorf("toState = %s, want %s", calls[0].toState, domain.StateAuthorized)
	}
	if calls[0].payment.State != domain.StateAuthorized {
		t.Errorf("payment.State = %s, want %s (the POST-transition row, not the pre-transition one)", calls[0].payment.State, domain.StateAuthorized)
	}
	if calls[0].payment.AmountMinorUnits != 2500 || calls[0].payment.Currency != "USD" {
		t.Errorf("unexpected payment row passed to recordLedgerEntry: %+v", calls[0].payment)
	}
	if result.Outcome != "transitioned" {
		t.Fatalf("expected outcome=transitioned, got %s", result.Outcome)
	}
}

func TestTransitionInTx_Late_DoesNotCallRecordLedgerEntry(t *testing.T) {
	row := &fakeRow{
		id:        "payment-8",
		productID: "product-1",
		state:     string(domain.StateAuthorized),
		createdAt: time.Now(),
		updatedAt: time.Now(),
	}
	tx := newFakeTx(row)

	var calls []recordedLedgerCall
	result, err := transitionInTx(context.Background(), tx, "payment-8", domain.CanonicalEvent{Type: domain.EventAuthorized}, alwaysStable, spyLedgerWriter(&calls, nil))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Outcome != "late" {
		t.Fatalf("expected outcome=late, got %s", result.Outcome)
	}
	if len(calls) != 0 {
		t.Fatalf("expected recordLedgerEntry NOT to be called for a late event, got %d calls", len(calls))
	}
}

func TestTransitionInTx_InvalidTransition_DoesNotCallRecordLedgerEntry(t *testing.T) {
	row := &fakeRow{
		id:        "payment-9",
		productID: "product-1",
		state:     string(domain.StateDeclined),
		createdAt: time.Now(),
		updatedAt: time.Now(),
	}
	tx := newFakeTx(row)

	var calls []recordedLedgerCall
	_, err := transitionInTx(context.Background(), tx, "payment-9", domain.CanonicalEvent{Type: domain.CanonicalEventType("not_a_real_event")}, alwaysStable, spyLedgerWriter(&calls, nil))
	if err == nil {
		t.Fatal("expected an error")
	}
	if len(calls) != 0 {
		t.Fatalf("expected recordLedgerEntry NOT to be called on an invalid transition, got %d calls", len(calls))
	}
}

// The actual atomicity guarantee (a failed ledger write rolls back the
// state update and payment_events insert too) lives in Transition's
// standard pgx Begin/defer-Rollback/Commit shape, not in
// transitionInTx itself (which receives an already-open Querier and
// has no commit/rollback of its own to manage) — this test verifies
// the piece transitionInTx IS responsible for: a non-nil error from
// recordLedgerEntry must propagate as transitionInTx's own returned
// error, so Transition's caller never reaches tx.Commit.
func TestTransitionInTx_RecordLedgerEntryErrorPropagates(t *testing.T) {
	row := &fakeRow{
		id:        "payment-10",
		productID: "product-1",
		state:     string(domain.StateAuthorizing),
		createdAt: time.Now(),
		updatedAt: time.Now(),
	}
	tx := newFakeTx(row)

	ledgerErr := errors.New("webhooks: insert transactions ledger row: connection reset")
	var calls []recordedLedgerCall
	_, err := transitionInTx(context.Background(), tx, "payment-10", domain.CanonicalEvent{Type: domain.EventAuthorized}, alwaysStable, spyLedgerWriter(&calls, ledgerErr))
	if !errors.Is(err, ledgerErr) {
		t.Fatalf("expected transitionInTx to propagate the ledger writer's error, got: %v", err)
	}
	if len(calls) != 1 {
		t.Fatalf("expected recordLedgerEntry to have been called exactly once, got %d", len(calls))
	}
}

func TestTransitionInTx_NilRecordLedgerEntry_NeverPanics(t *testing.T) {
	row := &fakeRow{
		id:        "payment-11",
		productID: "product-1",
		state:     string(domain.StateAuthorizing),
		createdAt: time.Now(),
		updatedAt: time.Now(),
	}
	tx := newFakeTx(row)

	result, err := transitionInTx(context.Background(), tx, "payment-11", domain.CanonicalEvent{Type: domain.EventAuthorized}, alwaysStable, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Outcome != "transitioned" {
		t.Fatalf("expected outcome=transitioned, got %s", result.Outcome)
	}
}
