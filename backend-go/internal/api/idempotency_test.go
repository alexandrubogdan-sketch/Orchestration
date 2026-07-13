package api

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"testing"
	"time"
)

// fakeIdempotencyStore is an in-memory IdempotencyStore for tests —
// this package never needs a live Postgres to exercise
// WithIdempotencyKey's logic, matching the task's "no Go toolchain to
// run a real DB in tests anyway" guidance: write these correctly as if
// they would run in CI, without requiring live infrastructure.
type fakeIdempotencyStore struct {
	mu   sync.Mutex
	rows map[string]*IdempotencyKeyRow
}

func newFakeIdempotencyStore() *fakeIdempotencyStore {
	return &fakeIdempotencyStore{rows: make(map[string]*IdempotencyKeyRow)}
}

func (s *fakeIdempotencyStore) Insert(_ context.Context, key string, requestHash string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.rows[key]; exists {
		return ErrIdempotencyKeyExists
	}
	s.rows[key] = &IdempotencyKeyRow{RequestHash: requestHash, Status: idempotencyStatusInProgress}
	return nil
}

func (s *fakeIdempotencyStore) Get(_ context.Context, key string) (IdempotencyKeyRow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	row, ok := s.rows[key]
	if !ok {
		return IdempotencyKeyRow{}, ErrIdempotencyKeyNotFound
	}
	return *row, nil
}

func (s *fakeIdempotencyStore) Complete(_ context.Context, key string, responseStatus int, responseBody any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	row, ok := s.rows[key]
	if !ok {
		return errors.New("no such key")
	}
	row.Status = idempotencyStatusCompleted
	row.ResponseStatus = responseStatus
	row.ResponseBody = responseBody
	return nil
}

func (s *fakeIdempotencyStore) Delete(_ context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.rows, key)
	return nil
}

// fakeIdempotencyCache is an in-memory IdempotencyCache for tests.
type fakeIdempotencyCache struct {
	mu     sync.Mutex
	values map[string]string
}

func newFakeIdempotencyCache() *fakeIdempotencyCache {
	return &fakeIdempotencyCache{values: make(map[string]string)}
}

func (c *fakeIdempotencyCache) Get(_ context.Context, key string) (string, bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	v, ok := c.values[key]
	return v, ok, nil
}

func (c *fakeIdempotencyCache) Set(_ context.Context, key string, value string, _ time.Duration) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.values[key] = value
	return nil
}

func TestComputeRequestHash(t *testing.T) {
	t.Run("deterministic for the same method/path/body", func(t *testing.T) {
		req := IdempotentRequestDescriptor{Method: "POST", Path: "/v1/payments", Body: map[string]any{"amount": float64(100)}}
		a, err := ComputeRequestHash(req)
		if err != nil {
			t.Fatal(err)
		}
		b, err := ComputeRequestHash(req)
		if err != nil {
			t.Fatal(err)
		}
		if a != b {
			t.Errorf("expected deterministic hash, got %q vs %q", a, b)
		}
	})

	t.Run("case-insensitive on method", func(t *testing.T) {
		a, _ := ComputeRequestHash(IdempotentRequestDescriptor{Method: "post", Path: "/v1/payments", Body: map[string]any{"a": float64(1)}})
		b, _ := ComputeRequestHash(IdempotentRequestDescriptor{Method: "POST", Path: "/v1/payments", Body: map[string]any{"a": float64(1)}})
		if a != b {
			t.Errorf("expected case-insensitive method hash, got %q vs %q", a, b)
		}
	})

	t.Run("differs when the body differs", func(t *testing.T) {
		a, _ := ComputeRequestHash(IdempotentRequestDescriptor{Method: "POST", Path: "/v1/payments", Body: map[string]any{"amount": float64(100)}})
		b, _ := ComputeRequestHash(IdempotentRequestDescriptor{Method: "POST", Path: "/v1/payments", Body: map[string]any{"amount": float64(200)}})
		if a == b {
			t.Errorf("expected different hashes for different bodies, got equal %q", a)
		}
	})

	t.Run("differs when the path differs", func(t *testing.T) {
		a, _ := ComputeRequestHash(IdempotentRequestDescriptor{Method: "POST", Path: "/v1/payments", Body: map[string]any{}})
		b, _ := ComputeRequestHash(IdempotentRequestDescriptor{Method: "POST", Path: "/v1/refunds", Body: map[string]any{}})
		if a == b {
			t.Errorf("expected different hashes for different paths, got equal %q", a)
		}
	})

	t.Run("treats nil body the same as an explicit nil (Go's `?? null` analogue)", func(t *testing.T) {
		a, _ := ComputeRequestHash(IdempotentRequestDescriptor{Method: "POST", Path: "/v1/payments", Body: nil})
		b, _ := ComputeRequestHash(IdempotentRequestDescriptor{Method: "POST", Path: "/v1/payments", Body: nil})
		if a != b {
			t.Errorf("expected equal hashes for nil body, got %q vs %q", a, b)
		}
	})
}

