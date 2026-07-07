// Package statemachine is the DB-effectful shell around the pure
// internal/domain state machine (domain.ApplyTransition) — the Go port
// of src/domain/stateMachineDb.ts. internal/domain itself stays
// entirely I/O-free (per this project's own layering: "the pure
// transition table lives in internal/domain; anything that touches
// Postgres lives here instead"), mirroring the TS source's own split
// between stateMachine.ts (pure) and stateMachineDb.ts (DB-effectful).
//
// This is where Non-negotiables #2, #5, and #10 actually get enforced
// against Postgres:
//
//   - SELECT ... FOR UPDATE serializes concurrent transitions on the
//     same payment_id (Non-negotiable #2: Postgres, not app memory, is
//     the source of truth for state).
//   - Every outcome — transitioned, late, or rejected — writes exactly
//     one payment_events row in the same transaction as any
//     payments.state update (Non-negotiable #10). Late and rejected
//     outcomes write a timeline row too, just without changing state
//     (Non-negotiable #5: never regress/skip state on a duplicate or
//     out-of-order event).
//   - Rejected (InvalidTransitionError) is recorded as an
//     invariant_violation timeline row before the error is rethrown, so
//     the failure is visible on the payment's own timeline, not just in
//     logs.
//
// SERIALIZATION MECHANISM — read this before calling Transition from a
// new call site. The TS reference implementation's PRIMARY per-payment
// serialization is Hatchet's `concurrencyKey: (input) => input.paymentId`
// on the webhook-apply task (T3.3) — parallel across payments, but
// serialized within one payment_id at the QUEUE level — with this
// package's SELECT...FOR UPDATE as a secondary backstop. This Go port
// has NO Hatchet worker yet (Phase 6 territory; see MIGRATION_NOTES.md).
// Deliberate decision for this phase: SELECT...FOR UPDATE is the
// PRIMARY (and, for now, ONLY) serialization mechanism — and it is
// sufficient ALONE for correctness against every caller that goes
// through Postgres directly (every caller in this Go port today: the
// synchronous payments API routes AND the webhook apply path both call
// this package directly, with no queue in between). Postgres blocks a
// second FOR UPDATE reader on the same row until the first transaction
// commits or rolls back, which is exactly the mutual-exclusion property
// a queue-level concurrency key would otherwise provide. This is
// CORRECT today, not a stopgap pretending to be one. Phase 6, once a
// real Hatchet (or equivalent) worker exists, SHOULD add a queue-level
// concurrency-key equivalent on top of this — not because correctness
// requires it, but as defense-in-depth and a throughput optimization
// (a concurrency key stops a flood of redundant retries for the same
// payment from all piling up waiting on one Postgres row lock; FOR
// UPDATE alone would still be correct, just potentially slower under
// heavy contention on one payment_id).
package statemachine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/alphapayments/payment-orchestrator/internal/domain"
	"github.com/alphapayments/payment-orchestrator/internal/outbox"
)

// OutboundWebhookOutboxEventType mirrors the TS
// OUTBOUND_WEBHOOK_OUTBOX_EVENT_TYPE constant exactly — the shared
// outbox.event_type value every outbound-webhook-eligible domain event
// uses (Milestone 8, T8.4 — the actual delivery worker that reads this
// value back out is NOT built in this Go port yet; see
// MIGRATION_NOTES.md).
const OutboundWebhookOutboxEventType = "outbound-webhook"

// PaymentNotFoundError mirrors the TS PaymentNotFoundError exactly —
// returned when paymentId doesn't exist at all (not to be confused with
// a "late" outcome, which means the payment exists but the event isn't
// valid from its current state).
type PaymentNotFoundError struct {
	PaymentID string
}

func (e *PaymentNotFoundError) Error() string {
	return fmt.Sprintf("Payment %s not found", e.PaymentID)
}

