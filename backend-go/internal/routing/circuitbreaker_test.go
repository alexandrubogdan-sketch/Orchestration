package routing

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

// fakeScriptRunner is an in-memory ScriptRunner -- the Go analogue of
// circuitBreaker.test.ts's FakeBreakerStore, reproducing the same
// GET/INCR/EXPIRE/SET/DEL key semantics the real Lua scripts encode,
// entirely in Go, so these tests need neither a live Redis nor a Lua
// interpreter. EXPIRE is a no-op here, mirroring the TS fake's own
// documented "the fake never actually expires keys" behavior -- tests
// that care about window/cooldown expiry manipulate the breaker's
// clock (via CircuitBreaker.now, this port's equivalent of
// vi.useFakeTimers()) instead of relying on real wall-clock TTLs,
// exactly as the TS suite does.
type fakeScriptRunner struct {
	mu     sync.Mutex
	values map[string]string
}

func newFakeScriptRunner() *fakeScriptRunner {
	return &fakeScriptRunner{values: make(map[string]string)}
}

func (f *fakeScriptRunner) Get(ctx context.Context, key string) *redis.StringCmd {
	f.mu.Lock()
	defer f.mu.Unlock()
	cmd := redis.NewStringCmd(ctx, "get", key)
	if v, ok := f.values[key]; ok {
		cmd.SetVal(v)
	} else {
		cmd.SetErr(redis.Nil)
	}
	return cmd
}

// RunFailureScript reproduces recordFailureScript's exact branching in
// Go, keyed the same way (keys[0] = openedAt, keys[1] = failureCount).
// args are (nowMillis int64, cooldownMs int64, windowSeconds int64,
// threshold int) -- matching RecordFailure's call site exactly.
func (f *fakeScriptRunner) RunFailureScript(ctx context.Context, keys []string, args ...any) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	openedAtKey, failureCountKey := keys[0], keys[1]
	now := args[0].(int64)
	cooldownMs := args[1].(int64)
	threshold := args[3].(int)

	if raw, ok := f.values[openedAtKey]; ok {
		var openedAt int64
		fmt.Sscanf(raw, "%d", &openedAt)
		elapsed := now - openedAt
		if elapsed < cooldownMs {
			return "open", nil
		}
		f.values[openedAtKey] = fmt.Sprintf("%d", now)
		return "open", nil
	}

	countRaw := f.values[failureCountKey]
	var count int
	fmt.Sscanf(countRaw, "%d", &count)
	count++
	f.values[failureCountKey] = fmt.Sprintf("%d", count)
	if count >= threshold {
		f.values[openedAtKey] = fmt.Sprintf("%d", now)
		delete(f.values, failureCountKey)
		return "open", nil
	}
	return "closed", nil
}

func (f *fakeScriptRunner) RunSuccessScript(ctx context.Context, keys []string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.values, keys[0])
	delete(f.values, keys[1])
	return "closed", nil
}

func newTestBreaker(config CircuitBreakerConfig) (*CircuitBreaker, *fakeScriptRunner) {
	runner := newFakeScriptRunner()
	breaker := newCircuitBreakerWithRunner(runner, config)
	return breaker, runner
}

func testBreakerConfig() CircuitBreakerConfig {
	return CircuitBreakerConfig{FailureThreshold: 3, Window: 60 * time.Second, Cooldown: 30 * time.Second}
}

// setClock pins breaker.now to a fixed instant -- this port's
// equivalent of vi.useFakeTimers() + vi.setSystemTime(). Both
// RecordFailure and GetState read breaker.now(), so pinning it here is
// sufficient to control every time-dependent decision this package
// makes, without needing a real sleep.
func setClock(breaker *CircuitBreaker, at time.Time) {
	breaker.now = func() time.Time { return at }
}

func mustRecordFailure(t *testing.T, breaker *CircuitBreaker, pspAccountID string) {
	t.Helper()
	if err := breaker.RecordFailure(context.Background(), pspAccountID); err != nil {
		t.Fatalf("RecordFailure: %v", err)
	}
}

func mustGetState(t *testing.T, breaker *CircuitBreaker, pspAccountID string) BreakerState {
	t.Helper()
	state, err := breaker.GetState(context.Background(), pspAccountID)
	if err != nil {
		t.Fatalf("GetState: %v", err)
	}
	return state
}

func TestCircuitBreaker_StartsClosedAndAvailable(t *testing.T) {
	breaker, _ := newTestBreaker(testBreakerConfig())
	setClock(breaker, time.Now())

	if state := mustGetState(t, breaker, "psp-1"); state != BreakerStateClosed {
		t.Fatalf("got %q, want closed", state)
	}
	available, err := breaker.IsAvailable(context.Background(), "psp-1")
	if err != nil {
		t.Fatalf("IsAvailable: %v", err)
	}
	if !available {
		t.Fatal("expected available")
	}
}

