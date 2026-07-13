package api

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/alphapayments/payment-orchestrator/internal/adapters"
	"github.com/alphapayments/payment-orchestrator/internal/adapters/registry"
)

// This file adds POST /v1/customers/{id}/billing-portal-session (Stripe
// integration audit, 2026-07-12, Task #318) — the minimal backend half
// of a Stripe Billing Portal integration: given a customer who already
// has a Stripe-side customer reference on file (customer_psp_refs — see
// 1735776100000_core-schema.up.sql's own doc comment on that table),
// creates a one-time hosted portal session and returns its URL for the
// caller to redirect the end customer to.
//
// WHY THIS IS "MINIMAL": a full Billing Portal integration also
// involves configuring which self-service actions the portal exposes
// (cancel, swap payment method, view invoice history, etc.) in the
// Stripe Dashboard, and this codebase's own subscriptions/invoices are
// NOT Stripe Subscriptions/Invoices (see internal/subscriptions'
// package-top doc comment) — so a customer canceling via Stripe's
// portal would cancel a Stripe-side construct this backend doesn't
// actually track as the source of truth for billing. This route is
// therefore most useful today for the one thing that IS fully
// Stripe-native regardless: letting a customer update their saved
// payment method through Stripe's own hosted UI. Wiring the portal's
// cancel/pause actions back into THIS codebase's subscriptions table
// (e.g. via a Stripe webhook reacting to a portal-driven cancellation)
// is explicitly out of scope for this pass.
//
// SCOPING: uses adapters.BillingPortalProvider — see that interface's
// own doc comment in internal/adapters/types.go for why this is an
// optional, type-asserted capability rather than part of PspAdapter
// itself.

// BillingPortalRouteDeps is everything this file's one handler needs.
type BillingPortalRouteDeps struct {
	Pool     *pgxpool.Pool
	Registry *registry.Registry
}

func registerBillingPortalRoutes(r chi.Router, deps BillingPortalRouteDeps) {
	r.Post("/customers/{id}/billing-portal-session", handleCreateBillingPortalSession(deps))
}

type createBillingPortalSessionRequest struct {
	ReturnURL string `json:"returnUrl"`
}

type billingPortalSessionResponse struct {
	URL string `json:"url"`
}

func handleCreateBillingPortalSession(deps BillingPortalRouteDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth, ok := authFromContext(r.Context())
		if !ok {
			WriteProblem(w, http.StatusUnauthorized, "Missing or invalid API token", "")
			return
		}
		// A billing portal session lets the END CUSTOMER self-serve
		// changes (at minimum, their saved payment method) on Stripe's
		// own hosted page — treated as a write-scope action for the same
		// reason cancel/refund/void are, even though nothing in THIS
		// backend's own database is mutated by creating the session
		// itself.
		if !RequireWriteScope(w, auth) {
			return
		}
		if deps.Pool == nil || deps.Registry == nil {
			WriteProblem(w, http.StatusNotImplemented, "Not implemented", ErrNotImplemented.Error())
			return
		}
		customerID := chi.URLParam(r, "id")

		var body createBillingPortalSessionRequest
		if !decodeJSONBody(w, r, &body) {
			return
		}
		if body.ReturnURL == "" {
			WriteProblem(w, http.StatusBadRequest, "returnUrl is required", "")
			return
		}

		var customerMerchantEntityID string
		err := deps.Pool.QueryRow(r.Context(),
			`SELECT merchant_entity_id FROM customers WHERE id = $1`, customerID,
		).Scan(&customerMerchantEntityID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				WriteProblem(w, http.StatusNotFound, "Customer not found", "")
				return
			}
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}
		if customerMerchantEntityID != auth.MerchantEntityID {
			WriteProblem(w, http.StatusNotFound, "Customer not found", "")
			return
		}

		var pspAccount struct {
			ID        string
			Mode      string
			SecretRef string
		}
		var pspCustomerRef string
		err = deps.Pool.QueryRow(r.Context(),
			`SELECT pa.id, pa.mode, pa.secret_ref, cpr.psp_customer_ref
			 FROM customer_psp_refs cpr
			 JOIN psp_accounts pa ON pa.id = cpr.psp_account_id
			 WHERE cpr.customer_id = $1 AND pa.psp = 'stripe' AND pa.merchant_entity_id = $2
			 LIMIT 1`,
			customerID, auth.MerchantEntityID,
		).Scan(&pspAccount.ID, &pspAccount.Mode, &pspAccount.SecretRef, &pspCustomerRef)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				WriteProblem(w, http.StatusNotFound, "Customer has no Stripe customer reference on file", "")
				return
			}
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}

		adapter, err := deps.Registry.Resolve(registry.PspAccount{
			ID: pspAccount.ID, PSP: "stripe", Mode: pspAccount.Mode, SecretRef: pspAccount.SecretRef,
		})
		if err != nil {
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}
		portalProvider, ok := adapter.(adapters.BillingPortalProvider)
		if !ok {
			WriteProblem(w, http.StatusNotImplemented, "Billing portal is not supported for this PSP account", "")
			return
		}

		url, err := portalProvider.CreateBillingPortalSession(r.Context(), pspCustomerRef, body.ReturnURL)
		if err != nil {
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}

		writeJSON(w, http.StatusCreated, billingPortalSessionResponse{URL: url})
	}
}
