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

import (
	"errors"
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

// SubscriptionsRouteDeps is everything this file's three handlers need.
type SubscriptionsRouteDeps struct {
	Pool *pgxpool.Pool
}

func registerSubscriptionsRoutes(r chi.Router, deps SubscriptionsRouteDeps) {
	r.Get("/subscriptions", handleListSubscriptions(deps))
	r.Get("/subscriptions/{id}", handleGetSubscription(deps))
	r.Post("/subscriptions/{id}/cancel", handleCancelSubscription(deps))
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
