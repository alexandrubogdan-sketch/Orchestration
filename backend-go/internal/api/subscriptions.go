package api

// This file adds the first HTTP-facing routes on top of the
// pre-existing internal/subscriptions package (Milestone 8's renewal/
// dunning/account-updater worker logic): GET /v1/subscriptions (list,
// optional ?customerId= filter), GET /v1/subscriptions/{id}, and POST
// /v1/subscriptions/{id}/cancel. Until now, subscriptions had no HTTP
// surface at all — every function in internal/subscriptions
// (CancelSubscription, etc.) was called only by the background worker
// (cmd/worker/main.go), and no route anywhere returned a real
// subscription id (payments.go's PaymentDTO doesn't surface
// subscription_id either). The two GET routes exist specifically so an
// MCP "research" tool (list_subscriptions/get_subscription — see
// agent_tokens.go's doc comment for the feature this is part of) has
// something to look up a subscription id FROM before an agent can ever
// call cancel — without them, cancel_subscription would be wired but
// practically undiscoverable.
//
// Deliberately queries deps.Pool directly rather than introducing a
// fourth store-interface type the way payments/customers/checkout-
// sessions/retry-settings/plans each have — every query here is a
// single flat SELECT against one table, and the one mutation
// (CancelSubscription) already exists as a plain function taking a
// *pgxpool.Pool in internal/subscriptions. A future pass adding write
// paths beyond cancel (pause/resume, changing the billing amount) would
// be the natural trigger to promote this into a proper
// SubscriptionsStore interface instead.
//
// POST .../cancel is the only mutating route here, so it — and only it
// — calls RequireWriteScope (auth.go) before touching anything: a
// read_only-scoped MCP agent token can list/get subscriptions freely
// but gets 403 on cancel, exactly like it would on a refund/void/
// capture.
//
// POST /v1/subscriptions (Stripe integration audit, 2026-07-12, Task
// #316) is this file's second mutating route, added later than the
// three above — it turns a plans.go catalog row into an actual billing
// subscription, closing the gap flagged by the audit: plans.go/
// 1735777400000_plans.up.sql shipped a whole pricing-catalog feature
// that internal/subscriptions.CreateSubscription had no caller for at
// all. See handleCreateSubscription's own doc comment for the full
// plan-to-subscription mapping, including how a trial-enabled plan's
// trial period is represented and how it transitions to the plan's real
// price (internal/subscriptions/subscriptions.go's
// AdvanceSubscriptionPeriod).

import (
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/alphapayments/payment-orchestrator/internal/subscriptions"
)

// subscriptionDTO is deliberately richer than the strict minimum
// handleCancelSubscription needs — AmountMinorUnits/Currency/
// NextBillingAt/CustomerID are included so GET /v1/subscriptions(/{id})
// is actually useful for an agent to "research" a customer's billing
// state, not just a bare id+status pair.
type subscriptionDTO struct {
	ID                string  `json:"id"`
	CustomerID        string  `json:"customerId"`
	Status            string  `json:"status"`
	AmountMinorUnits  int64   `json:"amountMinorUnits"`
	Currency          string  `json:"currency"`
	IntervalUnit      string  `json:"intervalUnit"`
	IntervalCount     int     `json:"intervalCount"`
	NextBillingAt     string  `json:"nextBillingAt"`
	CanceledAt        *string `json:"canceledAt"`
	CancelReason      *string `json:"cancelReason"`
}

type cancelSubscriptionRequest struct {
	Reason string `json:"reason"`
}

// createSubscriptionRequest is the input to POST /v1/subscriptions.
// StartAt is optional (RFC3339); omitted means "now," matching
// internal/subscriptions.CreateSubscription's own StartAt-defaults-to-
// time.Now() behavior.
type createSubscriptionRequest struct {
	PlanID          string  `json:"planId"`
	CustomerID      string  `json:"customerId"`
	PaymentMethodID string  `json:"paymentMethodId"`
	StartAt         *string `json:"startAt"`
}

// SubscriptionsRouteDeps is everything this file's handlers need.
type SubscriptionsRouteDeps struct {
	Pool *pgxpool.Pool
}

func registerSubscriptionsRoutes(r chi.Router, deps SubscriptionsRouteDeps) {
	r.Get("/subscriptions", handleListSubscriptions(deps))
	r.Get("/subscriptions/{id}", handleGetSubscription(deps))
	r.Post("/subscriptions", handleCreateSubscription(deps))
	r.Post("/subscriptions/{id}/cancel", handleCancelSubscription(deps))
}

