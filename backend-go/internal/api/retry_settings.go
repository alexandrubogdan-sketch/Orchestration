package api

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
)

// This file adds the retry_settings resource: a DB-backed, per-
// merchant-entity, API-configurable replacement for the two hardcoded
// vars this codebase shipped with up to this point —
// internal/routing/retrypolicy.go's DefaultRetryPolicy
// ({MaxAttemptsPerPayment: 3, MinSpacing: 2s}) and
// internal/subscriptions/dunning.go's DunningLadderHours
// ([24, 72, 168]). See db/migrations/1735777300000_retry-settings.up.sql's
// doc comment for the table shape and MIGRATION_NOTES.md's Configurable
// Retry/Dunning Policy section for the full feature writeup.
//
// This file deliberately follows checkout_sessions.go's established
// shapes (narrow store interface, a Row-suffixed DTO mirroring the
// table exactly, WriteProblem for every error path, doc comments
// explaining WHY) rather than inventing new conventions. The one
// genuinely new wrinkle here relative to every prior resource in this
// package is the "lazy row" behavior: GET returns hardcoded defaults
// directly (never touching the DB, never inserting a row) when no row
// exists yet, and only PUT ever creates one — see
// handleGetRetrySettings/handleUpsertRetrySettings's own doc comments
// for exactly why this split was chosen over a "create on first GET"
// pattern (short answer: there is no existing "get-or-default" fixture
// anywhere else in this codebase to follow, and this is simpler to
// reason about with no compiler available to verify a trickier
// upsert-on-read path).

// RetrySettingsRow mirrors the retry_settings table exactly — the
// narrow shape this file's handlers and PgxPaymentsStore's
// implementation both read/write, matching CheckoutSessionRow's own
// "mirror the table, narrowed to the columns actually used" convention.
type RetrySettingsRow struct {
	MerchantEntityID      string
	DunningLadderHours    []int
	MaxAttemptsPerPayment int
	MinSpacingSeconds     int
	UpdatedAt             time.Time
}

// UpsertRetrySettingsInput is the input to
// RetrySettingsStore.UpsertRetrySettings — every column the
// INSERT ... ON CONFLICT DO UPDATE needs, computed and validated by the
// handler before the store is ever called, matching
// CreateCheckoutSessionRow's own "handler resolves/validates
// everything, store just persists it" division of labor.
type UpsertRetrySettingsInput struct {
	DunningLadderHours    []int
	MaxAttemptsPerPayment int
	MinSpacingSeconds     int
}

// RetrySettingsStore is the minimal persistence capability the
// retry-settings routes need — a separate, narrow interface (this
// codebase's standing convention: see PaymentsStore/CustomersStore/
// CheckoutSessionsStore each being their own interface) rather than
// folded into PaymentsStore, since retry settings are their own
// resource with their own lifecycle (absent-by-default, then a
// singleton row per merchant entity once first configured), not a
// payments-table concern. GetRetrySettings's second return value is
// false — with no error — when no row exists yet for this merchant
// entity; this is the expected, common case for a merchant that has
// never called PUT, not an error condition.
type RetrySettingsStore interface {
	GetRetrySettings(ctx context.Context, merchantEntityID string) (RetrySettingsRow, bool, error)
	UpsertRetrySettings(ctx context.Context, merchantEntityID string, input UpsertRetrySettingsInput) (RetrySettingsRow, error)
}

// RetrySettingsRouteDeps is everything the two retry-settings handlers
// need.
type RetrySettingsRouteDeps struct {
	Store RetrySettingsStore
}

// DefaultDunningLadderHours/DefaultMaxAttemptsPerPayment/
// DefaultMinSpacingSeconds are this resource's hardcoded fallback
// values — kept as their own named constants/var here (rather than
// importing internal/subscriptions/internal/routing just for their
// defaults, which would be an odd dependency direction for this
// package to take on) so handleGetRetrySettings has something to
// return for a merchant entity with no row yet. These are the EXACT
// SAME numbers as routing.DefaultRetryPolicy/
// subscriptions.DunningLadderHours's own defaults today — see this
// file's own doc comment and MIGRATION_NOTES.md for why keeping the
// two sets of numbers in sync (rather than, say, having one import the
// other) is an accepted, explicitly-flagged duplication rather than an
// oversight: internal/api intentionally does not import
// internal/routing or internal/subscriptions today (this package is a
// dependency of neither, and adding that edge just to share three
// integer literals was judged not worth the new coupling).
var DefaultDunningLadderHours = []int{24, 72, 168}

