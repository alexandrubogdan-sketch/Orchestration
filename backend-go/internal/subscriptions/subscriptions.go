// This file is the Go port of src/subscriptions/subscriptions.ts's
// lifecycle functions: CreateSubscription, AdvanceSubscriptionPeriod,
// MarkSubscriptionPastDue, CancelSubscription, PauseSubscription,
// ResumeSubscription. A subscription bills one specific
// payment_method (and, implicitly, the psp_account it belongs to) —
// see the T8.1 migration's own docblock (db/migrations/
// 1735777000000_subscriptions.up.sql) for why re-routing isn't
// attempted here: every MIT renewal attempt must carry the
// network_transaction_id captured on the instrument's original CIT
// attempt, and that continuity only holds if renewals keep billing
// through the same PSP account the card was first tokenized against.
package subscriptions

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// SubscriptionNotFoundError mirrors SubscriptionNotFoundError exactly.
type SubscriptionNotFoundError struct {
	SubscriptionID string
}

func (e *SubscriptionNotFoundError) Error() string {
	return fmt.Sprintf("Subscription %s not found", e.SubscriptionID)
}

// CreateSubscriptionInput mirrors CreateSubscriptionInput.
type CreateSubscriptionInput struct {
	MerchantEntityID  string
	ProductID         string
	CustomerID        string
	PaymentMethodID   string
	PspAccountID      string
	AmountMinorUnits  int64
	Currency          string
	IntervalUnit      IntervalUnit
	IntervalCount     int // 0 means "not specified" -> defaults to 1, mirroring `?? 1`.
	StartAt           *time.Time
}

// CreateSubscription mirrors createSubscription exactly.
func CreateSubscription(ctx context.Context, pool *pgxpool.Pool, input CreateSubscriptionInput) (string, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return "", fmt.Errorf("subscriptions: generate id: %w", err)
	}

	startAt := time.Now()
	if input.StartAt != nil {
		startAt = *input.StartAt
	}
	intervalCount := input.IntervalCount
	if intervalCount <= 0 {
		intervalCount = 1
	}
	periodEnd := AddInterval(startAt, input.IntervalUnit, intervalCount)

	_, err = pool.Exec(ctx,
		`INSERT INTO subscriptions (
			id, merchant_entity_id, product_id, customer_id, payment_method_id,
			psp_account_id, amount_minor_units, currency, interval_unit, interval_count,
			current_period_start, current_period_end, next_billing_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)`,
		id.String(), input.MerchantEntityID, input.ProductID, input.CustomerID, input.PaymentMethodID,
		input.PspAccountID, input.AmountMinorUnits, input.Currency, string(input.IntervalUnit), intervalCount,
		startAt, periodEnd,
	)
	if err != nil {
		return "", fmt.Errorf("subscriptions: insert subscription: %w", err)
	}

	return id.String(), nil
}

// Subscription mirrors the Selectable<SubscriptionsTable> columns this
// package's own functions and internal/worker's task wrappers need.
type Subscription struct {
	ID                  string
	MerchantEntityID    string
	ProductID           string
	CustomerID          string
	PaymentMethodID     string
	PspAccountID        string
	AmountMinorUnits    int64
	Currency            string
	IntervalUnit        IntervalUnit
	IntervalCount       int
	Status              string
	CurrentPeriodStart  time.Time
	CurrentPeriodEnd    time.Time
	NextBillingAt       time.Time
	DunningStage        int
	DunningNextRetryAt  *time.Time
}

