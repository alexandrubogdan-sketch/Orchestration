package api

import (
	"context"
	"io"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/alphapayments/payment-orchestrator/internal/webhooks"
)

// This file is the HTTP transport layer for POST /webhooks/{psp} — the
// Go port of src/webhooks/route.ts's Fastify route registration.
// internal/webhooks/inbox.go's Ingest carries the actual ingress logic
// (signature-verification loop, dedup insert); this file only handles
// the HTTP framing (reading the raw body, mapping IngestResult to a
// status code, triggering Normalize in a background goroutine) — kept
// deliberately thin so Ingest itself stays unit-testable without a
// live chi router, mirroring this port's standing preference for
// business logic living outside the transport layer wherever
// practical (payments.go/customers.go's own handler-vs-store split).
//
// RAW BODY HANDLING: route.ts overrides Fastify's application/json
// content-type parser to hand back the raw, unparsed Buffer, because
// every adapter's VerifyWebhook needs the EXACT bytes the PSP signed —
// re-serializing a parsed JSON object would almost certainly produce a
// byte-different string and fail verification. Go's net/http never
// parses the body at all unless a handler explicitly decodes it, so
// there is no equivalent override needed here — io.ReadAll(r.Body)
// already gives this handler the raw, unmodified bytes, which is
// exactly the Go-idiomatic equivalent of what route.ts's content-type
// parser override achieves.
//
// WEBHOOK ROUTES MUST NOT GO THROUGH THE /v1 AUTH MIDDLEWARE GROUP —
// see router.go's RegisterWebhookRoutes doc comment for where and why.

// WebhookDeps is everything the webhook HTTP handler needs.
type WebhookDeps struct {
	Webhooks webhooks.Deps
	Logger   *slog.Logger
}

// registerWebhookRoutes registers POST /webhooks/{psp} on r. Called by
// router.go's RegisterWebhookRoutes, which mounts r OUTSIDE the /v1
// chi.Router group — see that function's doc comment.
func registerWebhookRoutes(r chi.Router, deps WebhookDeps) {
	r.Post("/webhooks/{psp}", handleWebhook(deps))
}

func handleWebhook(deps WebhookDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		psp := chi.URLParam(r, "psp")

		rawBody, err := io.ReadAll(r.Body)
		if err != nil {
			WriteProblem(w, http.StatusBadRequest, "Failed to read request body", "")
			return
		}
		defer r.Body.Close()

		result, err := webhooks.Ingest(r.Context(), deps.Webhooks, psp, rawBody, r.Header)
		if err != nil {
			if deps.Logger != nil {
				deps.Logger.Error("webhook ingest failed", "psp", psp, "error", err)
			}
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}

		if !result.Verified {
			if deps.Logger != nil {
				deps.Logger.Warn("webhook signature verification failed against every candidate account", "psp", psp)
			}
			WriteProblem(w, http.StatusBadRequest, "Invalid webhook signature", "")
			return
		}

		// Fire-and-forget dispatch of Normalize, matching route.ts's
		// `.dispatch('webhook.normalize', ...).catch(...)` — deliberately
		// using context.Background(), NOT r.Context(), so this goroutine
		// is never canceled just because the HTTP response has already
		// been written and the request's context torn down. A dispatch
		// failure here must never turn into a slow/failed ack — the ack
		// below happens unconditionally, regardless of what this
		// goroutine does. See internal/webhooks's package doc comment for
		// the fuller framing of why this is a goroutine and not a real
		// queue dispatch (no Hatchet-equivalent worker exists in this Go
		// port yet).
		if result.Inserted {
			inboxID := result.InboxID
			logger := deps.Logger
			whDeps := deps.Webhooks
			go func() {
				if err := webhooks.Normalize(context.Background(), whDeps, inboxID); err != nil && logger != nil {
					logger.Error("webhook.normalize failed — will be picked up by gap-detection or a manual replay",
						"inbox_id", inboxID, "psp", psp, "error", err)
				}
			}()
		}
		// else: duplicate delivery — ack without re-dispatching.

		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	}
}
