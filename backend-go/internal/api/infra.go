package api

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

// This file adapts the real pgx/go-redis client types this phase's
// cmd/api/main.go constructs into the narrow PostgresPinger/RedisPinger
// interfaces health.go depends on — kept as small wrapper types (not
// method values) so main.go's wiring reads plainly and so a future
// swap of either client library only touches this one file.

// PgxPinger adapts a *pgxpool.Pool to the PostgresPinger interface via
// its Ping method — the Go analogue of the TS pingPostgres(pool)
// helper's `await pool.query('SELECT 1')` (pgx's pool.Ping issues the
// equivalent liveness check without needing to round-trip an actual
// query string, which is the idiomatic pgx way to do this).
type PgxPinger struct {
	Pool *pgxpool.Pool
}

func (p PgxPinger) Ping(ctx context.Context) error {
	return p.Pool.Ping(ctx)
}

// RedisClientPinger adapts a *redis.Client to the RedisPinger interface
// — the Go analogue of the TS pingRedis(client) helper, which sends
// PING and checks for a literal "PONG" reply. go-redis's Ping().Err()
// already returns a non-nil error for anything other than a
// successful PONG, so this wrapper's behavior matches the TS helper's
// explicit `if (reply !== 'PONG') throw ...` check without needing to
// inspect the reply string itself.
type RedisClientPinger struct {
	Client *redis.Client
}

func (r RedisClientPinger) Ping(ctx context.Context) error {
	return r.Client.Ping(ctx).Err()
}

// RedisIdempotencyCache adapts a *redis.Client to the IdempotencyCache
// interface — a real, working implementation (unlike the stubs in
// stubs.go) since go-redis is a genuine dependency of this phase and
// GET/SET are trivial, well-understood calls with no later-phase
// dependency the way the DB-backed stores have.
type RedisIdempotencyCache struct {
	Client *redis.Client
}

func (c RedisIdempotencyCache) Get(ctx context.Context, key string) (string, bool, error) {
	value, err := c.Client.Get(ctx, key).Result()
	if errors.Is(err, redis.Nil) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return value, true, nil
}

func (c RedisIdempotencyCache) Set(ctx context.Context, key string, value string, ttl time.Duration) error {
	return c.Client.Set(ctx, key, value, ttl).Err()
}