func TestRequireIdempotencyKey(t *testing.T) {
	t.Run("extracts a valid header", func(t *testing.T) {
		h := http.Header{}
		h.Set("Idempotency-Key", "abc-123")
		key, err := RequireIdempotencyKey(h)
		if err != nil {
			t.Fatal(err)
		}
		if key != "abc-123" {
			t.Errorf("got %q, want %q", key, "abc-123")
		}
	})

	t.Run("throws MissingIdempotencyKeyError when absent", func(t *testing.T) {
		_, err := RequireIdempotencyKey(http.Header{})
		var missing *MissingIdempotencyKeyError
		if !errors.As(err, &missing) {
			t.Errorf("expected MissingIdempotencyKeyError, got %v", err)
		}
	})

	t.Run("throws MissingIdempotencyKeyError for an empty/whitespace-only header", func(t *testing.T) {
		h := http.Header{}
		h.Set("Idempotency-Key", "   ")
		_, err := RequireIdempotencyKey(h)
		var missing *MissingIdempotencyKeyError
		if !errors.As(err, &missing) {
			t.Errorf("expected MissingIdempotencyKeyError, got %v", err)
		}
	})
}

// Table-driven test for WithIdempotencyKey's three headline cases per
// the task brief: new key, same key/same body replay, same key/
// different body conflict.
func TestWithIdempotencyKey_TableDriven(t *testing.T) {
	type step struct {
		name       string
		key        string
		body       any
		wantReplay bool
	}

	store := newFakeIdempotencyStore()
	cache := newFakeIdempotencyCache()
	deps := IdempotencyDeps{Store: store, Cache: cache}

	callCount := 0
	handler := func(ctx context.Context) (IdempotentResult, error) {
		callCount++
		return IdempotentResult{Status: 201, Body: map[string]any{"paymentId": "p1"}}, nil
	}

	steps := []step{
		{name: "new key executes handler", key: "key-1", body: map[string]any{"amount": float64(100)}, wantReplay: false},
		{name: "same key + same body replays cached result", key: "key-1", body: map[string]any{"amount": float64(100)}, wantReplay: true},
	}

	for _, s := range steps {
		t.Run(s.name, func(t *testing.T) {
			outcome, err := WithIdempotencyKey(context.Background(), deps, "test-scope", s.key,
				IdempotentRequestDescriptor{Method: "POST", Path: "/v1/payments", Body: s.body}, handler)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if outcome.Replayed != s.wantReplay {
				t.Errorf("Replayed = %v, want %v", outcome.Replayed, s.wantReplay)
			}
			if outcome.Status != 201 {
				t.Errorf("Status = %d, want 201", outcome.Status)
			}
		})
	}

	if callCount != 1 {
		t.Errorf("handler should have run exactly once across both steps, ran %d times", callCount)
	}

	t.Run("same key + different body is a conflict", func(t *testing.T) {
		_, err := WithIdempotencyKey(context.Background(), deps, "test-scope", "key-1",
			IdempotentRequestDescriptor{Method: "POST", Path: "/v1/payments", Body: map[string]any{"amount": float64(999)}}, handler)
		var conflict *IdempotencyConflictError
		if !errors.As(err, &conflict) {
			t.Errorf("expected IdempotencyConflictError, got %v", err)
		}
	})

	t.Run("a handler that errors deletes the in-progress row so a retry with the same key succeeds fresh", func(t *testing.T) {
		key := "key-2"
		body := map[string]any{"amount": float64(1)}
		attempt := 0
		flaky := func(ctx context.Context) (IdempotentResult, error) {
			attempt++
			if attempt == 1 {
				return IdempotentResult{}, errors.New("simulated transient failure")
			}
			return IdempotentResult{Status: 201, Body: map[string]any{"ok": true}}, nil
		}

		_, err := WithIdempotencyKey(context.Background(), deps, "test-scope", key,
			IdempotentRequestDescriptor{Method: "POST", Path: "/v1/payments", Body: body}, flaky)
		if err == nil || err.Error() != "simulated transient failure" {
			t.Fatalf("expected the original error to propagate, got %v", err)
		}

		outcome, err := WithIdempotencyKey(context.Background(), deps, "test-scope", key,
			IdempotentRequestDescriptor{Method: "POST", Path: "/v1/payments", Body: body}, flaky)
		if err != nil {
			t.Fatalf("expected retry to succeed, got %v", err)
		}
		if outcome.Replayed {
			t.Error("expected a fresh (non-replayed) execution after the key was cleared")
		}
		if attempt != 2 {
			t.Errorf("expected exactly 2 attempts, got %d", attempt)
		}
	})
}

