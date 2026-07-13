package worker

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/alphapayments/payment-orchestrator/internal/adapters"
	"github.com/alphapayments/payment-orchestrator/internal/domain"
	"github.com/alphapayments/payment-orchestrator/internal/subscriptions"
)

// loadDueSubscriptions runs query (already parameterized with exactly
// one $1 = batchSize placeholder — see registerRenewalDispatcher's and
// registerDunningProcessor's own call sites for the two exact WHERE
// clauses this mirrors: `status='active' AND next_billing_at <= now()`
// for renewals, `status='past_due' AND dunning_next_retry_at <= now()`
// for dunning) and scans every row into a subscriptions.Subscription,
// shared by both task handlers to avoid duplicating this scan logic
// twice for what is otherwise an identical column list.
//
// COLLECT_TAX (Stripe integration audit, 2026-07-12, Task #317): query
// is now expected to end with one extra computed boolean column —
// `CASE WHEN p.tax_collection = 'disabled' THEN false WHEN
// p.tax_collection IN ('enabled','global') THEN true ELSE false END AS
// collect_tax` — via a `LEFT JOIN plans p ON p.id = s.plan_id`, so a
// subscription's originating plan's tax_collection setting is resolved
// in the same query that loads it, rather than a second round-trip per
// subscription. See tasks.go's two call sites for the exact SQL.
func loadDueSubscriptions(ctx context.Context, pool *pgxpool.Pool, query string, batchSize int) ([]subscriptions.Subscription, error) {
	rows, err := pool.Query(ctx, query, batchSize)
	if err != nil {
		return nil, fmt.Errorf("worker: query due subscriptions: %w", err)
	}
	defer rows.Close()

	var out []subscriptions.Subscription
	for rows.Next() {
		var s subscriptions.Subscription
		var intervalUnit string
		if err := rows.Scan(
			&s.ID, &s.MerchantEntityID, &s.ProductID, &s.CustomerID, &s.PaymentMethodID, &s.PspAccountID,
			&s.AmountMinorUnits, &s.Currency, &intervalUnit, &s.IntervalCount, &s.Status,
			&s.CurrentPeriodStart, &s.CurrentPeriodEnd, &s.NextBillingAt, &s.DunningStage, &s.DunningNextRetryAt,
			&s.CollectTax,
		); err != nil {
			return nil, fmt.Errorf("worker: scan due subscription row: %w", err)
		}
		s.IntervalUnit = subscriptions.IntervalUnit(intervalUnit)
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("worker: iterate due subscription rows: %w", err)
	}
	return out, nil
}

// routeRenewalOutcome mirrors createRenewalDispatcherTask's post-charge
// branch exactly: a hard/fraud decline cancels the subscription
// outright; any other declined/failed result hands off to the dunning
// ladder via MarkSubscriptionPastDue; anything else (authorized/
// captured/pending) advances the period.
func routeRenewalOutcome(ctx context.Context, deps Deps, subscriptionID string, outcome *subscriptions.ChargeSubscriptionResult, result *RenewalDispatcherResult) error {
	status := outcome.Result.Status
	if status == adapters.AttemptStatusDeclined || status == adapters.AttemptStatusFailed {
		if outcome.Result.Decline != nil && domain.IsHardDecline(outcome.Result.Decline.RetryClass) {
			if err := subscriptions.CancelSubscription(ctx, deps.Pool, subscriptionID, "hard_decline:"+outcome.Result.Decline.NormalizedCode); err != nil {
				return err
			}
			result.Canceled++
			return nil
		}
		if err := subscriptions.MarkSubscriptionPastDue(ctx, deps.Pool, subscriptionID); err != nil {
			return err
		}
		result.Declined++
		return nil
	}

	if err := subscriptions.AdvanceSubscriptionPeriod(ctx, deps.Pool, subscriptionID); err != nil {
		return err
	}
	result.Charged++
	return nil
}

// routeDunningOutcome mirrors createDunningProcessorTask's post-charge
// branch exactly: a hard/fraud decline cancels the subscription
// outright; any other declined/failed result advances the ladder
// (persists dunning_stage/dunning_next_retry_at from `decision`);
// anything else recovers the subscription (advances the period, same
// as a normal renewal success).
func routeDunningOutcome(ctx context.Context, deps Deps, subscriptionID string, outcome *subscriptions.ChargeSubscriptionResult, decision subscriptions.DunningDecision, result *DunningProcessorResult) error {
	status := outcome.Result.Status
	if status == adapters.AttemptStatusDeclined || status == adapters.AttemptStatusFailed {
		if outcome.Result.Decline != nil && domain.IsHardDecline(outcome.Result.Decline.RetryClass) {
			if err := subscriptions.CancelSubscription(ctx, deps.Pool, subscriptionID, "hard_decline:"+outcome.Result.Decline.NormalizedCode); err != nil {
				return err
			}
			result.Canceled++
			return nil
		}
		if err := advanceDunningStage(ctx, deps.Pool, subscriptionID, decision); err != nil {
			return err
		}
		result.StillPastDue++
		return nil
	}

	if err := subscriptions.AdvanceSubscriptionPeriod(ctx, deps.Pool, subscriptionID); err != nil {
		return err
	}
	result.Recovered++
	return nil
}