// PaymentRow is the minimal payments-row shape this package touches —
// every column Transition either reads for its own decision-making
// (ID, State) or needs to echo into the outbox payload (ProductID,
// MerchantEntityID, AmountMinorUnits, Currency), plus UpdatedAt for
// completeness of the "RETURNING *" analogue. Deliberately narrower
// than a full payments row (see internal/api/payments.go's own
// PaymentRow for the row shape the HTTP layer needs instead — the two
// types are NOT the same and are not meant to be unified; each package
// carries only the columns it actually touches, matching this port's
// standing convention).
type PaymentRow struct {
	ID               string
	MerchantEntityID string
	ProductID        string
	CustomerID       string
	AmountMinorUnits int64
	Currency         string
	State            domain.PaymentState
	CitMit           string
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

// TransitionResult mirrors the TS TransitionResult interface exactly.
type TransitionResult struct {
	Payment PaymentRow
	Outcome string // "transitioned" | "late"
	From    domain.PaymentState
	To      domain.PaymentState
}

// stableNameLookup is the minimal capability Transition needs to decide
// whether a canonical event type has a stable, product-facing name
// (STABLE_NAME_BY_EVENT_TYPE in the TS source; internal/api/timeline.go's
// unexported stableNameByEventType map in this Go port — see this
// package's doc comment below on why Transition takes this as an
// injected function rather than importing internal/api directly).
type stableNameLookup func(eventType domain.CanonicalEventType) (string, bool)

// StableNameLookup is the exported constructor for the function
// Transition needs to decide outbox eligibility. cmd/api/main.go (or
// whoever wires this package) passes internal/api.StableName (exported
// specifically for this purpose — see timeline.go) here.
//
// WHY AN INJECTED FUNCTION, NOT A DIRECT IMPORT: internal/api/timeline.go
// already owns stableNameByEventType (ported from
// src/domain/timelineEvents.ts, reused by both the HTTP timeline
// serializer and — per the TS source's own doc comment on WHY that
// vocabulary lives in a file domain-adjacent-but-not-in-domain — this
// state-machine DB shell). internal/statemachine importing internal/api
// directly would create an import cycle the moment internal/api needs
// to call into internal/statemachine (which it will, once
// PaymentsStore.ApplyCanonicalEvents — living in package api per this
// phase's decision, see internal/api/pgpaymentsstore.go — calls
// Transition). Rather than move stableNameByEventType into
// internal/domain (which the TS source deliberately did NOT do either —
// see timeline.go's own top doc comment explaining the TS split), this
// package accepts the lookup as a caller-supplied function, breaking
// the cycle the same way the TS source's own module boundary does
// (stateMachineDb.ts imports timelineEvents.ts, not the other way
// around; here, internal/api supplies the function to
// internal/statemachine at the actual call site instead of
// internal/statemachine importing internal/api).
type StableNameLookup = stableNameLookup

// Querier is the minimal pgx surface this package needs from a
// transaction handle — QueryRow and Exec, matching exactly what
// Transition's body calls. Satisfied structurally by pgx.Tx (the real
// implementation) and by any hand-rolled fake in tests (db_test.go's
// fakeTx) — mirroring Phase 4's fakeScriptRunner pattern and this
// port's standing preference for small package-local interfaces over
// mocking libraries.
type Querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Pool is the minimal capability Transition needs to start a
// transaction — satisfied by *pgxpool.Pool. Narrowed to an interface so
// a test could substitute a fake pool if ever needed (today's
// db_test.go instead tests transitionInTx directly against a fakeTx,
// which is simpler and sufficient — see that file's doc comment).
type Pool interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Transition is the DB-effectful shell around domain.ApplyTransition —
// the Go port of stateMachineDb.ts's transition(db, paymentId, event).
// stableName resolves a canonical event type to its stable,
// product-facing name (see StableNameLookup's doc comment); pass nil to
// disable outbox writes entirely (no call site should do this in
// production — it exists so tests unconcerned with the outbox can omit
// it — the zero-value behavior is "never eligible," matching an event
// type absent from STABLE_NAME_BY_EVENT_TYPE in the TS source, i.e.
// fail safe by writing no outbox row rather than panicking on a nil
// function).
func Transition(ctx context.Context, pool Pool, paymentID string, event domain.CanonicalEvent, stableName stableNameLookup) (TransitionResult, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return TransitionResult{}, fmt.Errorf("statemachine: begin transaction: %w", err)
	}
	// Rollback-on-error via defer, matching pgx v5's documented idiom:
	// tx.Rollback is a no-op (returns pgx.ErrTxClosed, which is safe to
	// ignore) once tx.Commit has already succeeded, so an unconditional
	// deferred Rollback after a successful Commit is the standard,
	// safe pgx v5 pattern — not a bug.
	defer func() {
		_ = tx.Rollback(ctx)
	}()

	result, err := transitionInTx(ctx, tx, paymentID, event, stableName)
	if err != nil {
		return TransitionResult{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return TransitionResult{}, fmt.Errorf("statemachine: commit transaction: %w", err)
	}
	return result, nil
}

// transitionInTx is Transition's actual logic, factored out so
// db_test.go can exercise it directly against a fakeTx (satisfying
// Querier) without needing a real pgx.Tx/live Postgres — mirroring
// Phase 4's fakeScriptRunner-over-a-narrow-interface pattern. This is
// the function every test in db_test.go actually calls.
func transitionInTx(ctx context.Context, tx Querier, paymentID string, event domain.CanonicalEvent, stableName stableNameLookup) (TransitionResult, error) {
	var row PaymentRow
	var state string
	err := tx.QueryRow(ctx,
		`SELECT id, merchant_entity_id, product_id, customer_id, amount_minor_units, currency, state, cit_mit, created_at, updated_at
		 FROM payments
		 WHERE id = $1
		 FOR UPDATE`,
		paymentID,
	).Scan(&row.ID, &row.MerchantEntityID, &row.ProductID, &row.CustomerID, &row.AmountMinorUnits, &row.Currency, &state, &row.CitMit, &row.CreatedAt, &row.UpdatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return TransitionResult{}, &PaymentNotFoundError{PaymentID: paymentID}
		}
		return TransitionResult{}, fmt.Errorf("statemachine: select payments for update: %w", err)
	}
	row.State = domain.PaymentState(state)
	currentState := row.State

	outcome, applyErr := domain.ApplyTransition(currentState, event)
	if applyErr != nil {
		var invalidErr *domain.InvalidTransitionError
		if errors.As(applyErr, &invalidErr) {
			if insertErr := insertInvariantViolation(ctx, tx, paymentID, currentState, event, invalidErr); insertErr != nil {
				return TransitionResult{}, insertErr
			}
		}
		return TransitionResult{}, applyErr
	}

	if outcome.Kind == domain.TransitionKindLate {
		if err := insertLateEvent(ctx, tx, paymentID, currentState, event); err != nil {
			return TransitionResult{}, err
		}
		return TransitionResult{
			Payment: row,
			Outcome: "late",
			From:    currentState,
			To:      currentState,
		}, nil
	}

	updatedRow, err := updatePaymentState(ctx, tx, paymentID, outcome.To)
	if err != nil {
		return TransitionResult{}, err
	}

	if err := insertTransitionEvent(ctx, tx, paymentID, outcome.From, outcome.To, event); err != nil {
		return TransitionResult{}, err
	}

	// Milestone 8, T8.4: only canonical events with a stable,
	// product-facing name become an outbound webhook; late_event/
	// invariant_violation never reach this branch at all (they return
	// earlier), and an event type absent from the lookup (there are
	// none today, but the mapping is intentionally partial, exactly
	// like the TS source's Partial<Record<...>>) is silently skipped
	// rather than guessed at.
	if stableName != nil {
		if name, ok := stableName(event.Type); ok {
			if err := insertOutboundWebhookOutboxRow(ctx, tx, paymentID, name, updatedRow, event); err != nil {
				return TransitionResult{}, err
			}
		}
	}

	return TransitionResult{
		Payment: updatedRow,
		Outcome: "transitioned",
		From:    outcome.From,
		To:      outcome.To,
	}, nil
}