const (
	DefaultMaxAttemptsPerPayment = 3
	DefaultMinSpacingSeconds     = 2
)

// RetrySettingsDTO mirrors the retry_settings table's wire shape in
// camelCase JSON — the shape both GET and PUT /v1/retry-settings
// respond with.
type RetrySettingsDTO struct {
	DunningLadderHours    []int  `json:"dunningLadderHours"`
	MaxAttemptsPerPayment int    `json:"maxAttemptsPerPayment"`
	MinSpacingSeconds     int    `json:"minSpacingSeconds"`
	UpdatedAt             string `json:"updatedAt"`
}

// UpsertRetrySettingsRequest mirrors PUT /v1/retry-settings's request
// body — the same three configurable columns, no merchantEntityId (that
// comes from the Bearer auth context, exactly like every other /v1/*
// route scopes writes by auth.MerchantEntityID rather than trusting a
// client-supplied id).
type UpsertRetrySettingsRequest struct {
	DunningLadderHours    []int `json:"dunningLadderHours"`
	MaxAttemptsPerPayment int   `json:"maxAttemptsPerPayment"`
	MinSpacingSeconds     int   `json:"minSpacingSeconds"`
}

// registerRetrySettingsRoutes registers GET and PUT /v1/retry-settings.
// Called from inside router.go's r.Route("/v1", ...) block, alongside
// registerPaymentsRoutes/registerCustomersRoutes/
// registerCheckoutSessionsRoutes, so both routes go through
// authMW.Middleware exactly like every other /v1/* route — retry
// policy is exactly as sensitive a piece of merchant configuration as
// anything else already living under /v1, so there is no reason for
// either route to be unauthenticated the way the checkout-sessions
// browser-facing routes are.
func registerRetrySettingsRoutes(r chi.Router, deps RetrySettingsRouteDeps) {
	r.Get("/retry-settings", handleGetRetrySettings(deps))
	r.Put("/retry-settings", handleUpsertRetrySettings(deps))
}

func serializeRetrySettings(row RetrySettingsRow) RetrySettingsDTO {
	return RetrySettingsDTO{
		DunningLadderHours:    row.DunningLadderHours,
		MaxAttemptsPerPayment: row.MaxAttemptsPerPayment,
		MinSpacingSeconds:     row.MinSpacingSeconds,
		UpdatedAt:             row.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
}

// handleGetRetrySettings implements GET /v1/retry-settings —
// Bearer-authenticated, scoped to auth.MerchantEntityID. If no row
// exists yet for this merchant entity (the common case for a merchant
// that has never called PUT), responds 200 with the hardcoded defaults
// (DefaultDunningLadderHours/DefaultMaxAttemptsPerPayment/
// DefaultMinSpacingSeconds) and an UpdatedAt of the zero time formatted
// the same way any other timestamp is — deliberately does NOT insert a
// row just because it was read; see this file's own top doc comment for
// why "create on first PUT, default on GET until then" was chosen over
// a create-on-first-read pattern.
func handleGetRetrySettings(deps RetrySettingsRouteDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth, ok := authFromContext(r.Context())
		if !ok {
			WriteProblem(w, http.StatusUnauthorized, "Missing or invalid API token", "")
			return
		}

		if deps.Store == nil {
			writeJSON(w, http.StatusOK, RetrySettingsDTO{
				DunningLadderHours:    DefaultDunningLadderHours,
				MaxAttemptsPerPayment: DefaultMaxAttemptsPerPayment,
				MinSpacingSeconds:     DefaultMinSpacingSeconds,
				UpdatedAt:             time.Time{}.UTC().Format(time.RFC3339Nano),
			})
			return
		}

		row, found, err := deps.Store.GetRetrySettings(r.Context(), auth.MerchantEntityID)
		if err != nil {
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}
		if !found {
			writeJSON(w, http.StatusOK, RetrySettingsDTO{
				DunningLadderHours:    DefaultDunningLadderHours,
				MaxAttemptsPerPayment: DefaultMaxAttemptsPerPayment,
				MinSpacingSeconds:     DefaultMinSpacingSeconds,
				UpdatedAt:             time.Time{}.UTC().Format(time.RFC3339Nano),
			})
			return
		}

		writeJSON(w, http.StatusOK, serializeRetrySettings(row))
	}
}