// advanceDunningStage mirrors the TS dunning task's
// `.updateTable('subscriptions').set({dunning_stage: decision.nextStage, dunning_next_retry_at: decision.nextRetryAt ?? null, updated_at: new Date()})`
// call exactly.
func advanceDunningStage(ctx context.Context, pool *pgxpool.Pool, subscriptionID string, decision subscriptions.DunningDecision) error {
	_, err := pool.Exec(ctx,
		`UPDATE subscriptions SET dunning_stage = $2, dunning_next_retry_at = $3, updated_at = now() WHERE id = $1`,
		subscriptionID, decision.NextStage, decision.NextRetryAt,
	)
	if err != nil {
		return fmt.Errorf("worker: advance dunning stage for subscription %s: %w", subscriptionID, err)
	}
	return nil
}

// loadDunningConfigForMerchant is the CONFIGURABLE RETRY/DUNNING POLICY
// feature's new call site: loads merchantEntityID's retry_settings row
// (if one exists) and returns the subscriptions.DunningConfig
// dunningProcessorHandler should pass to EvaluateDunningStep, falling
// back to subscriptions.DefaultDunningConfig() (the same hardcoded
// [24, 72, 168] this whole codebase shipped with before this feature)
// when no row exists yet for this merchant entity — mirroring
// internal/api/retry_settings.go's handleGetRetrySettings's own
// "no row yet is the common case, not an error" fallback, but
// reimplemented here as a direct SQL query rather than a call into
// internal/api, deliberately: this worker package has never imported
// internal/api (an HTTP-handler-shaped package, not a domain/store
// package this worker would otherwise depend on) for anything else,
// and reaching into it just to reuse PgxPaymentsStore.GetRetrySettings
// would be a one-off, backwards-looking dependency edge (worker ->
// api) that does not exist anywhere else in this codebase's layering —
// every other package this worker depends on (internal/subscriptions,
// internal/webhooks, internal/ledger, internal/outbound) is a plain
// domain/persistence package with no net/http surface at all. A
// duplicated four-column SELECT is a small, easily-verified price for
// keeping that layering boundary clean; see MIGRATION_NOTES.md's
// Configurable Retry/Dunning Policy section for this exact tradeoff
// named explicitly in its least-confident list.
//
// BUG FIX (backend review, 2026-07-10): this query used to select only
// dunning_ladder_hours, so a merchant's configured min_spacing_seconds
// was never loaded here at all — it was a completely dead
// configuration value throughout the system, not merely unenforced at
// its default of 0. Now also selects min_spacing_seconds and populates
// subscriptions.DunningConfig's new MinSpacingSeconds field; see that
// field's own doc comment in internal/subscriptions/dunning.go for the
// full history and how EvaluateDunningStep now actually enforces it as
// a floor under the ladder-hour delay.
func loadDunningConfigForMerchant(ctx context.Context, pool *pgxpool.Pool, merchantEntityID string) (subscriptions.DunningConfig, error) {
	var hours []int32
	var minSpacingSeconds int32
	err := pool.QueryRow(ctx,
		`SELECT dunning_ladder_hours, min_spacing_seconds FROM retry_settings WHERE merchant_entity_id = $1`,
		merchantEntityID,
	).Scan(&hours, &minSpacingSeconds)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return subscriptions.DefaultDunningConfig(), nil
		}
		return subscriptions.DunningConfig{}, fmt.Errorf("worker: query retry_settings for merchant %s: %w", merchantEntityID, err)
	}
	ladder := make([]int, len(hours))
	for i, h := range hours {
		ladder[i] = int(h)
	}
	return subscriptions.DunningConfig{LadderHours: ladder, MinSpacingSeconds: int(minSpacingSeconds)}, nil
}

// nowMinusHoursISO mirrors
// `new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString()`
// exactly.
func nowMinusHoursISO(sinceHours int) string {
	return time.Now().Add(-time.Duration(sinceHours) * time.Hour).UTC().Format("2006-01-02T15:04:05.000Z")
}
