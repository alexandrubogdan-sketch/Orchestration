package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

// Covers the one branch of handleWebhook (webhooks.go) reachable
// without a live Postgres: the request-body size limit. Every other
// branch of this handler calls webhooks.Ingest, which does real DB
// dedup inserts against webhook_inbox — untestable here without a live
// Postgres, matching this package's established convention (see
// subscriptions.go/payments.go's own lack of live-DB handler tests).
// This is exactly the branch that matters most to verify in isolation
// anyway: maxWebhookBodyBytes exists specifically to reject an
// oversized body BEFORE any signature verification or DB call ever
// happens (see maxWebhookBodyBytes' own doc comment on the memory-
// exhaustion DoS this closes) — this test confirms that rejection
// actually happens ahead of webhooks.Ingest, not that Ingest itself
// behaves correctly once reached.

func TestHandleWebhook_BodyTooLarge_Returns413(t *testing.T) {
	r := chi.NewRouter()
	registerWebhookRoutes(r, WebhookDeps{})

	oversizedBody := strings.NewReader(strings.Repeat("a", maxWebhookBodyBytes+1))
	req := httptest.NewRequest(http.MethodPost, "/webhooks/stripe", oversizedBody)
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusRequestEntityTooLarge)
	}
}

// NOTE: a second test asserting a body exactly AT maxWebhookBodyBytes
// is NOT rejected for size was deliberately left out — proving that
// would require letting the request continue past the size check into
// webhooks.Ingest, which dereferences deps.Webhooks.Pool/Registry
// directly with no nil-guard (unlike this package's own HTTP handlers,
// which each check their Pool/Store for nil before use — see e.g.
// subscriptions.go's handlers). Calling it here with a zero-valued
// WebhookDeps{} would panic the test process on a nil pointer, not
// fail cleanly, so this specific boundary is left to a live-Postgres
// integration test rather than asserted unsafely here.
