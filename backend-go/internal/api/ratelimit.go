package api

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// This file adds inbound rate limiting for this package's two
// UNAUTHENTICATED, browser-facing public checkout routes — GET
// /checkout/{id}/public and POST /checkout/{id}/confirm (see
// checkout_sessions.go's registerPublicCheckoutSessionRoutes).
//
// BUG FIX (backend review, 2026-07-10): both routes are deliberately
// mounted OUTSIDE the /v1 Bearer-auth group (the caller is an end
// user's browser, which never holds an API token), and until this fix
// neither had ANY rate limiting. POST .../confirm is the far more
// serious gap: it calls straight through to adapter.CreatePayment — it
// charges a real card, gated only by knowledge of a session id and its
// clientSecret. Without a rate limit, an attacker holding a list of
// stolen card tokens and a single valid (or guessed/leaked)
// session-id/clientSecret pair could hammer this one endpoint as fast
// as the network allows — a textbook card-testing/carding attack, using
// this codebase's own infrastructure to validate stolen cards for free.
// GET .../public is lower-stakes (read-only) but still worth bounding
// against session-id enumeration/scraping.
//
// Deliberately a small, self-contained INCR + one-time EXPIRE fixed-
// window counter — the same well-understood Redis primitive
// internal/routing/ratelimiter.go's outbound, per-psp_account limiter
// (T7.1) already uses — rather than importing that package's limiter
// directly: that one is keyed by psp_account id and protects an
// OUTBOUND call to a PSP from exceeding the PSP's own published rate
// limit; this one is keyed by client IP and protects this process's own
// public HTTP surface from abuse. Different key shape, different
// config (a per-minute customer-facing budget vs. a per-second PSP
// budget), different failure semantics worth documenting independently
// — not worth forcing through one shared abstraction just because the
// underlying Redis command pair happens to be identical.

// PublicRateLimiterStore is the minimal capability
// rateLimitPublicCheckoutRoute needs from Redis.
type PublicRateLimiterStore interface {
	Incr(ctx context.Context, key string) (int64, error)
	Expire(ctx context.Context, key string, ttl time.Duration) error
}

// RedisPublicRateLimiterStore adapts a *redis.Client (the same
// go-redis dependency already wired elsewhere in this package — see
// infra.go's RedisIdempotencyCache) to PublicRateLimiterStore.
type RedisPublicRateLimiterStore struct {
	Client *redis.Client
}

func (s RedisPublicRateLimiterStore) Incr(ctx context.Context, key string) (int64, error) {
	return s.Client.Incr(ctx, key).Result()
}

func (s RedisPublicRateLimiterStore) Expire(ctx context.Context, key string, ttl time.Duration) error {
	return s.Client.Expire(ctx, key, ttl).Err()
}

// PublicCheckoutRateLimitConfig configures rateLimitPublicCheckoutRoute.
type PublicCheckoutRateLimitConfig struct {
	// RequestsPerWindow: how many requests a single client IP may make
	// to ONE rate-limited route within Window.
	RequestsPerWindow int
	Window            time.Duration
}

// DefaultPublicCheckoutRateLimitConfig: 20 requests/minute per client IP
// per route. Generous for a real customer completing a checkout (which
// needs, at most, a handful of GET .../public polls plus one POST
// .../confirm call — even a browser retry storm from a flaky connection
// falls well inside this), while still bounding the two realistic abuse
// patterns these specific routes are exposed to (see this file's top
// doc comment).
var DefaultPublicCheckoutRateLimitConfig = PublicCheckoutRateLimitConfig{
	RequestsPerWindow: 20,
	Window:            time.Minute,
}

// rateLimitPublicCheckoutRoute wraps next with a per-client-IP,
// per-route fixed-window rate limit backed by store. If store is nil
// (no Redis-backed limiter wired — see CheckoutSessionsRouteDeps'
// RateLimiter field doc comment for when/why that can happen), next
// runs unwrapped: a missing limiter is a configuration gap to fix at
// deploy time, logged loudly where this is wired (router.go), not a
// reason to 500 every public checkout request.
func rateLimitPublicCheckoutRoute(store PublicRateLimiterStore, config PublicCheckoutRateLimitConfig, routeName string, next http.HandlerFunc) http.HandlerFunc {
	if store == nil {
		return next
	}
	if config.RequestsPerWindow <= 0 || config.Window <= 0 {
		config = DefaultPublicCheckoutRateLimitConfig
	}
	windowSeconds := int64(config.Window.Seconds())
	if windowSeconds <= 0 {
		windowSeconds = 1
	}

	return func(w http.ResponseWriter, r *http.Request) {
		clientIP := clientIPForRateLimit(r)
		bucket := time.Now().Unix() / windowSeconds
		key := fmt.Sprintf("ratelimit:public-checkout:%s:%s:%d", routeName, clientIP, bucket)

		count, err := store.Incr(r.Context(), key)
		if err != nil {
			// Fail OPEN on a Redis error: an outage in the rate-limit store
			// must not take down checkout entirely for every legitimate
			// customer. This mirrors this codebase's own documented
			// fail-open philosophy for a defense-in-depth safety net (as
			// opposed to an actual authorization decision, where this
			// package fails CLOSED — see TokenStore.Lookup/RequireWriteScope
			// — because getting THAT wrong lets an unauthorized caller
			// through, not merely an occasional over-the-limit one).
			next(w, r)
			return
		}
		if count == 1 {
			// Best-effort: a duplicate/skipped EXPIRE from a concurrent
			// first-request race is harmless (every caller sets the same
			// TTL on the same key) — see
			// internal/routing/ratelimiter.go's identical reasoning for
			// why this doesn't need a Lua script.
			_ = store.Expire(r.Context(), key, config.Window)
		}
		if int(count) > config.RequestsPerWindow {
			w.Header().Set("Retry-After", fmt.Sprintf("%d", windowSeconds))
			WriteProblem(w, http.StatusTooManyRequests, "Too Many Requests",
				"Rate limit exceeded for this endpoint. Please wait before retrying.")
			return
		}
		next(w, r)
	}
}

// clientIPForRateLimit extracts the client's IP for rate-limiting
// purposes only — prefers the first entry of X-Forwarded-For (this
// process runs behind a reverse proxy in production, which sets this
// header reliably), falling back to r.RemoteAddr's host portion for
// direct connections (local dev, tests). This is a rate-limiting
// heuristic, not an authorization decision: a spoofed header at worst
// lets an attacker evade their OWN rate-limit bucket — it can never let
// them impersonate or act as a different, unrelated caller, since no
// data access or capability in this codebase is gated on this value,
// only a per-IP request count.
func clientIPForRateLimit(r *http.Request) string {
	if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
		if idx := strings.IndexByte(forwarded, ','); idx >= 0 {
			return strings.TrimSpace(forwarded[:idx])
		}
		return strings.TrimSpace(forwarded)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
