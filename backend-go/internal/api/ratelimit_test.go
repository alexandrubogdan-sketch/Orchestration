package api

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// fakePublicRateLimiterStore is an in-memory PublicRateLimiterStore —
// enough to drive rateLimitPublicCheckoutRoute's counting and
// fail-open branches without a live Redis. Safe for concurrent use
// since a real Redis-backed store would be shared across goroutines
// too.
type fakePublicRateLimiterStore struct {
	mu        sync.Mutex
	counts    map[string]int64
	incrErr   error
	expireErr error
}

func newFakePublicRateLimiterStore() *fakePublicRateLimiterStore {
	return &fakePublicRateLimiterStore{counts: map[string]int64{}}
}

func (s *fakePublicRateLimiterStore) Incr(_ context.Context, key string) (int64, error) {
	if s.incrErr != nil {
		return 0, s.incrErr
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.counts[key]++
	return s.counts[key], nil
}

func (s *fakePublicRateLimiterStore) Expire(_ context.Context, _ string, _ time.Duration) error {
	return s.expireErr
}

func testRateLimitConfig() PublicCheckoutRateLimitConfig {
	return PublicCheckoutRateLimitConfig{RequestsPerWindow: 2, Window: time.Minute}
}

func okHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}
}

// Regression test for the backend review's confirmed gap (2026-07-10):
// GET /checkout/{id}/public and POST /checkout/{id}/confirm had no
// rate limiting at all — see ratelimit.go's top doc comment for the
// card-testing attack this closes. Verifies requests within the
// configured window pass through untouched.
func TestRateLimitPublicCheckoutRoute_AllowsWithinLimit(t *testing.T) {
	store := newFakePublicRateLimiterStore()
	handler := rateLimitPublicCheckoutRoute(store, testRateLimitConfig(), "get-public", okHandler())

	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodGet, "/checkout/sess_1/public", nil)
		req.RemoteAddr = "203.0.113.1:12345"
		rec := httptest.NewRecorder()
		handler(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("request %d: status = %d, want %d", i+1, rec.Code, http.StatusOK)
		}
	}
}

func TestRateLimitPublicCheckoutRoute_BlocksOverLimit(t *testing.T) {
	store := newFakePublicRateLimiterStore()
	handler := rateLimitPublicCheckoutRoute(store, testRateLimitConfig(), "post-confirm", okHandler())

	newReq := func() *http.Request {
		req := httptest.NewRequest(http.MethodPost, "/checkout/sess_1/confirm", nil)
		req.RemoteAddr = "203.0.113.1:12345"
		return req
	}

	for i := 0; i < 2; i++ {
		rec := httptest.NewRecorder()
		handler(rec, newReq())
		if rec.Code != http.StatusOK {
			t.Fatalf("request %d: status = %d, want %d", i+1, rec.Code, http.StatusOK)
		}
	}

	rec := httptest.NewRecorder()
	handler(rec, newReq())
	if rec.Code != http.StatusTooManyRequests {
		t.Errorf("3rd request: status = %d, want %d", rec.Code, http.StatusTooManyRequests)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Error("expected Retry-After header on a 429 response")
	}
}

// Two different client IPs must not share a bucket — otherwise one
// noisy neighbor could exhaust the budget for every other customer
// completing checkout at the same time.
func TestRateLimitPublicCheckoutRoute_SeparatesByClientIP(t *testing.T) {
	store := newFakePublicRateLimiterStore()
	handler := rateLimitPublicCheckoutRoute(store, testRateLimitConfig(), "get-public", okHandler())

	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodGet, "/checkout/sess_1/public", nil)
		req.RemoteAddr = "203.0.113.1:12345"
		rec := httptest.NewRecorder()
		handler(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("client A request %d: status = %d, want %d", i+1, rec.Code, http.StatusOK)
		}
	}

	req := httptest.NewRequest(http.MethodGet, "/checkout/sess_1/public", nil)
	req.RemoteAddr = "198.51.100.7:54321"
	rec := httptest.NewRecorder()
	handler(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("a different client IP was blocked by client A's bucket: status = %d, want %d", rec.Code, http.StatusOK)
	}
}

// A Redis error must fail OPEN — an outage in the rate-limit store
// must never take down checkout entirely for every legitimate
// customer (see rateLimitPublicCheckoutRoute's own doc comment on
// this codebase's fail-open-for-safety-nets philosophy).
func TestRateLimitPublicCheckoutRoute_FailsOpenOnStoreError(t *testing.T) {
	store := newFakePublicRateLimiterStore()
	store.incrErr = errors.New("dial tcp: connection refused")
	handler := rateLimitPublicCheckoutRoute(store, testRateLimitConfig(), "get-public", okHandler())

	req := httptest.NewRequest(http.MethodGet, "/checkout/sess_1/public", nil)
	req.RemoteAddr = "203.0.113.1:12345"
	rec := httptest.NewRecorder()
	handler(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d (a store error must fail open)", rec.Code, http.StatusOK)
	}
}

// A nil store means no Redis-backed limiter is wired at all (see
// CheckoutRateLimiter's own doc comment in router.go for when this can
// legitimately happen) — the route must still work, just unbounded.
func TestRateLimitPublicCheckoutRoute_NilStoreRunsUnwrapped(t *testing.T) {
	handler := rateLimitPublicCheckoutRoute(nil, testRateLimitConfig(), "get-public", okHandler())

	req := httptest.NewRequest(http.MethodGet, "/checkout/sess_1/public", nil)
	rec := httptest.NewRecorder()
	handler(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}
}

// A zero-valued config (e.g. an unconfigured Deps.CheckoutRateLimitConfig)
// must fall back to DefaultPublicCheckoutRateLimitConfig rather than
// rate-limiting every request down to zero (RequestsPerWindow: 0).
func TestRateLimitPublicCheckoutRoute_ZeroConfigFallsBackToDefault(t *testing.T) {
	store := newFakePublicRateLimiterStore()
	handler := rateLimitPublicCheckoutRoute(store, PublicCheckoutRateLimitConfig{}, "get-public", okHandler())

	req := httptest.NewRequest(http.MethodGet, "/checkout/sess_1/public", nil)
	req.RemoteAddr = "203.0.113.1:12345"
	rec := httptest.NewRecorder()
	handler(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d (zero-value config should fall back to defaults, not block everything)", rec.Code, http.StatusOK)
	}
}

func TestClientIPForRateLimit_PrefersFirstForwardedForEntry(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/checkout/sess_1/public", nil)
	req.Header.Set("X-Forwarded-For", "198.51.100.9, 10.0.0.1, 10.0.0.2")
	req.RemoteAddr = "10.0.0.2:9999"

	if got := clientIPForRateLimit(req); got != "198.51.100.9" {
		t.Errorf("clientIPForRateLimit = %q, want %q", got, "198.51.100.9")
	}
}

func TestClientIPForRateLimit_FallsBackToRemoteAddr(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/checkout/sess_1/public", nil)
	req.RemoteAddr = "203.0.113.1:12345"

	if got := clientIPForRateLimit(req); got != "203.0.113.1" {
		t.Errorf("clientIPForRateLimit = %q, want %q", got, "203.0.113.1")
	}
}
