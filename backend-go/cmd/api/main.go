// Command api is the payment-orchestrator API process.
//
// Phase 5 of the Go rewrite: PaymentsStore/CustomersStore are now
// wired for real (PgxPaymentsStore/PgxCustomersStore, replacing every
// prior phase's Unimplemented* stubs), backed by a real
// *routing.Evaluator (routing_rules + Redis cache + circuit breaker,
// Phase 4) for ResolveRouting, and a real internal/webhooks.Deps for
// ApplyCanonicalEvents/webhook ingestion/normalize/apply/gap-detection.
// POST /webhooks/{psp} is now mounted, outside the /v1 auth group.
//
// Boot ordering — the single most important behavioral property this
// file is responsible for, per the task brief's explicit call-out of
// a real production incident: the TS reference implementation's
// src/server.ts called `await loadDeclineMaps(db)` (a synchronous
// Postgres round-trip) BEFORE `await app.listen(...)`, which meant a
// Postgres outage at boot time prevented the HTTP listener from ever
// binding at all — so /healthz itself was unreachable, which turned a
// transient DB outage into a full crash-loop instead of a degraded-
// but-alive process a load balancer could at least see and route
// around via /readyz. This file deliberately reorders that: the HTTP
// listener binds and starts serving /healthz (and every other route)
// FIRST, via a background goroutine, and only Postgres/Redis
// connection *pool construction* (not a round-trip — see below)
// happens before it. Nothing here blocks server startup on a live
// database round-trip:
//   - pgxpool.New / redis.NewClient both construct a connection pool
//     lazily — neither performs a network round-trip itself, matching
//     pg.Pool's own lazy-connection behavior in the TS source's
//     createPostgresPool. The actual liveness check
//     (pool.Ping/client.Ping) only happens inside /readyz's handler, at
//     request time, exactly mirroring pingPostgres/pingRedis being
//     called from inside the TS /readyz handler and nowhere else at
//     boot.
//   - loading psp_accounts/decline_code_map rows to seed the adapter
//     registry (the Go analogue of loadDeclineMaps) STILL does not
//     exist in this Go port (no phase has built that DB read yet — see
//     MIGRATION_NOTES.md); registry.New is still constructed with an
//     empty decline-map set. A later phase adding a real
//     LoadDeclineMaps(rows) caller MUST NOT block ListenAndServe on it —
//     run it in a goroutine after the listener is already up, or accept
//     a short window where NormalizeDecline returns UnmappedDecline
//     until the maps finish loading, rather than reintroducing this
//     exact bug class.
//   - routing.NewRulesRepo/NewEvaluator/NewCircuitBreaker below
//     likewise only construct in-memory Go values holding references to
//     the already-lazily-constructed pgPool/redisClient — none of them
//     perform a network round-trip at construction time either.
package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"github.com/alphapayments/payment-orchestrator/internal/adapters/registry"
	"github.com/alphapayments/payment-orchestrator/internal/adapters/solidgate"
	"github.com/alphapayments/payment-orchestrator/internal/adapters/stripe"
	"github.com/alphapayments/payment-orchestrator/internal/api"
	"github.com/alphapayments/payment-orchestrator/internal/config"
	"github.com/alphapayments/payment-orchestrator/internal/observability"
	"github.com/alphapayments/payment-orchestrator/internal/routing"
	"github.com/alphapayments/payment-orchestrator/internal/webhooks"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, "api: configuration error:")
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}

	logger := observability.NewLogger(observability.LoggerConfig{
		LogLevel:    cfg.LogLevel,
		ServiceName: cfg.ServiceName,
		Env:         cfg.Env,
	})

	shutdownTracing, err := observability.StartTracing(observability.TracerConfig{
		ServiceName:          cfg.Otel.ServiceName,
		ExporterOTLPEndpoint: cfg.Otel.ExporterOTLPEndpoint,
	})
	if err != nil {
		logger.Error("failed to start tracing", "error", err)
		os.Exit(1)
	}
	defer func() {
		_ = shutdownTracing(context.Background())
	}()

	// pgxpool.New and redis.NewClient both construct their connection
	// pool/client lazily — neither performs a network round-trip here.
	// See this file's top doc comment for why that matters.
	pgPool, err := pgxpool.New(context.Background(), cfg.Database.URL)
	if err != nil {
		logger.Error("failed to construct postgres pool", "error", err)
		os.Exit(1)
	}
	defer pgPool.Close()

	redisOpts, err := redis.ParseURL(cfg.Redis.URL)
	if err != nil {
		logger.Error("failed to parse REDIS_URL", "error", err)
		os.Exit(1)
	}
	redisClient := redis.NewClient(redisOpts)
	defer redisClient.Close()

	// Phase 2's registry — mock is always usable immediately; Stripe/
	// Solidgate credentials resolve lazily per psp_account inside
	// Resolve, not here, so there is nothing DB-dependent to await
	// before the registry is ready to use. declineMaps is empty until a
	// later phase's DB layer loads decline_code_map rows — see this
	// file's top doc comment.
	pspRegistry := registry.New(registry.Config{
		Stripe: stripe.ConfigCredentials{
			Mode:           cfg.Stripe.Mode,
			SecretKey:      cfg.Stripe.SecretKey,
			PublishableKey: cfg.Stripe.PublishableKey,
			WebhookSecret:  cfg.Stripe.WebhookSecret,
			APIVersion:     cfg.Stripe.APIVersion,
		},
		Solidgate: solidgate.ConfigCredentials{
			Mode:             cfg.Solidgate.Mode,
			PublicKey:        cfg.Solidgate.PublicKey,
			SecretKey:        cfg.Solidgate.SecretKey,
			WebhookPublicKey: cfg.Solidgate.WebhookPublicKey,
			WebhookSecretKey: cfg.Solidgate.WebhookSecretKey,
			APIBaseURL:       cfg.Solidgate.APIBaseURL,
		},
	}, nil)

	// Phase 4's routing engine, constructed here for real (this Go port
	// previously only wired the circuit breaker on its own in Phase 4;
	// Phase 5 now needs the full Evaluator for PaymentsStore.ResolveRouting).
	// logger is passed through so a Redis blip during a breaker state
	// read is visible (see circuitbreaker.go's IsAvailable bug-fix doc
	// comment, 2026-07-10) instead of silently failing open with no
	// trace of why.
	breaker := routing.NewCircuitBreaker(redisClient, routing.DefaultBreakerConfig, logger)
	routingCache := routing.NewCache(redisClient)
	rulesRepo := routing.NewRulesRepo(pgPool, routingCache)
	evaluator := routing.NewEvaluator(pgPool, rulesRepo, breaker)

	// Phase 5's webhook pipeline deps — shared by the HTTP webhook route
	// (POST /webhooks/{psp}), PgxPaymentsStore.ApplyCanonicalEvents (the
	// SAME underlying internal/webhooks.ApplyCanonicalEvents call, not a
	// duplicate — see pgpaymentsstore.go's doc comment), and (once a
	// scheduler exists — Phase 6) gap-detection.
	webhookDeps := webhooks.Deps{
		Pool:       pgPool,
		Registry:   pspRegistry,
		Metrics:    webhooks.PrometheusMetrics{},
		StableName: api.StableName,
	}

	// Phase 5: PaymentsStore/CustomersStore are now wired for real,
	// replacing every prior phase's UnimplementedPaymentsStore{}/
	// UnimplementedCustomersStore{}. See MIGRATION_NOTES.md's Phase 5
	// section for exactly what "real" means here (every method is
	// backed by a live Postgres query; ResolveRouting delegates to the
	// real *routing.Evaluator constructed above; ApplyCanonicalEvents
	// delegates to internal/webhooks.ApplyCanonicalEvents) and what, if
	// anything, is flagged as a lower-confidence area (ListPayments
	// cursor pagination, the transactions-row transaction-boundary
	// decision).
	paymentsStore := api.PgxPaymentsStore{
		Pool:      pgPool,
		Evaluator: evaluator,
		Webhooks:  webhookDeps,
	}
	customersStore := api.PgxCustomersStore{Pool: pgPool}

	// Checkout Sessions feature: CheckoutSessionsStore is implemented on
	// the SAME PgxPaymentsStore type as PaymentsStore (see
	// pgpaymentsstore.go's CreateCheckoutSession/GetCheckoutSession/
	// MarkCheckoutSessionConsumed) — reusing the one struct/Pool rather
	// than introducing a second store type, since checkout_sessions has
	// no dependency on anything PaymentsStore doesn't already depend on
	// (the same *pgxpool.Pool, nothing routing/webhooks-specific).
	checkoutSessionsStore := paymentsStore

	// Tracks every in-flight background webhook.Normalize goroutine
	// api.WebhookDeps.InFlight (below) hands out Add/Done calls for — see
	// this file's shutdown sequence, further down, for how it's used to
	// bound graceful shutdown on these goroutines too, not just in-flight
	// HTTP requests (which server.Shutdown already handles on its own).
	var webhookInFlight sync.WaitGroup

	router := api.BuildRouter(api.Deps{
		Logger: logger,
		Health: api.HealthDeps{
			Postgres: api.PgxPinger{Pool: pgPool},
			Redis:    api.RedisClientPinger{Client: redisClient},
		},
		// TokenStore/AuditLogWriter/IdempotencyStore ARE wired for
		// real against pgx (see internal/api/pgstore.go) — these three
		// tables (api_tokens, audit_log, idempotency_keys) have no
		// dependency on the routing engine or any other later phase.
		TokenStore:     api.PgxTokenStore{Pool: pgPool},
		AuditLogWriter: api.PgxAuditLogWriter{Pool: pgPool},
		Idempotency:    api.PgxIdempotencyStore{Pool: pgPool},
		Cache:          api.RedisIdempotencyCache{Client: redisClient},

		PaymentsStore:  paymentsStore,
		CustomersStore: customersStore,
		// Checkout Sessions feature — see checkoutSessionsStore's own
		// construction comment above for why this is the same
		// PgxPaymentsStore value as PaymentsStore, just referenced
		// through the narrower CheckoutSessionsStore interface here.
		CheckoutSessionsStore: checkoutSessionsStore,
		// Configurable retry/dunning policy feature: RetrySettingsStore
		// is implemented on the SAME PgxPaymentsStore type/value as
		// PaymentsStore/CheckoutSessionsStore (see
		// pgpaymentsstore.go's GetRetrySettings/UpsertRetrySettings) —
		// retry_settings has no dependency on anything PgxPaymentsStore
		// doesn't already have (the same *pgxpool.Pool), so this
		// follows the exact same "one struct, several narrow interfaces"
		// convention checkoutSessionsStore's own comment above already
		// established rather than introducing a fourth store type.
		RetrySettingsStore: paymentsStore,
		// Plans feature: PlansStore is implemented on the SAME
		// PgxPaymentsStore type/value as PaymentsStore/
		// CheckoutSessionsStore/RetrySettingsStore (see
		// pgpaymentsstore.go's CreatePlan/GetPlan/ListPlans/UpdatePlan/
		// DeletePlan) — plans has no dependency on anything
		// PgxPaymentsStore doesn't already have (the same *pgxpool.Pool),
		// so this follows the exact same "one struct, several narrow
		// interfaces" convention checkoutSessionsStore's/
		// RetrySettingsStore's own comments above already established
		// rather than introducing a fifth store type.
		PlansStore: paymentsStore,

		// AI Agents / MCP feature: AgentTokenStore is implemented on the
		// SAME PgxTokenStore value TokenStore above already uses (see
		// agent_tokens.go's CreateAgentToken/ListAgentTokens/
		// RevokeAgentToken on PgxTokenStore in pgstore.go) — one struct
		// wrapping the one api_tokens table, exposed through two narrow
		// interfaces (TokenStore for the auth middleware's Lookup,
		// AgentTokenStore for this resource's CRUD), matching every
		// other "one struct, several interfaces" store above.
		AgentTokenStore: api.PgxTokenStore{Pool: pgPool},
		// SubscriptionsPool backs POST /v1/subscriptions/{id}/cancel —
		// see subscriptions.go's top doc comment for why this route
		// takes the raw pool rather than a store interface.
		SubscriptionsPool: pgPool,
		// BillingPortalPool backs POST /v1/customers/{id}/billing-portal-
		// session — see billing_portal.go's top doc comment.
		BillingPortalPool: pgPool,

		Registry: pspRegistry,
		// Breaker: real, working circuit-breaker state against the live
		// Redis client constructed above (unchanged from Phase 4's
		// wiring, reused here for both the payments routes' own
		// recordBreakerFailure/recordBreakerSuccess call sites AND the
		// Evaluator constructed above).
		Breaker: breaker,

		// CheckoutRateLimiter: backend review fix (2026-07-10) — the two
		// unauthenticated public checkout routes had no rate limiting at
		// all (see ratelimit.go's top doc comment for the card-testing
		// attack this closes). Reuses the same live redisClient
		// constructed above, exactly like Cache/Breaker/routingCache do,
		// rather than opening a second connection pool.
		// CheckoutRateLimitConfig is left zero-valued, so
		// rateLimitPublicCheckoutRoute falls back to
		// api.DefaultPublicCheckoutRateLimitConfig (20 req/min per IP
		// per route).
		CheckoutRateLimiter: api.RedisPublicRateLimiterStore{Client: redisClient},

		// Phase 5: webhook ingress route — mounted OUTSIDE the /v1 auth
		// group by BuildRouter (see router.go's own doc comment on
		// exactly where and why).
		Webhook: api.WebhookDeps{
			Webhooks: webhookDeps,
			Logger:   logger,
			// See webhookInFlight's own doc comment below, near the
			// graceful-shutdown sequence, for why this exists.
			InFlight: &webhookInFlight,
		},

		Env: cfg.Env,
	})

	addr := fmt.Sprintf("%s:%d", cfg.HTTP.Host, cfg.HTTP.Port)
	server := &http.Server{
		Addr:    addr,
		Handler: router,
	}

	// The HTTP listener binds and starts serving immediately — nothing
	// above this point performed a blocking database round-trip. See
	// this file's top doc comment for why this ordering is load-bearing.
	go func() {
		logger.Info("api listening",
			"host", cfg.HTTP.Host,
			"port", cfg.HTTP.Port,
		)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("http server error", "error", err)
			os.Exit(1)
		}
	}()

	shutdown := make(chan os.Signal, 1)
	signal.Notify(shutdown, syscall.SIGTERM, syscall.SIGINT)
	sig := <-shutdown
	logger.Info("shutting down api", "signal", sig.String())

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		logger.Error("error during graceful shutdown", "error", err)
	}

	// BUG FIX (backend review, 2026-07-10): server.Shutdown only waits for
	// in-flight HTTP handlers to return — it has no visibility into the
	// detached webhook.Normalize goroutines internal/api/webhooks.go's
	// handleWebhook starts with context.Background() specifically so they
	// outlive the request that triggered them (see that file's own doc
	// comment on why). Without this wait, a SIGTERM here could kill the
	// process mid-Normalize on every deploy, not just an actual crash —
	// each dropped one would still self-heal via gap-detection's cron, but
	// needlessly, on a perfectly normal restart. Bounded to 5s (well under
	// this file's own signal-handling expectations and comfortably shorter
	// than the 10s already budgeted for server.Shutdown above) so one
	// genuinely stuck Normalize call can't hang the whole shutdown — if
	// the wait times out, this process exits anyway, exactly as it did
	// before this fix, just now with the common case (a handful of
	// in-flight normalizes finishing in milliseconds) handled cleanly.
	inFlightDone := make(chan struct{})
	go func() {
		webhookInFlight.Wait()
		close(inFlightDone)
	}()
	select {
	case <-inFlightDone:
	case <-time.After(5 * time.Second):
		logger.Warn("timed out waiting for in-flight webhook normalize goroutines to drain during shutdown")
	}
}
