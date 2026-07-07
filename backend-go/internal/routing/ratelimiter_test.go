package routing

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// fakeRateLimiterStore is an in-memory RateLimiterStore -- the direct
// Go analogue of rateLimiter.test.ts's FakeRateLimiterStore.
type fakeRateLimiterStore struct {
	mu       sync.Mutex
	counters map[string]int64
}

func newFakeRateLimiterStore() *fakeRateLimiterStore {
	return &fakeRateLimiterStore{counters: make(map[string]int64)}
}

func (f *fakeRateLimiterStore) Incr(ctx context.Context, key string) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.counters[key]++
	return f.counters[key], nil
}

func (f *fakeRateLimiterStore) Expire(ctx context.Context, key string, ttl time.Duration) error {
	return nil
}

func TestOutboundRateLimiter_AllowsRequestsUnderTheConfiguredLimit(t *testing.T) {
	limiter := newRateLimiterWithStore(newFakeRateLimiterStore(), RateLimiterConfig{RequestsPerSecond: 5})
	for i := 0; i < 5; i++ {
		if err := limiter.CheckAndConsume(context.Background(), "psp-1"); err != nil {
			t.Fatalf("request %d: unexpected error: %v", i, err)
		}
	}
}

func TestOutboundRateLimiter_ThrowsOnceBudgetExceeded(t *testing.T) {
	limiter := newRateLimiterWithStore(newFakeRateLimiterStore(), RateLimiterConfig{RequestsPerSecond: 3})
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		if err := limiter.CheckAndConsume(ctx, "psp-1"); err != nil {
			t.Fatalf("request %d: unexpected error: %v", i, err)
		}
	}
	err := limiter.CheckAndConsume(ctx, "psp-1")
	if err == nil {
		t.Fatal("expected RateLimitExceededError")
	}
	var rateLimitErr *RateLimitExceededError
	if !errors.As(err, &rateLimitErr) {
		t.Fatalf("expected *RateLimitExceededError, got %T: %v", err, err)
	}
	if rateLimitErr.PspAccountID != "psp-1" {
		t.Fatalf("got PspAccountID %q, want psp-1", rateLimitErr.PspAccountID)
	}
}

func TestOutboundRateLimiter_TracksEachPspAccountIndependently(t *testing.T) {
	limiter := newRateLimiterWithStore(newFakeRateLimiterStore(), RateLimiterConfig{RequestsPerSecond: 1})
	ctx := context.Background()

	if err := limiter.CheckAndConsume(ctx, "psp-1"); err != nil {
		t.Fatalf("psp-1 first request: unexpected error: %v", err)
	}
	if err := limiter.CheckAndConsume(ctx, "psp-2"); err != nil {
		t.Fatalf("psp-2 first request: unexpected error: %v", err)
	}
	err := limiter.CheckAndConsume(ctx, "psp-1")
	if err == nil {
		t.Fatal("expected psp-1's second request to exceed its budget")
	}
	var rateLimitErr *RateLimitExceededError
	if !errors.As(err, &rateLimitErr) {
		t.Fatalf("expected *RateLimitExceededError, got %T: %v", err, err)
	}
}