func insertInvariantViolation(ctx context.Context, tx Querier, paymentID string, currentState domain.PaymentState, event domain.CanonicalEvent, invalidErr *domain.InvalidTransitionError) error {
	metadata, err := json.Marshal(map[string]any{
		"attemptedEvent": event.Type,
		"reason":         invalidErr.Message,
	})
	if err != nil {
		return fmt.Errorf("statemachine: marshal invariant_violation metadata: %w", err)
	}
	id, err := uuid.NewV7()
	if err != nil {
		return fmt.Errorf("statemachine: generate payment_events id: %w", err)
	}
	_, err = tx.Exec(ctx,
		`INSERT INTO payment_events (id, payment_id, event_type, from_state, to_state, decline_code, metadata)
		 VALUES ($1, $2, 'invariant_violation', $3, NULL, $4, $5)`,
		id.String(), paymentID, string(currentState), event.DeclineCode, metadata,
	)
	if err != nil {
		return fmt.Errorf("statemachine: insert invariant_violation payment_events row: %w", err)
	}
	return nil
}

func insertLateEvent(ctx context.Context, tx Querier, paymentID string, currentState domain.PaymentState, event domain.CanonicalEvent) error {
	metadata, err := json.Marshal(map[string]any{
		"attemptedEvent": event.Type,
	})
	if err != nil {
		return fmt.Errorf("statemachine: marshal late_event metadata: %w", err)
	}
	id, err := uuid.NewV7()
	if err != nil {
		return fmt.Errorf("statemachine: generate payment_events id: %w", err)
	}
	_, err = tx.Exec(ctx,
		`INSERT INTO payment_events (id, payment_id, event_type, from_state, to_state, decline_code, metadata)
		 VALUES ($1, $2, 'late_event', $3, NULL, $4, $5)`,
		id.String(), paymentID, string(currentState), event.DeclineCode, metadata,
	)
	if err != nil {
		return fmt.Errorf("statemachine: insert late_event payment_events row: %w", err)
	}
	return nil
}