// planIntervalUnitToSubscriptionInterval maps plans.billing_interval_unit/
// trial_interval_unit's vocabulary ("days"/"months"/"years" — see
// 1735777400000_plans.up.sql's CHECK constraint) onto
// internal/subscriptions.IntervalUnit's own, narrower vocabulary
// ("day"/"week"/"month"/"year" — see 1735777000000_subscriptions.up.sql's
// CHECK constraint). The two enums were designed independently (plans
// predates any wiring to subscriptions) and don't share a spelling —
// this is the one explicit translation point between them. There is no
// "weeks" case: plans has never supported a weekly billing interval, so
// there is nothing to map it from.
func planIntervalUnitToSubscriptionInterval(planUnit string) (subscriptions.IntervalUnit, error) {
	switch planUnit {
	case "days":
		return subscriptions.IntervalDay, nil
	case "months":
		return subscriptions.IntervalMonth, nil
	case "years":
		return subscriptions.IntervalYear, nil
	default:
		return "", fmt.Errorf("unrecognized plan billing interval unit %q", planUnit)
	}
}

const subscriptionColumns = `id, customer_id, status, amount_minor_units, currency, interval_unit, interval_count, next_billing_at, canceled_at, cancel_reason`

func scanSubscriptionRow(row interface {
	Scan(dest ...any) error
}) (subscriptionDTO, error) {
	var dto subscriptionDTO
	var nextBillingAt time.Time
	var canceledAt *time.Time
	err := row.Scan(
		&dto.ID, &dto.CustomerID, &dto.Status, &dto.AmountMinorUnits, &dto.Currency,
		&dto.IntervalUnit, &dto.IntervalCount, &nextBillingAt, &canceledAt, &dto.CancelReason,
	)
	if err != nil {
		return subscriptionDTO{}, err
	}
	dto.NextBillingAt = nextBillingAt.UTC().Format(time.RFC3339Nano)
	if canceledAt != nil {
		s := canceledAt.UTC().Format(time.RFC3339Nano)
		dto.CanceledAt = &s
	}
	return dto, nil
}

// handleListSubscriptions implements GET /v1/subscriptions, scoped to
// auth.MerchantEntityID and optionally filtered by ?customerId=.
func handleListSubscriptions(deps SubscriptionsRouteDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth, ok := authFromContext(r.Context())
		if !ok {
			WriteProblem(w, http.StatusUnauthorized, "Missing or invalid API token", "")
			return
		}
		if deps.Pool == nil {
			WriteProblem(w, http.StatusNotImplemented, "Not implemented", ErrNotImplemented.Error())
			return
		}

		customerID := r.URL.Query().Get("customerId")
		query := `SELECT ` + subscriptionColumns + ` FROM subscriptions WHERE merchant_entity_id = $1`
		args := []any{auth.MerchantEntityID}
		if customerID != "" {
			query += ` AND customer_id = $2`
			args = append(args, customerID)
		}
		query += ` ORDER BY created_at DESC`

		rows, err := deps.Pool.Query(r.Context(), query, args...)
		if err != nil {
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}
		defer rows.Close()

		dtos := []subscriptionDTO{}
		for rows.Next() {
			dto, err := scanSubscriptionRow(rows)
			if err != nil {
				WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
				return
			}
			dtos = append(dtos, dto)
		}
		if err := rows.Err(); err != nil {
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}

		writeJSON(w, http.StatusOK, dtos)
	}
}

// handleGetSubscription implements GET /v1/subscriptions/{id}, scoped
// to auth.MerchantEntityID.
func handleGetSubscription(deps SubscriptionsRouteDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth, ok := authFromContext(r.Context())
		if !ok {
			WriteProblem(w, http.StatusUnauthorized, "Missing or invalid API token", "")
			return
		}
		if deps.Pool == nil {
			WriteProblem(w, http.StatusNotImplemented, "Not implemented", ErrNotImplemented.Error())
			return
		}
		id := chi.URLParam(r, "id")

		row := deps.Pool.QueryRow(r.Context(),
			`SELECT `+subscriptionColumns+` FROM subscriptions WHERE id = $1 AND merchant_entity_id = $2`,
			id, auth.MerchantEntityID,
		)
		dto, err := scanSubscriptionRow(row)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				WriteProblem(w, http.StatusNotFound, "Subscription not found", "")
				return
			}
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}

		writeJSON(w, http.StatusOK, dto)
	}
}

