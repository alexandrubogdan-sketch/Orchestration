package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
)

// Covers the branches of handleReplayWebhook that don't require a live
// Postgres (auth, write-scope, nil-Pool 501) — matching this package's
// established convention of testing DB-touching handlers (payments.go,
// customers.go, subscriptions.go) only at the branches reachable
// without a real pool, since none of those siblings have their own
// _test.go either; live-DB coverage for this route belongs in a
// higher-level integration/e2e suite, not here.

func newReplayRequest(auth *AuthContext, inboxID string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/v1/webhooks/"+inboxID+"/replay", nil)
	if auth != nil {
		req = withTestAuth(req, *auth)
	}
	return req
}

func TestReplayWebhook_NoAuth_Returns401(t *testing.T) {
	r := chi.NewRouter()
	registerWebhookReplayRoutes(r, WebhookReplayRouteDeps{})

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, newReplayRequest(nil, "inbox_1"))

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestReplayWebhook_ReadOnlyScope_Returns403(t *testing.T) {
	r := chi.NewRouter()
	registerWebhookReplayRoutes(r, WebhookReplayRouteDeps{})

	auth := testAuthContext()
	auth.Scope = "read_only"
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, newReplayRequest(&auth, "inbox_1"))

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
}

func TestReplayWebhook_NilPool_Returns501(t *testing.T) {
	r := chi.NewRouter()
	registerWebhookReplayRoutes(r, WebhookReplayRouteDeps{})

	auth := testAuthContext()
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, newReplayRequest(&auth, "inbox_1"))

	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("status = %d, want 501", rec.Code)
	}
}