// TestWithIdempotencyKey_PanicRecovery guards against a regression of a
// real bug found in the 2026-07 backend review: WithIdempotencyKey used
// to call handler(ctx) with no recover at all, so a panicking handler
// left its idempotency_keys row permanently wedged in_progress — no
// subsequent retry with the same key could ever succeed, since nothing
// else in this package's flow ever deletes or completes a row once
// pollForCompletion's pollTimeout has elapsed. This test asserts both
// halves of the fix: (1) the panic still propagates out of
// WithIdempotencyKey (it must — this package deliberately relies on the
// existing top-level recoverMiddleware in router.go to convert panics
// into a logged 500, not swallow them here), and (2) the in_progress
// row is gone afterward, so an immediate retry with the same key gets a
// fresh attempt instead of IdempotencyStillInProgressError.
func TestWithIdempotencyKey_PanicRecovery(t *testing.T) {
	store := newFakeIdempotencyStore()
	cache := newFakeIdempotencyCache()
	deps := IdempotencyDeps{Store: store, Cache: cache}

	key := "panic-key"
	body := map[string]any{"amount": float64(1)}
	request := IdempotentRequestDescriptor{Method: "POST", Path: "/v1/payments", Body: body}

	panicking := func(ctx context.Context) (IdempotentResult, error) {
		panic("simulated nil pointer dereference deep in a PSP adapter")
	}

	func() {
		defer func() {
			r := recover()
			if r == nil {
				t.Fatal("expected the panic to propagate out of WithIdempotencyKey, got no panic")
			}
			if r != "simulated nil pointer dereference deep in a PSP adapter" {
				t.Errorf("recovered value = %v, want the original panic value unchanged", r)
			}
		}()
		_, _ = WithIdempotencyKey(context.Background(), deps, "test-scope", key, request, panicking)
		t.Fatal("unreachable: WithIdempotencyKey should have panicked")
	}()

	if _, err := store.Get(context.Background(), scopeIdempotencyKey("test-scope", key)); !errors.Is(err, ErrIdempotencyKeyNotFound) {
		t.Errorf("expected the in_progress row to be deleted after the panic, Get returned err=%v", err)
	}

	// A fresh, non-panicking retry with the identical key must now run
	// the handler for real rather than getting stuck polling a
	// nonexistent row (IdempotencyStillInProgressError) — proving the
	// key was actually cleaned up, not just observably absent from one
	// direct store.Get call.
	ranAgain := false
	outcome, err := WithIdempotencyKey(context.Background(), deps, "test-scope", key, request,
		func(ctx context.Context) (IdempotentResult, error) {
			ranAgain = true
			return IdempotentResult{Status: 201, Body: map[string]any{"ok": true}}, nil
		})
	if err != nil {
		t.Fatalf("expected the retry after a panic to succeed, got %v", err)
	}
	if !ranAgain {
		t.Error("expected the retry's handler to actually run (a fresh attempt), not replay a stale state")
	}
	if outcome.Replayed {
		t.Error("expected a fresh, non-replayed execution after the panicking attempt's row was cleared")
	}
}

// TestWithIdempotencyKey_ConcurrentIdenticalRequests mirrors
// test/integration/idempotency.test.ts's "20 concurrent identical
// requests execute the handler exactly once" case, using the in-memory
// fakes above instead of real Postgres/Redis (no live DB available in
// this sandbox — see MIGRATION_NOTES.md — but the logic under test,
// WithIdempotencyKey's INSERT-race-then-poll behavior, is exactly the
// same regardless of backing store).
func TestWithIdempotencyKey_ConcurrentIdenticalRequests(t *testing.T) {
	store := newFakeIdempotencyStore()
	cache := newFakeIdempotencyCache()
	deps := IdempotencyDeps{Store: store, Cache: cache}

	key := "concurrent-key"
	body := map[string]any{"amount": float64(500)}

	var executionCount int32
	var mu sync.Mutex
	handler := func(ctx context.Context) (IdempotentResult, error) {
		mu.Lock()
		executionCount++
		mu.Unlock()
		time.Sleep(5 * time.Millisecond)
		return IdempotentResult{Status: 201, Body: map[string]any{"paymentId": "p-concurrent"}}, nil
	}

	const n = 20
	results := make([]IdempotentOutcome, n)
	errs := make([]error, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			outcome, err := WithIdempotencyKey(context.Background(), deps, "test-scope", key,
				IdempotentRequestDescriptor{Method: "POST", Path: "/v1/payments", Body: body}, handler)
			results[i] = outcome
			errs[i] = err
		}(i)
	}
	wg.Wait()

	if executionCount != 1 {
		t.Errorf("expected handler to run exactly once, ran %d times", executionCount)
	}

	nonReplayed := 0
	for i, err := range errs {
		if err != nil {
			t.Fatalf("result %d: unexpected error: %v", i, err)
		}
		if results[i].Status != 201 {
			t.Errorf("result %d: Status = %d, want 201", i, results[i].Status)
		}
		if !results[i].Replayed {
			nonReplayed++
		}
	}
	if nonReplayed != 1 {
		t.Errorf("expected exactly 1 non-replayed (winning) result, got %d", nonReplayed)
	}
}