// handleCreateSubscription implements POST /v1/subscriptions: turns a
// plans.go catalog row into a real, billing subscriptions row.
//
// PLAN -> SUBSCRIPTION MAPPING:
//   - The plan must be type='recurring' (a 'one-off' plan has no
//     billing_interval and cannot be subscribed to — it's a single
//     charge, handled entirely through checkout, never through this
//     route).
//   - No trial: the subscription's first period bills
//     base_price_minor_units/base_price_currency on
//     billing_interval_amount/billing_interval_unit, starting now (or
//     StartAt). PlanID is stored; post_trial_* stays NULL for this
//     subscription's entire life.
//   - Trial enabled: the subscription's FIRST period bills
//     trial_price_minor_units/trial_price_currency on
//     trial_interval_amount/trial_interval_unit instead, and
//     post_trial_* is populated with the plan's real
//     price/cadence — internal/subscriptions.AdvanceSubscriptionPeriod
//     switches over to those values automatically the moment this first
//     (trial) period's charge succeeds. See that function's own doc
//     comment for the transition mechanics.
//
// SIMPLIFICATION, flagged explicitly rather than silently: this handler
// always uses the plan's BASE trial/base price, never a
// plan_price_rules per-country/currency override — full override
// resolution (the same logic checkout_sessions.go's confirm path
// applies) was judged out of scope for this pass; every subscription
// created here bills in the plan's own base_price_currency/
// trial_price_currency regardless of the customer's country. A future
// pass extending this route with an optional countryCode input, and
// resolving it against plan_price_rules the same way checkout does,
// would close that gap.
//
// PSP ACCOUNT: taken directly from the chosen payment_method's own
// psp_account_id, never re-resolved via routing — see
// internal/subscriptions' package-top doc comment on why a subscription
// must keep billing through the exact PSP account its instrument was
// first tokenized against.
func handleCreateSubscription(deps SubscriptionsRouteDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth, ok := authFromContext(r.Context())
		if !ok {
			WriteProblem(w, http.StatusUnauthorized, "Missing or invalid API token", "")
			return
		}
		if !RequireWriteScope(w, auth) {
			return
		}
		if deps.Pool == nil {
			WriteProblem(w, http.StatusNotImplemented, "Not implemented", ErrNotImplemented.Error())
			return
		}

		var body createSubscriptionRequest
		if !decodeJSONBody(w, r, &body) {
			return
		}
		if body.PlanID == "" || body.CustomerID == "" || body.PaymentMethodID == "" {
			WriteProblem(w, http.StatusBadRequest, "planId, customerId, and paymentMethodId are all required", "")
			return
		}
		var startAt *time.Time
		if body.StartAt != nil && *body.StartAt != "" {
			parsed, err := time.Parse(time.RFC3339, *body.StartAt)
			if err != nil {
				WriteProblem(w, http.StatusBadRequest, "startAt must be an RFC3339 timestamp", "")
				return
			}
			startAt = &parsed
		}

		var plan struct {
			Type                  string
			BillingIntervalAmount *int
			BillingIntervalUnit   *string
			BasePriceMinorUnits   int64
			BasePriceCurrency     string
			TrialEnabled          bool
			TrialIntervalAmount   *int
			TrialIntervalUnit     *string
			TrialPriceMinorUnits  *int64
			TrialPriceCurrency    *string
		}
		err := deps.Pool.QueryRow(r.Context(),
			`SELECT type, billing_interval_amount, billing_interval_unit,
			        base_price_minor_units, base_price_currency,
			        trial_enabled, trial_interval_amount, trial_interval_unit,
			        trial_price_minor_units, trial_price_currency
			 FROM plans WHERE id = $1 AND merchant_entity_id = $2`,
			body.PlanID, auth.MerchantEntityID,
		).Scan(&plan.Type, &plan.BillingIntervalAmount, &plan.BillingIntervalUnit,
			&plan.BasePriceMinorUnits, &plan.BasePriceCurrency,
			&plan.TrialEnabled, &plan.TrialIntervalAmount, &plan.TrialIntervalUnit,
			&plan.TrialPriceMinorUnits, &plan.TrialPriceCurrency)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				WriteProblem(w, http.StatusNotFound, "Plan not found", "")
				return
			}
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}
		if plan.Type != "recurring" {
			WriteProblem(w, http.StatusBadRequest, "Plan is not a recurring plan and cannot be subscribed to", "")
			return
		}
		if plan.BillingIntervalAmount == nil || plan.BillingIntervalUnit == nil {
			// Data-integrity problem, not a caller error — every
			// type='recurring' plan should have both set by plans.go's own
			// write-path validation.
			WriteProblem(w, http.StatusInternalServerError, "Plan is missing its billing interval", "")
			return
		}
		baseIntervalUnit, err := planIntervalUnitToSubscriptionInterval(*plan.BillingIntervalUnit)
		if err != nil {
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}

		var paymentMethod struct {
			CustomerID       string
			PspAccountID     string
			IsActive         bool
			MerchantEntityID string
		}
		err = deps.Pool.QueryRow(r.Context(),
			`SELECT pm.customer_id, pm.psp_account_id, pm.is_active, c.merchant_entity_id
			 FROM payment_methods pm
			 JOIN customers c ON c.id = pm.customer_id
			 WHERE pm.id = $1`,
			body.PaymentMethodID,
		).Scan(&paymentMethod.CustomerID, &paymentMethod.PspAccountID, &paymentMethod.IsActive, &paymentMethod.MerchantEntityID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				WriteProblem(w, http.StatusNotFound, "Payment method not found", "")
				return
			}
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}
		if paymentMethod.MerchantEntityID != auth.MerchantEntityID {
			WriteProblem(w, http.StatusNotFound, "Payment method not found", "")
			return
		}
		if paymentMethod.CustomerID != body.CustomerID {
			WriteProblem(w, http.StatusBadRequest, "Payment method does not belong to the given customer", "")
			return
		}
		if !paymentMethod.IsActive {
			WriteProblem(w, http.StatusConflict, "Payment method is not active", "")
			return
		}

		input := subscriptions.CreateSubscriptionInput{
			MerchantEntityID: auth.MerchantEntityID,
			ProductID:        auth.ProductID,
			CustomerID:       body.CustomerID,
			PaymentMethodID:  body.PaymentMethodID,
			PspAccountID:     paymentMethod.PspAccountID,
			PlanID:           &body.PlanID,
			StartAt:          startAt,
		}
		if plan.TrialEnabled {
			if plan.TrialIntervalAmount == nil || plan.TrialIntervalUnit == nil || plan.TrialPriceMinorUnits == nil || plan.TrialPriceCurrency == nil {
				WriteProblem(w, http.StatusInternalServerError, "Plan has trial_enabled but is missing trial fields", "")
				return
			}
			trialIntervalUnit, err := planIntervalUnitToSubscriptionInterval(*plan.TrialIntervalUnit)
			if err != nil {
				WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
				return
			}
			input.AmountMinorUnits = *plan.TrialPriceMinorUnits
			input.Currency = *plan.TrialPriceCurrency
			input.IntervalUnit = trialIntervalUnit
			input.IntervalCount = *plan.TrialIntervalAmount
			input.PostTrialAmountMinorUnits = &plan.BasePriceMinorUnits
			input.PostTrialCurrency = &plan.BasePriceCurrency
			input.PostTrialIntervalUnit = &baseIntervalUnit
			input.PostTrialIntervalCount = plan.BillingIntervalAmount
		} else {
			input.AmountMinorUnits = plan.BasePriceMinorUnits
			input.Currency = plan.BasePriceCurrency
			input.IntervalUnit = baseIntervalUnit
			input.IntervalCount = *plan.BillingIntervalAmount
		}

		id, err := subscriptions.CreateSubscription(r.Context(), deps.Pool, input)
		if err != nil {
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}

		row := deps.Pool.QueryRow(r.Context(),
			`SELECT `+subscriptionColumns+` FROM subscriptions WHERE id = $1`, id,
		)
		dto, err := scanSubscriptionRow(row)
		if err != nil {
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}

		writeJSON(w, http.StatusCreated, dto)
	}
}