// AdvanceSubscriptionPeriod mirrors advanceSubscriptionPeriod exactly:
// called after a successful renewal charge — advances to the next
// billing period and clears dunning state.
func AdvanceSubscriptionPeriod(ctx context.Context, pool *pgxpool.Pool, subscriptionID string) error {
	var currentPeriodEnd time.Time
	var intervalUnit string
	var intervalCount int
	err := pool.QueryRow(ctx,
		`SELECT current_period_end, interval_unit, interval_count FROM subscriptions WHERE id = $1`,
		subscriptionID,
	).Scan(&currentPeriodEnd, &intervalUnit, &intervalCount)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return &SubscriptionNotFoundError{SubscriptionID: subscriptionID}
		}
		return fmt.Errorf("subscriptions: query subscription %s: %w", subscriptionID, err)
	}

	newPeriodStart := currentPeriodEnd
	newPeriodEnd := AddInterval(newPeriodStart, IntervalUnit(intervalUnit), intervalCount)

	_, err = pool.Exec(ctx,
		`UPDATE subscriptions
		 SET current_period_start = $2, current_period_end = $3, next_billing_at = $3,
		     status = 'active', dunning_stage = 0, dunning_next_retry_at = NULL, updated_at = now()
		 WHERE id = $1`,
		subscriptionID, newPeriodStart, newPeriodEnd,
	)
	if err != nil {
		return fmt.Errorf("subscriptions: advance period for %s: %w", subscriptionID, err)
	}
	return nil
}

// MarkSubscriptionPastDue mirrors markSubscriptionPastDue exactly:
// called after a renewal charge is declined — hands off to the dunning
// ladder (T8.2) rather than canceling outright. dunning_next_retry_at
// is set to "now" (immediately eligible); the dunning cron's own
// cadence (every 15 minutes) is what actually schedules the ladder
// from here, not this function.
func MarkSubscriptionPastDue(ctx context.Context, pool *pgxpool.Pool, subscriptionID string) error {
	_, err := pool.Exec(ctx,
		`UPDATE subscriptions
		 SET status = 'past_due', dunning_next_retry_at = now(), updated_at = now()
		 WHERE id = $1`,
		subscriptionID,
	)
	if err != nil {
		return fmt.Errorf("subscriptions: mark %s past_due: %w", subscriptionID, err)
	}
	return nil
}

// CancelSubscription mirrors cancelSubscription exactly.
func CancelSubscription(ctx context.Context, pool *pgxpool.Pool, subscriptionID string, reason string) error {
	_, err := pool.Exec(ctx,
		`UPDATE subscriptions
		 SET status = 'canceled', canceled_at = now(), cancel_reason = $2,
		     dunning_next_retry_at = NULL, updated_at = now()
		 WHERE id = $1`,
		subscriptionID, reason,
	)
	if err != nil {
		return fmt.Errorf("subscriptions: cancel %s: %w", subscriptionID, err)
	}
	return nil
}

// PauseSubscription mirrors pauseSubscription exactly.
func PauseSubscription(ctx context.Context, pool *pgxpool.Pool, subscriptionID string) error {
	_, err := pool.Exec(ctx,
		`UPDATE subscriptions SET status = 'paused', updated_at = now() WHERE id = $1`,
		subscriptionID,
	)
	if err != nil {
		return fmt.Errorf("subscriptions: pause %s: %w", subscriptionID, err)
	}
	return nil
}

// ResumeSubscription mirrors resumeSubscription exactly: resuming
// immediately makes the (possibly already-past) period end due right
// away, rather than silently skipping a billing cycle that happened to
// fall during the pause.
func ResumeSubscription(ctx context.Context, pool *pgxpool.Pool, subscriptionID string) error {
	var currentPeriodEnd time.Time
	err := pool.QueryRow(ctx,
		`SELECT current_period_end FROM subscriptions WHERE id = $1`,
		subscriptionID,
	).Scan(&currentPeriodEnd)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return &SubscriptionNotFoundError{SubscriptionID: subscriptionID}
		}
		return fmt.Errorf("subscriptions: query subscription %s: %w", subscriptionID, err)
	}

	_, err = pool.Exec(ctx,
		`UPDATE subscriptions SET status = 'active', next_billing_at = $2, updated_at = now() WHERE id = $1`,
		subscriptionID, currentPeriodEnd,
	)
	if err != nil {
		return fmt.Errorf("subscriptions: resume %s: %w", subscriptionID, err)
	}
	return nil
}