func TestCircuitBreaker_OpensAfterReachingFailureThresholdWithinWindow(t *testing.T) {
	breaker, _ := newTestBreaker(testBreakerConfig())
	setClock(breaker, time.Now())

	mustRecordFailure(t, breaker, "psp-1")
	mustRecordFailure(t, breaker, "psp-1")
	if state := mustGetState(t, breaker, "psp-1"); state != BreakerStateClosed {
		t.Fatalf("after 2 failures (threshold 3): got %q, want closed", state)
	}

	mustRecordFailure(t, breaker, "psp-1")
	if state := mustGetState(t, breaker, "psp-1"); state != BreakerStateOpen {
		t.Fatalf("after 3rd failure: got %q, want open", state)
	}
	available, err := breaker.IsAvailable(context.Background(), "psp-1")
	if err != nil {
		t.Fatalf("IsAvailable: %v", err)
	}
	if available {
		t.Fatal("expected unavailable once open")
	}
}

func TestCircuitBreaker_DoesNotOpenADifferentPspAccountFromAnothersFailures(t *testing.T) {
	breaker, _ := newTestBreaker(testBreakerConfig())
	setClock(breaker, time.Now())

	mustRecordFailure(t, breaker, "psp-1")
	mustRecordFailure(t, breaker, "psp-1")
	mustRecordFailure(t, breaker, "psp-1")

	if state := mustGetState(t, breaker, "psp-1"); state != BreakerStateOpen {
		t.Fatalf("psp-1: got %q, want open", state)
	}
	if state := mustGetState(t, breaker, "psp-2"); state != BreakerStateClosed {
		t.Fatalf("psp-2: got %q, want closed (unaffected by psp-1's failures)", state)
	}
}

func TestCircuitBreaker_TransitionsOpenToHalfOpenAfterCooldownThenClosedOnSuccess(t *testing.T) {
	breaker, _ := newTestBreaker(testBreakerConfig())
	now := time.Now()
	setClock(breaker, now)

	mustRecordFailure(t, breaker, "psp-1")
	mustRecordFailure(t, breaker, "psp-1")
	mustRecordFailure(t, breaker, "psp-1")
	if state := mustGetState(t, breaker, "psp-1"); state != BreakerStateOpen {
		t.Fatalf("got %q, want open", state)
	}

	setClock(breaker, now.Add(breaker.config.Cooldown+time.Millisecond))
	if state := mustGetState(t, breaker, "psp-1"); state != BreakerStateHalfOpen {
		t.Fatalf("got %q, want half_open", state)
	}
	available, err := breaker.IsAvailable(context.Background(), "psp-1")
	if err != nil {
		t.Fatalf("IsAvailable: %v", err)
	}
	if !available {
		t.Fatal("expected half-open breaker to allow a trial attempt")
	}

	if err := breaker.RecordSuccess(context.Background(), "psp-1"); err != nil {
		t.Fatalf("RecordSuccess: %v", err)
	}
	if state := mustGetState(t, breaker, "psp-1"); state != BreakerStateClosed {
		t.Fatalf("got %q, want closed", state)
	}
}

func TestCircuitBreaker_FailedHalfOpenTrialReopensForFreshCooldown(t *testing.T) {
	breaker, _ := newTestBreaker(testBreakerConfig())
	now := time.Now()
	setClock(breaker, now)

	mustRecordFailure(t, breaker, "psp-1")
	mustRecordFailure(t, breaker, "psp-1")
	mustRecordFailure(t, breaker, "psp-1")

	afterCooldown := now.Add(breaker.config.Cooldown + time.Millisecond)
	setClock(breaker, afterCooldown)
	if state := mustGetState(t, breaker, "psp-1"); state != BreakerStateHalfOpen {
		t.Fatalf("got %q, want half_open", state)
	}

	// The half-open trial fails -- reopens for a FRESH cooldown measured
	// from afterCooldown, not from `now`.
	mustRecordFailure(t, breaker, "psp-1")
	if state := mustGetState(t, breaker, "psp-1"); state != BreakerStateOpen {
		t.Fatalf("immediately after reopening: got %q, want open", state)
	}

	// Still open right before the fresh cooldown elapses.
	setClock(breaker, afterCooldown.Add(breaker.config.Cooldown-time.Millisecond))
	if state := mustGetState(t, breaker, "psp-1"); state != BreakerStateOpen {
		t.Fatalf("just before fresh cooldown elapses: got %q, want open", state)
	}

	// And half_open again once the fresh cooldown has fully elapsed.
	setClock(breaker, afterCooldown.Add(breaker.config.Cooldown+time.Millisecond))
	if state := mustGetState(t, breaker, "psp-1"); state != BreakerStateHalfOpen {
		t.Fatalf("after fresh cooldown elapses: got %q, want half_open", state)
	}
}

func TestCircuitBreaker_RecordSuccessWhileClosedIsNoOpThatKeepsClosed(t *testing.T) {
	breaker, _ := newTestBreaker(testBreakerConfig())
	setClock(breaker, time.Now())

	mustRecordFailure(t, breaker, "psp-1")
	if err := breaker.RecordSuccess(context.Background(), "psp-1"); err != nil {
		t.Fatalf("RecordSuccess: %v", err)
	}
	mustRecordFailure(t, breaker, "psp-1")
	mustRecordFailure(t, breaker, "psp-1")

	// Only 2 failures accumulated after the reset (threshold is 3) --
	// still closed.
	if state := mustGetState(t, breaker, "psp-1"); state != BreakerStateClosed {
		t.Fatalf("got %q, want closed", state)
	}
}