// validateRetrySettingsInput enforces this resource's validation
// contract, exactly as specified in the task brief:
//   - dunningLadderHours: 1-10 entries, every entry >= 0, and the
//     sequence must be strictly non-decreasing ("ascending or at least
//     non-negative" per the brief — this port interprets that as
//     requiring both: every step non-negative AND the ladder
//     non-decreasing step-to-step, since a dunning ladder whose delays
//     go backwards partway through would be a nonsensical retry
//     schedule and is exactly the class of misconfiguration validation
//     here should catch).
//   - maxAttemptsPerPayment >= 1 (a payment that can never be attempted
//     even once is not a meaningful "retry" policy at all).
//   - minSpacingSeconds >= 0.
func validateRetrySettingsInput(body UpsertRetrySettingsRequest) error {
	n := len(body.DunningLadderHours)
	if n < 1 || n > 10 {
		return fmt.Errorf("dunningLadderHours: must have between 1 and 10 entries, got %d", n)
	}
	prev := -1
	for i, h := range body.DunningLadderHours {
		if h < 0 {
			return fmt.Errorf("dunningLadderHours[%d]: must be >= 0, got %d", i, h)
		}
		if h < prev {
			return fmt.Errorf("dunningLadderHours[%d]: must be ascending (non-decreasing) — %d comes after %d", i, h, prev)
		}
		prev = h
	}
	if body.MaxAttemptsPerPayment < 1 {
		return fmt.Errorf("maxAttemptsPerPayment: must be >= 1, got %d", body.MaxAttemptsPerPayment)
	}
	if body.MinSpacingSeconds < 0 {
		return fmt.Errorf("minSpacingSeconds: must be >= 0, got %d", body.MinSpacingSeconds)
	}
	return nil
}

// handleUpsertRetrySettings implements PUT /v1/retry-settings —
// Bearer-authenticated, scoped to auth.MerchantEntityID. Validates the
// request body (see validateRetrySettingsInput), then upserts —
// creating the merchant entity's retry_settings row on its first call,
// updating it on every subsequent one (PgxPaymentsStore.
// UpsertRetrySettings's INSERT ... ON CONFLICT DO UPDATE handles both
// cases identically from this handler's point of view).
func handleUpsertRetrySettings(deps RetrySettingsRouteDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth, ok := authFromContext(r.Context())
		if !ok {
			WriteProblem(w, http.StatusUnauthorized, "Missing or invalid API token", "")
			return
		}

		var body UpsertRetrySettingsRequest
		if !decodeJSONBody(w, r, &body) {
			return
		}

		if err := validateRetrySettingsInput(body); err != nil {
			WriteProblem(w, http.StatusBadRequest, "Validation failed", err.Error())
			return
		}

		if deps.Store == nil {
			WriteProblem(w, http.StatusNotImplemented, "Not implemented", ErrNotImplemented.Error())
			return
		}

		row, err := deps.Store.UpsertRetrySettings(r.Context(), auth.MerchantEntityID, UpsertRetrySettingsInput{
			DunningLadderHours:    body.DunningLadderHours,
			MaxAttemptsPerPayment: body.MaxAttemptsPerPayment,
			MinSpacingSeconds:     body.MinSpacingSeconds,
		})
		if err != nil {
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}

		writeJSON(w, http.StatusOK, serializeRetrySettings(row))
	}
}
