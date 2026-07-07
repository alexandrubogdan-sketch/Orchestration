package routing

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// This file is the Go port of rulesRepo.ts's Redis cache-aside layer:
// a 300-second TTL read-through cache keyed by (merchantEntityId,
// productId), with an explicit invalidation path on every write rather
// than relying solely on the TTL to eventually pick up a change.
// Postgres remains the source of truth; Redis is purely an
// optimization -- a cache miss (or Redis being briefly unavailable in
// a way that surfaces as an error from Get, which callers should
// treat as a miss -- see Get's doc comment) always falls through to
// Postgres in rules.go's ListActiveRules.

// cacheTTL mirrors rulesRepo.ts's CACHE_TTL_SECONDS constant exactly
// -- 300 seconds.
const cacheTTL = 300 * time.Second

func cacheKey(merchantEntityID, productID string) string {
	pid := productID
	if pid == "" {
		pid = "_"
	}
	return fmt.Sprintf("routing:rules:%s:%s", merchantEntityID, pid)
}

// Cache is the Redis-backed routing_rules cache. Every method takes a
// plain *redis.Client (go-redis v9) rather than a narrow interface,
// matching this port's existing convention for genuinely-real
// infrastructure adapters (see internal/api/infra.go's
// RedisIdempotencyCache) -- unlike CircuitBreaker/RateLimiter below,
// which DO define a narrow store interface because their unit tests
// need a hand-rolled in-memory fake standing in for Redis; this
// package's own cache tests exercise Cache indirectly through
// RulesRepo with cache set to nil (no caching) rather than mocking
// go-redis, since faking go-redis's much larger client surface isn't
// worth it just to test a get/set/keys/del cache-aside wrapper.
type Cache struct {
	client *redis.Client
}

// NewCache constructs a Cache backed by client.
func NewCache(client *redis.Client) *Cache {
	return &Cache{client: client}
}

// Get mirrors rulesRepo.ts's cache-hit branch: a cache hit returns the
// deserialized rule list and ok=true; a cache miss (redis.Nil) returns
// ok=false with no error, so ListActiveRules's caller falls through to
// Postgres exactly the way `if (cached) { return JSON.parse(cached); }`
// does in the TS source (a falsy `cached`, i.e. redis returning null
// for a missing key, falls through there too).
func (c *Cache) Get(ctx context.Context, merchantEntityID, productID string) ([]Rule, bool, error) {
	raw, err := c.client.Get(ctx, cacheKey(merchantEntityID, productID)).Result()
	if err == redis.Nil {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("routing: redis GET %s: %w", cacheKey(merchantEntityID, productID), err)
	}
	var rules []Rule
	if err := json.Unmarshal([]byte(raw), &rules); err != nil {
		return nil, false, fmt.Errorf("routing: unmarshal cached rules for %s: %w", cacheKey(merchantEntityID, productID), err)
	}
	return rules, true, nil
}

// Set mirrors rulesRepo.ts's `await deps.redis.set(key, JSON.stringify(rules), 'EX', CACHE_TTL_SECONDS)`
// exactly -- a plain SET with a 300s expiry, JSON-serialized.
func (c *Cache) Set(ctx context.Context, merchantEntityID, productID string, rules []Rule) error {
	if rules == nil {
		rules = []Rule{}
	}
	payload, err := json.Marshal(rules)
	if err != nil {
		return fmt.Errorf("routing: marshal rules for cache: %w", err)
	}
	key := cacheKey(merchantEntityID, productID)
	if err := c.client.Set(ctx, key, payload, cacheTTL).Err(); err != nil {
		return fmt.Errorf("routing: redis SET %s: %w", key, err)
	}
	return nil
}

// InvalidateEntity mirrors rulesRepo.ts's invalidate helper exactly:
// a rule can be entity-wide (visible to every product's cache entry
// for that entity), so a write to ANY rule invalidates every cache key
// for the whole merchant entity, not just the single (entity,
// productId) pair the write happened under. Uses KEYS (via SCAN under
// the hood is NOT what go-redis's Keys does -- it issues a literal
// Redis KEYS command, matching the TS source's own `deps.redis.keys(pattern)`
// call byte-for-byte, including its documented risk: KEYS is an O(N)
// full-keyspace scan that blocks the Redis event loop, which the TS
// source's own comment excuses only because "writes are an admin
// operation, not per-request traffic." That same excuse, and the same
// risk, carries over unchanged to this Go port -- a high-volume
// deployment should replace this with a maintained per-entity SET of
// active cache keys, exactly as the TS source's comment recommends,
// not something this port attempted to fix silently while porting it.
func (c *Cache) InvalidateEntity(ctx context.Context, merchantEntityID string) error {
	pattern := fmt.Sprintf("routing:rules:%s:*", merchantEntityID)
	keys, err := c.client.Keys(ctx, pattern).Result()
	if err != nil {
		return fmt.Errorf("routing: redis KEYS %s: %w", pattern, err)
	}
	if len(keys) == 0 {
		return nil
	}
	if err := c.client.Del(ctx, keys...).Err(); err != nil {
		return fmt.Errorf("routing: redis DEL for pattern %s: %w", pattern, err)
	}
	return nil
}
