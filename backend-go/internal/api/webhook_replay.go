package api

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/alphapayments/payment-orchestrator/internal/webhooks"
)

// This file adds POST /v1/webhooks/{inboxId}/replay — the second half
// of Task #312 (Stripe integration audit, 2026-07-12, High-severity
// finding: "a webhook_inbox row stuck at 'failed' or 'dlq' has no
// backstop other than gap-detection's independent PSP-state polling,
// which fixes the PAYMENT's state but never clears the stuck inbox row
// itself or gives an operator a way to force a re-normalize after
// they've fixed whatever caused the failure (a bad adapter deploy, a
// missing psp_account credential, a transient DB outage, etc.)").
//
// Deliberately runs webhooks.Normalize SYNCHRONOUSLY, unlike the public
// POST /webhooks/{psp} route's fire-and-forget goroutine dispatch (see
// webhooks.go's handleWebhook doc comment for why that route can't
// block on it) — this route's caller is an authenticated operator (or
// an MCP agent token) explicitly asking "did the replay work," not a
// PSP waiting on a fast ack, so returning the real outcome (success,
// still-failing, or now-DLQ'd) in the HTTP response is far more useful
// than another "we accepted this" 200 the caller has to go re-check via
// some other route.
//
// SCOPING: webhook_inbox has no merchant_entity_id column of its own
// (see db/migrations/1735776100000_core-schema.up.sql) — it only gets a
// psp_account_id once Ingest resolves which psp_account's signature
// verified (1735776300000_webhook-inbox-psp-account.up.sql), and
// psp_accounts.merchant_entity_id is what every other route in this
// package scopes writes by. A row with psp_account_id still NULL (the
// "no psp_account_id at all" failure mode normalize.go's Normalize
// marks 'failed' before ever resolving one) has no merchant to scope
// against and is therefore reported as not replayable here rather than
// silently allowing any authenticated caller to touch it.
//
// ATTEMPT-COUNTER RESET: a manual replay resets attempts to 0 (not left
// at whatever it was when the row hit 'dlq'/'failed') — the whole point
// of an operator reaching for this route is that they believe they've
// fixed the underlying cause, so the row should get a full fresh
// MaxWebhookAttempts budget rather than immediately re-entering the DLQ
// ladder one failure later. See retry.go's MaxWebhookAttempts.

// WebhookReplayRouteDeps is everything handleReplayWebhook needs.
type WebhookReplayRouteDeps struct {
	Pool     *pgxpool.Pool
	Webhooks webhooks.Deps
	Logger   *slog.Logger
}

func registerWebhookReplayRoutes(r chi.Router, deps WebhookReplayRouteDeps) {
	r.Post("/webhooks/{inboxId}/replay", handleReplayWebhook(deps))
}

type webhookReplayResponse struct {
	ID       string `json:"id"`
	Status   string `json:"status"`
	Attempts int    `json:"attempts"`
	Replayed bool   `json:"replayed"`
	Error    string `json:"error,omitempty"`
}

func handleReplayWebhook(deps WebhookReplayRouteDeps) http.HandlerFunc {
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
		inboxID := chi.URLParam(r, "inboxId")

		var status string
		var attempts int
		var merchantEntityID *string
		err := deps.Pool.QueryRow(r.Context(),
			`SELECT wi.status, wi.attempts, pa.merchant_entity_id
			 FROM webhook_inbox wi
			 LEFT JOIN psp_accounts pa ON pa.id = wi.psp_account_id
			 WHERE wi.id = $1`,
			inboxID,
		).Scan(&status, &attempts, &merchantEntityID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				WriteProblem(w, http.StatusNotFound, "Webhook inbox row not found", "")
				return
			}
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}

		// No psp_account resolved at all — see this file's top doc
		// comment on why there is nothing to scope this replay against.
		if merchantEntityID == nil {
			WriteProblem(w, http.StatusConflict, "Webhook inbox row cannot be replayed",
				"this row has no resolved psp_account and was never scoped to a merchant; it cannot be safely replayed via this route")
			return
		}
		if *merchantEntityID != auth.MerchantEntityID {
			// Same not-found response an out-of-tenant caller gets on
			// every other resource in this package — existence of another
			// merchant's row is not information to leak.
			WriteProblem(w, http.StatusNotFound, "Webhook inbox row not found", "")
			return
		}

		if status == "processed" {
			WriteProblem(w, http.StatusConflict, "Webhook inbox row already processed", "")
			return
		}
		if status == "processing" {
			WriteProblem(w, http.StatusConflict, "Webhook inbox row is currently processing", "")
			return
		}

		// Reset to 'pending' with a fresh attempts budget (see this
		// file's top doc comment) before re-invoking Normalize — Normalize
		// itself no-ops on anything other than status='pending' (its own
		// redelivery-dedup guard), so this reset is required, not
		// cosmetic.
		_, err = deps.Pool.Exec(r.Context(),
			`UPDATE webhook_inbox SET status = 'pending', attempts = 0, processed_at = NULL WHERE id = $1`,
			inboxID,
		)
		if err != nil {
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}

		normalizeErr := webhooks.Normalize(r.Context(), deps.Webhooks, inboxID)

		var finalStatus string
		var finalAttempts int
		if scanErr := deps.Pool.QueryRow(r.Context(),
			`SELECT status, attempts FROM webhook_inbox WHERE id = $1`, inboxID,
		).Scan(&finalStatus, &finalAttempts); scanErr != nil {
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}

		resp := webhookReplayResponse{
			ID:       inboxID,
			Status:   finalStatus,
			Attempts: finalAttempts,
			Replayed: normalizeErr == nil,
		}
		if normalizeErr != nil {
			resp.Error = normalizeErr.Error()
			if deps.Logger != nil {
				deps.Logger.Error("manual webhook replay did not complete cleanly",
					"inbox_id", inboxID, "error", normalizeErr)
			}
		}

		writeJSON(w, http.StatusOK, resp)
	}
}