func insertTransitionEvent(ctx context.Context, tx Querier, paymentID string, from domain.PaymentState, to domain.PaymentState, event domain.CanonicalEvent) error {
	id, err := uuid.NewV7()
	if err != nil {
		return fmt.Errorf("statemachine: generate payment_events id: %w", err)
	}
	_, err = tx.Exec(ctx,
		`INSERT INTO payment_events (id, payment_id, event_type, from_state, to_state, decline_code, metadata)
		 VALUES ($1, $2, $3, $4, $5, $6, '{}')`,
		id.String(), paymentID, string(event.Type), string(from), string(to), event.DeclineCode,
	)
	if err != nil {
		return fmt.Errorf("statemachine: insert %s payment_events row: %w", event.Type, err)
	}
	return nil
}

// updatePaymentState mirrors `UPDATE payments SET state=..., updated_at=now() WHERE id=$1 RETURNING *`.
func updatePaymentState(ctx context.Context, tx Querier, paymentID string, to domain.PaymentState) (PaymentRow, error) {
	var row PaymentRow
	var state string
	err := tx.QueryRow(ctx,
		`UPDATE payments SET state = $1, updated_at = now()
		 WHERE id = $2
		 RETURNING id, merchant_entity_id, product_id, customer_id, amount_minor_units, currency, state, cit_mit, created_at, updated_at`,
		string(to), paymentID,
	).Scan(&row.ID, &row.MerchantEntityID, &row.ProductID, &row.CustomerID, &row.AmountMinorUnits, &row.Currency, &state, &row.CitMit, &row.CreatedAt, &row.UpdatedAt)
	if err != nil {
		return PaymentRow{}, fmt.Errorf("statemachine: update payments state: %w", err)
	}
	row.State = domain.PaymentState(state)
	return row, nil
}

// insertOutboundWebhookOutboxRow mirrors stateMachineDb.ts's
// insertOutboxEvent call exactly: same payload shape, same event_type
// constant, same aggregate_type/aggregate_id. occurredAt is generated
// here (time.Now, UTC, RFC3339Nano) rather than passed in — the TS
// source likewise calls `new Date().toISOString()` inline at this exact
// point, not earlier, so both versions timestamp the outbox row at
// outbox-insert time, not at event-receipt time.
func insertOutboundWebhookOutboxRow(ctx context.Context, tx outbox.Execer, paymentID string, stableName string, payment PaymentRow, event domain.CanonicalEvent) error {
	payload := map[string]any{
		"event":            stableName,
		"productId":        payment.ProductID,
		"merchantEntityId": payment.MerchantEntityID,
		"paymentId":        paymentID,
		"occurredAt":       time.Now().UTC().Format(time.RFC3339Nano),
		"data": map[string]any{
			"state": string(payment.State),
			"amount": map[string]any{
				"minorUnits": payment.AmountMinorUnits,
				"currency":   payment.Currency,
			},
			"declineCode": event.DeclineCode,
		},
	}
	_, err := outbox.InsertEvent(ctx, tx, outbox.Event{
		AggregateType: "payment",
		AggregateID:   paymentID,
		EventType:     OutboundWebhookOutboxEventType,
		Payload:       payload,
	})
	if err != nil {
		return fmt.Errorf("statemachine: insert outbound-webhook outbox row: %w", err)
	}
	return nil
}
