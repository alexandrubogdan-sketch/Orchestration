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
//
// PlanID/PostTrial* (Stripe integration audit, 2026-07-12, Task #316):
// added when POST /v1/subscriptions (internal/api/subscriptions.go)
// became this function's first real caller — see that file's top doc
// comment for the Plans-catalog-to-real-subscription wiring this
// closes. PlanID is optional (nil for a subscription created with no
// backing plan row, preserving this function's pre-existing behavior
// for any caller that doesn't supply one). The four PostTrial* fields
// are either all nil (no trial — the common case, and the only case
// this function supported before this fix) or all set together: when
// set, AmountMinorUnits/Currency/IntervalUnit/IntervalCount describe the
// TRIAL period being created right now, and PostTrial* describe what
// AdvanceSubscriptionPeriod should switch the subscription to once that
// trial period closes — see that function's own doc comment for the
// transition mechanics.
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
	PlanID                 *string
	PostTrialAmountMinorUnits *int64
	PostTrialCurrency         *string
	PostTrialIntervalUnit     *IntervalUnit
	PostTrialIntervalCount    *int
}

// CreateSubscription mirrors createSubscription exactly, extended with
// the plan_id/post_trial_* columns described on CreateSubscriptionInput
// above.
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

	var postTrialIntervalUnit *string
	if input.PostTrialIntervalUnit != nil {
		s := string(*input.PostTrialIntervalUnit)
		postTrialIntervalUnit = &s
	}

	_, err = pool.Exec(ctx,
		`INSERT INTO subscriptions (
			id, merchant_entity_id, product_id, customer_id, payment_method_id,
			psp_account_id, amount_minor_units, currency, interval_unit, interval_count,
			current_period_start, current_period_end, next_billing_at,
			plan_id, post_trial_amount_minor_units, post_trial_currency,
			post_trial_interval_unit, post_trial_interval_count
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12, $13, $14, $15, $16, $17)`,
		id.String(), input.MerchantEntityID, input.ProductID, input.CustomerID, input.PaymentMethodID,
		input.PspAccountID, input.AmountMinorUnits, input.Currency, string(input.IntervalUnit), intervalCount,
		startAt, periodEnd,
		input.PlanID, input.PostTrialAmountMinorUnits, input.PostTrialCurrency,
		postTrialIntervalUnit, input.PostTrialIntervalCount,
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
	// CollectTax (Stripe integration audit, 2026-07-12, Task #317): not
	// a subscriptions table column itself — populated by
	// internal/worker's loadDueSubscriptions from a LEFT JOIN against
	// this subscription's plans row (via plan_id), resolving that
	// plan's tax_collection setting. false for a subscription with no
	// plan_id at all. See adapters.CreatePaymentInput.CollectTax's own
	// doc comment for how AttemptSubscriptionCharge (renewal.go) uses
	// this.
	CollectTax          bool
	DunningStage        int
	DunningNextRetryAt  *time.Time
}

// AdvanceSubscriptionPeriod mirrors advanceSubscriptionPeriod exactly:
// called after a successful renewal charge — advances to the next
// billing period and clears dunning state.
//
// TRIAL-TO-REAL TRANSITION (Stripe integration audit, 2026-07-12, Task
// #316): if this subscription's post_trial_* columns are set, the
// period that just closed successfully WAS the trial period (see
// CreateSubscriptionInput's own doc comment — those four columns are
// only ever set together, at creation, on a trial-enabled plan's
// subscription). This function is the one and only place that
// transition happens: amount_minor_units/currency/interval_unit/
// interval_count are overwritten with the post_trial_* values (the
// plan's real, non-trial price/cadence) and the next period is computed
// using THAT interval, not the trial's — so the very next renewal
// dispatcher sweep bills the real price on the real cadence with no
// separate "trial ended" job needed. post_trial_* is cleared back to
// NULL in the same UPDATE so this only ever fires once per
// subscription. A non-trial subscription (post_trial_amount_minor_units
// already NULL) falls through to the exact pre-existing behavior —
// advance using the row's own interval_unit/interval_count, unchanged.
func AdvanceSubscriptionPeriod(ctx context.Context, pool *pgxpool.Pool, subscriptionID string) error {
	var currentPeriodEnd time.Time
	var intervalUnit string
	var intervalCount int
	var postTrialAmount *int64
	var postTrialCurrency *string
	var postTrialIntervalUnit *string
	var postTrialIntervalCount *int
	err := pool.QueryRow(ctx,
		`SELECT current_period_end, interval_unit, interval_count,
		        post_trial_amount_minor_units, post_trial_currency,
		        post_trial_interval_unit, post_trial_interval_count
		 FROM subscriptions WHERE id = $1`,
		subscriptionID,
	).Scan(&currentPeriodEnd, &intervalUnit, &intervalCount,
		&postTrialAmount, &postTrialCurrency, &postTrialIntervalUnit, &postTrialIntervalCount)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return &SubscriptionNotFoundError{SubscriptionID: subscriptionID}
		}
		return fmt.Errorf("subscriptions: query subscription %s: %w", subscriptionID, err)
	}

	newPeriodStart := currentPeriodEnd

	if postTrialAmount != nil && postTrialCurrency != nil && postTrialIntervalUnit != nil && postTrialIntervalCount != nil {
		// The trial period just closed — switch to the plan's real
		// price/cadence for every period from here on.
		newPeriodEnd := AddInterval(newPeriodStart, IntervalUnit(*postTrialIntervalUnit), *postTrialIntervalCount)
		_, err = pool.Exec(ctx,
			`UPDATE subscriptions
			 SET current_period_start = $2, current_period_end = $3, next_billing_at = $3,
			     status = 'active', dunning_stage = 0, dunning_next_retry_at = NULL,
			     amount_minor_units = $4, currency = $5, interval_unit = $6, interval_count = $7,
			     post_trial_amount_minor_units = NULL, post_trial_currency = NULL,
			     post_trial_interval_unit = NULL, post_trial_interval_count = NULL,
			     updated_at = now()
			 WHERE id = $1`,
			subscriptionID, newPeriodStart, newPeriodEnd,
			*postTrialAmount, *postTrialCurrency, *postTrialIntervalUnit, *postTrialIntervalCount,
		)
		if err != nil {
			return fmt.Errorf("subscriptions: advance period (trial-to-real transition) for %s: %w", subscriptionID, err)
		}
		return nil
	}

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