func handleCancelSubscription(deps SubscriptionsRouteDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth, ok := authFromContext(r.Context())
		if !ok {
			WriteProblem(w, http.StatusUnauthorized, "Missing or invalid API token", "")
			return
		}
		if !RequireWriteScope(w, auth) {
			return
		}
		id := chi.URLParam(r, "id")

		if deps.Pool == nil {
			WriteProblem(w, http.StatusNotImplemented, "Not implemented", ErrNotImplemented.Error())
			return
		}

		var body cancelSubscriptionRequest
		if r.ContentLength != 0 {
			if !decodeJSONBody(w, r, &body) {
				return
			}
		}
		reason := body.Reason
		if reason == "" {
			reason = "canceled via API"
		}

		// Existence-and-ownership check before mutating — every other
		// handler in this package does the equivalent check via its
		// Store's Get* method; this route has no store of its own (see
		// this file's top doc comment), so it's inline here instead.
		var merchantEntityID string
		err := deps.Pool.QueryRow(r.Context(),
			`SELECT merchant_entity_id FROM subscriptions WHERE id = $1`, id,
		).Scan(&merchantEntityID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				WriteProblem(w, http.StatusNotFound, "Subscription not found", "")
				return
			}
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}
		if merchantEntityID != auth.MerchantEntityID {
			WriteProblem(w, http.StatusNotFound, "Subscription not found", "")
			return
		}

		if err := subscriptions.CancelSubscription(r.Context(), deps.Pool, id, reason); err != nil {
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}

		row := deps.Pool.QueryRow(r.Context(),
			`SELECT `+subscriptionColumns+` FROM subscriptions WHERE id = $1`, id,
		)
		dto, err := scanSubscriptionRow(row)
		if err != nil {
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}

		writeJSON(w, http.StatusOK, dto)
	}
}
