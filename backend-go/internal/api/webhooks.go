package api

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"sync"

	"github.com/go-chi/chi/v5"

	"github.com/alphapayments/payment-orchestrator/internal/webhooks"
)

// maxWebhookBodyBytes bounds how much of a POST /webhooks/{psp} request
// body this handler will ever read into memory. This route sits
// OUTSIDE the /v1 Bearer-auth group by design (a PSP webhook has no API
// token to send — see this file's own top doc comment and router.go's
// RegisterWebhookRoutes), which makes it the one HTTP endpoint in this
// codebase reachable by a fully unauthenticated caller before any
// signature has been checked. io.ReadAll(r.Body) with no limit lets
// that caller hand this process an arbitrarily large body — gigabytes,
// if they want — and have it all buffered into a single []byte before
// VerifyWebhook ever gets a chance to reject it, a textbook memory-
// exhaustion DoS against a public route. 5 MiB is generously above any
// real Stripe/Solidgate/PayPal webhook payload (documented PSP webhook
// bodies run from a few KB up to, at most, low hundreds of KB), leaving
// headroom without leaving the limit effectively unbounded.
const maxWebhookBodyBytes = 5 << 20 // 5 MiB

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
	// InFlight tracks every in-progress background Normalize goroutine
	// this handler starts (see handleWebhook's dispatch comment below),
	// so cmd/api/main.go's graceful shutdown can wait for them to drain
	// — bounded by its own timeout — instead of the process exiting out
	// from under them mid-normalize. Optional: nil is treated the same
	// as "don't track" (every call is nil-checked before use), so
	// existing tests that build a WebhookDeps without one keep working
	// unchanged.
	InFlight *sync.WaitGroup
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

		// BUG FIX (backend review, 2026-07-10): r.Body was previously read
		// via a bare io.ReadAll with no size limit — see maxWebhookBodyBytes'
		// doc comment for why that is a real memory-exhaustion DoS against
		// this specifically unauthenticated route. http.MaxBytesReader
		// enforces the limit AND closes the underlying body for us once
		// the limit is exceeded, matching net/http's own documented usage
		// pattern (it also arranges for the connection to be closed rather
		// than drained, since a caller sending an oversized body is not
		// worth the cost of reading and discarding the rest of it).
		r.Body = http.MaxBytesReader(w, r.Body, maxWebhookBodyBytes)
		rawBody, err := io.ReadAll(r.Body)
		if err != nil {
			var maxBytesErr *http.MaxBytesError
			if errors.As(err, &maxBytesErr) {
				WriteProblem(w, http.StatusRequestEntityTooLarge, "Request body too large", "")
				return
			}
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
			// BUG FIX (backend review, 2026-07-10): this goroutine is
			// deliberately detached from the request (context.Background(),
			// not r.Context() — see the comment above), which also means
			// it was previously invisible to cmd/api/main.go's graceful
			// shutdown: server.Shutdown(ctx) only waits for in-flight HTTP
			// handlers to return, and this handler had already returned by
			// the time this goroutine finishes. A SIGTERM during a deploy
			// could kill the process mid-Normalize with no signal at all —
			// the row would sit un-normalized until gap-detection's cron
			// eventually caught it (correct end-state, but a needless delay
			// on every routine deploy, not just a crash). deps.InFlight (a
			// *sync.WaitGroup owned by main.go) now tracks this goroutine so
			// shutdown can wait for it — bounded by main.go's own timeout,
			// so one genuinely stuck Normalize call still can't block
			// shutdown forever.
			if deps.InFlight != nil {
				deps.InFlight.Add(1)
			}
			go func() {
				if deps.InFlight != nil {
					defer deps.InFlight.Done()
				}
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
