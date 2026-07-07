package routing

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// This file is the Go port of T7.1's outbound per-psp_account rate
// limiter (src/routing/rateLimiter.ts). A fixed 1-second window
// counter per psp_account (INCR + one-time EXPIRE, same shape as the
// circuit breaker's failure counter) -- simple, cheap in Redis, and
// sufficient for "don't blow through the PSP's own published rate
// limit," which is this limiter's whole job. It is NOT a token bucket
// with burst allowance; a merchant needing burst tolerance should
// raise RequestsPerSecond rather than this package growing bucket
// semantics it doesn't need yet.
//
// Deliberately separate from the circuit breaker (T5.3): a
// self-imposed rate limit is not a signal the PSP is unhealthy, so
// RateLimitExceededError must never reach CircuitBreaker.RecordFailure
// -- callers must guard against that explicitly, exactly as
// src/api/routes/payments.ts's create-payment handler does in the TS
// source.
//
// ATOMICITY: unlike circuitbreaker.go's RecordFailure/RecordSuccess,
// this limiter's CheckAndConsume is left as the plain
// INCR-then-conditional-EXPIRE sequence the TS source itself uses,
// NOT wrapped in a Lua script -- matching rateLimiter.ts's own
// unscripted implementation exactly (its own doc comment says so: "A
// fixed 1-second window counter ... (INCR + one-time EXPIRE, same
// shape as the circuit breaker's failure counter)"). This is a
// deliberate, considered difference from circuitbreaker.go's approach,
// not an inconsistency: INCR is already atomic as a single Redis
// command, so two concurrent CheckAndConsume calls for the same
// psp_account in the same second-bucket can never corrupt the count
// itself (Redis serializes each INCR); the only thing that could
// theoretically race is which caller's INCR happens to be the one that
// returns 1 and therefore sets the EXPIRE -- and since every caller
// sets the exact same TTL on the exact same key regardless of which
// one "wins" that race, a duplicate/skipped EXPIRE call has no
// observable effect on correctness (worst case, the key's expiry gets
// refreshed by more than one caller in the same second, which is
// harmless). This is materially different from the circuit breaker's
// read-current-state-then-branch-into-different-outcomes logic, where
// an interleaved read genuinely could produce a wrong transition --
// there is no equivalent "wrong outcome" here for the rate limiter to
// protect against with a script. Matching the TS source's own
// unscripted implementation here is therefore not a missed opportunity
// for consistency; it is the correct call for this specific access
// pattern.
//
// TESTABILITY: RateLimiter depends on the narrow RateLimiterStore
// interface below (incr/expire only) rather than a concrete
// *redis.Client, mirroring rateLimiter.ts's own RateLimiterStore
// interface field-for-field. *redis.Client satisfies it via
// redisRateLimiterStore (below); ratelimiter_test.go's
// fakeRateLimiterStore is the direct Go analogue of the TS test
// suite's FakeRateLimiterStore.
type RateLimiter struct {
	store  RateLimiterStore
	config RateLimiterConfig
}

// RateLimiterStore mirrors RateLimiterStore exactly: incr/expire only.
type RateLimiterStore interface {
	Incr(ctx context.Context, key string) (int64, error)
	Expire(ctx context.Context, key string, seconds time.Duration) error
}

// redisRateLimiterStore adapts a *redis.Client to RateLimiterStore.
type redisRateLimiterStore struct {
	client *redis.Client
}

func (s redisRateLimiterStore) Incr(ctx context.Context, key string) (int64, error) {
	return s.client.Incr(ctx, key).Result()
}

func (s redisRateLimiterStore) Expire(ctx context.Context, key string, ttl time.Duration) error {
	return s.client.Expire(ctx, key, ttl).Err()
}

// RateLimiterConfig mirrors RateLimiterConfig.
type RateLimiterConfig struct {
	// RequestsPerSecond: default of 25 matches Stripe's published
	// test-mode limit -- a conservative floor, not a claim about every
	// PSP.
	RequestsPerSecond int
}

// DefaultRateLimiterConfig mirrors DEFAULT_RATE_LIMITER_CONFIG exactly.
var DefaultRateLimiterConfig = RateLimiterConfig{RequestsPerSecond: 25}

// RateLimitExceededError mirrors RateLimitExceededError.
type RateLimitExceededError struct {
	PspAccountID string
}

func (e *RateLimitExceededError) Error() string {
	return fmt.Sprintf("Outbound rate limit exceeded for psp_account %s", e.PspAccountID)
}

// NewRateLimiter constructs a RateLimiter backed by client.
func NewRateLimiter(client *redis.Client, config RateLimiterConfig) *RateLimiter {
	return &RateLimiter{store: redisRateLimiterStore{client: client}, config: config}
}

// newRateLimiterWithStore is the test-only constructor accepting any
// RateLimiterStore (a fake, in tests) rather than a concrete
// *redis.Client.
func newRateLimiterWithStore(store RateLimiterStore, config RateLimiterConfig) *RateLimiter {
	return &RateLimiter{store: store, config: config}
}

// CheckAndConsume mirrors checkAndConsume exactly: increments the
// current second's bucket counter for pspAccountID and returns a
// *RateLimitExceededError if that account has already used up this
// second's budget. The bucket key includes the current Unix second
// (time.Now().Unix()), matching `Math.floor(Date.now() / 1000)`
// exactly; the TTL of 2 seconds (not 1) is deliberate in both the TS
// source and here, so a slow reader checking a just-expired bucket
// doesn't race a clean expiry right at the boundary.
func (l *RateLimiter) CheckAndConsume(ctx context.Context, pspAccountID string) error {
	bucket := time.Now().Unix()
	key := fmt.Sprintf("ratelimit:%s:%d", pspAccountID, bucket)

	count, err := l.store.Incr(ctx, key)
	if err != nil {
		return fmt.Errorf("routing: redis INCR %s: %w", key, err)
	}
	if count == 1 {
		if err := l.store.Expire(ctx, key, 2*time.Second); err != nil {
			return fmt.Errorf("routing: redis EXPIRE %s: %w", key, err)
		}
	}
	if int(count) > l.config.RequestsPerSecond {
		return &RateLimitExceededError{PspAccountID: pspAccountID}
	}
	return nil
}
