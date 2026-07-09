package api

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/alphapayments/payment-orchestrator/internal/adapters/registry"
)

// Router is the subset of *chi.Mux's method set this package's route
// registration functions need — narrowed to an interface so
// registerHealthRoutes/registerPaymentsRoutes/registerCustomersRoutes
// are each testable against a plain chi.NewRouter() without pulling in
// the rest of BuildRouter's dependency graph. *chi.Mux satisfies this
// interface as-is (no adapter needed).
type Router interface {
	Get(pattern string, handler http.HandlerFunc)
	Post(pattern string, handler http.HandlerFunc)
}

// Deps is everything BuildRouter needs to assemble the full API —
// the Go analogue of the TS BuildAppDeps interface (src/api/server.ts).
//
// Fields intentionally absent relative to the TS BuildAppDeps, and why:
//   - workflowEngine (Hatchet): the worker/task-dispatch layer is a
//     later phase (see MIGRATION_NOTES.md); nothing in this phase
//     dispatches a task through a real queue (Phase 5's webhook
//     normalize/apply/gap-detection are plain goroutine/function calls
//     instead — see internal/webhooks's package doc comment).
//   - dev routes (registerDevRoutes): out of scope for this phase —
//     not part of the task brief's requested surface.
type Deps struct {
	Logger *slog.Logger

	Health HealthDeps

	// TokenStore backs Bearer-token authentication (internal/api/auth.go).
	TokenStore TokenStore
	// AuditLogWriter records one row per /v1/* request, matching the TS
	// onResponse audit hook. May be nil, in which case audit logging is
	// skipped entirely rather than panicking — see auth.go's doc comment.
	AuditLogWriter AuditLogWriter

	// Idempotency backs the Idempotency-Key middleware
	// (internal/api/idempotency.go).
	Idempotency IdempotencyStore
	Cache       IdempotencyCache

	// PaymentsStore/CustomersStore back the payments/customers routes.
	// Phase 5: BOTH are now wired for real in cmd/api/main.go
	// (PgxPaymentsStore/PgxCustomersStore) — see MIGRATION_NOTES.md's
	// Phase 5 section for exactly what "real" means here and what, if
	// anything, remains a known gap.
	PaymentsStore  PaymentsStore
	CustomersStore CustomersStore

	// CheckoutSessionsStore backs the checkout_sessions resource — the
	// embeddable checkout SDK's browser-safe path to tokenizing a card
	// and creating a payment without ever holding a Bearer token. See
	// checkout_sessions.go's top doc comment for the full feature
	// writeup. May be nil in a caller/test that doesn't need these
	// routes wired — registerCheckoutSessionsRoutes/
	// registerPublicCheckoutSessionRoutes' own handlers already 501 on a
	// nil Store, matching every other route in this package's
	// nil-dependency handling.
	CheckoutSessionsStore CheckoutSessionsStore

	// RetrySettingsStore backs the retry_settings resource — the
	// DB-backed, per-merchant-entity, API-configurable retry/dunning
	// policy that replaces internal/routing's DefaultRetryPolicy and
	// internal/subscriptions' DunningLadderHours package-level defaults.
	// See retry_settings.go's top doc comment for the full feature
	// writeup. May be nil (handleGetRetrySettings falls back to the
	// hardcoded defaults; handleUpsertRetrySettings 501s), matching
	// every other store field's nil-dependency handling in this struct.
	RetrySettingsStore RetrySettingsStore

	// AgentTokenStore backs the agent-tokens resource — self-serve
	// creation/listing/revocation of scoped API tokens for MCP clients
	// (see agent_tokens.go's top doc comment). May be nil, matching
	// every other store field's nil-dependency handling in this struct.
	AgentTokenStore AgentTokenStore

	// SubscriptionsPool backs the one subscriptions route
	// (POST /v1/subscriptions/{id}/cancel — see subscriptions.go's top
	// doc comment for why this is a raw *pgxpool.Pool rather than a
	// narrow store interface). May be nil, in which case the route 501s.
	SubscriptionsPool *pgxpool.Pool

	// PlansStore backs the plans resource — a merchant's configurable
	// pricing catalog (recurring/one-off plans, per-country/currency
	// price override rules, an optional trial). See plans.go's top doc
	// comment for the full feature writeup, including why this DTO
	// shape was designed to match the sibling frontend repo's
	// lib/types.ts Plan/TrialConfig/PriceOverrideRule types rather than
	// independently. May be nil (every handler in plans.go 501s on a
	// nil Store), matching every other store field's nil-dependency
	// handling in this struct.
	PlansStore PlansStore

	// Registry resolves a psp_accounts row to a ready-to-use
	// adapters.PspAdapter (Phase 2). Required — every payments route
	// that talks to a PSP goes through this.
	Registry *registry.Registry

	// Breaker records PSP call outcomes for Milestone 5's circuit
	// breaker — see payments.go's CircuitBreaker doc comment. May be
	// nil (payments.go's recordBreakerFailure/recordBreakerSuccess
	// tolerate a nil Breaker).
	Breaker CircuitBreaker

	// Webhook is everything needed to mount POST /webhooks/{psp} — see
	// RegisterWebhookRoutes below. May be zero-valued if the caller
	// doesn't want webhook routes mounted at all (e.g. a test that only
	// exercises /v1 routes), in which case RegisterWebhookRoutes should
	// simply not be called.
	Webhook WebhookDeps

	// Env gates dev-only routes, matching the TS
	// `if (deps.config.env !== 'production')` check in server.ts. Not
	// used by anything in this phase (no dev routes are registered
	// yet) but threaded through now so a later phase adding them doesn't
	// need to touch BuildRouter's signature again.
	Env string
}

// BuildRouter assembles the full chi.Router: middleware chain, then
// every route group, mirroring buildApp's registration order in
// src/api/server.ts as closely as this phase's narrower scope allows.
//
// Middleware chain order (outermost first) and why, compared to
// Fastify's plugin/hook registration order:
//
//  1. middleware.RequestID — assigns a request id used by every
//     subsequent layer (logging, audit log, error responses). Fastify's
//     analogue is registerRequestId(app), which server.ts calls before
//     any route registration; chi's RequestID middleware is likewise
//     registered before any route so every handler and later
//     middleware can read it via middleware.GetReqID(ctx).
//  2. requestLoggingMiddleware (this package) — logs one line per
//     request via slog, the Go analogue of Fastify's built-in
//     disableRequestLogging:false behavior (server.ts sets this
//     explicitly on the Fastify constructor, which logs a line per
//     request through the same pino instance passed as loggerInstance).
//     Placed right after RequestID so the log line can include it.
//  3. recoverMiddleware (this package) — panic recovery, translating
//     any panic into a 500 rather than crashing the process. Fastify
//     has no direct equivalent middleware step here because Fastify's
//     own dispatcher already catches a thrown error/rejected promise
//     from any handler and routes it to app.setErrorHandler
//     (server.ts's app.setErrorHandler call) without the process
//     crashing — Go's net/http has no built-in panic recovery, so this
//     middleware exists specifically to replicate that Fastify
//     guarantee, not to add new behavior beyond it. Placed after
//     logging (not before) so a panic still gets the access-log line
//     for the request that triggered it, then is placed before Auth/
//     business logic so a panic in ANY handler downstream is caught by
//     one recovery point, mirroring Fastify's single shared error
//     handler.
//  4. Auth (internal/api/auth.go's Middleware) — the Go analogue of
//     registerAuth(app, {db}) — guards every /v1/* route. In Fastify
//     this is a preHandler hook registered once, after health/webhook
//     routes but conceptually "in front of" every /v1/* handler,
//     because Fastify's preHandler hooks run for every route registered
//     AFTER the hook, and registerAuth is called after
//     registerHealthRoutes/registerWebhookRoutes but before
//     registerPaymentsRoutes/registerCustomersRoutes in server.ts. This
//     Go port reproduces the same effective scoping using chi's
//     mux.Route("/v1", func(r chi.Router) { r.Use(authMiddleware); ... })
//     grouping instead of a global preHandler with an internal
//     `if (!request.url.startsWith('/v1/')) return;` guard — chi's
//     route-group scoping expresses "only applies under /v1" directly,
//     rather than needing every hook to re-check the URL prefix itself.
//     This is a deliberate structural improvement enabled by chi, not a
//     behavior change: unauthenticated routes (/healthz, /readyz, and
//     — Phase 5 — POST /webhooks/{psp}, which authenticates via PSP
//     signature verification instead of a Bearer token, exactly like
//     the TS source) never even pass through the auth middleware in
//     either version.
//
// Not reproduced from server.ts, and why:
//   - @fastify/sensible (deps.register(sensible)) — supplies Fastify
//     reply helpers (reply.notFound(), etc.); this Go port's handlers
//     write RFC 7807 problem+json bodies directly (see problem.go),
//     which is the only thing server.ts actually used sensible for at
//     the call sites this phase ports.
//   - registerOpenApi / @fastify/swagger(-ui) — OpenAPI/Swagger codegen
//     is explicitly noted as PENDING in MIGRATION_NOTES.md's Phase 3
//     section, per the task brief's instruction that this phase does
//     not need to reproduce it.
//   - app.setErrorHandler's central error-to-status-code mapping —
//     ported as problem.go's WriteProblem plus each handler mapping its
//     own sentinel errors (MissingIdempotencyKeyError -> 400,
//     IdempotencyConflictError -> 409, etc.) inline, since Go has no
//     single try/catch boundary equivalent to Fastify's setErrorHandler
//     — recoverMiddleware only catches panics, not returned errors, so
//     each handler is responsible for translating its own error values
//     to the right problem+json response, matching the TS
//     setErrorHandler's own instanceof-chain one-for-one.
func BuildRouter(deps Deps) *chi.Mux {
	r := chi.NewRouter()

	r.Use(middleware.RequestID)
	r.Use(requestLoggingMiddleware(deps.Logger))
	r.Use(recoverMiddleware(deps.Logger))

	registerHealthRoutes(r, deps.Health)

	// Phase 5: POST /webhooks/{psp} — registered at the top level,
	// BEFORE the /v1 group is even constructed, and deliberately NOT
	// nested inside r.Route("/v1", ...) below. This is the chi-idiomatic
	// equivalent of route.ts's own registration order in server.ts
	// (registerWebhookRoutes is called before registerAuth) — webhook
	// requests authenticate via PSP signature verification
	// (internal/webhooks.Ingest), never via the Bearer-token
	// AuthMiddleware, so they must never pass through it at all, not
	// just be exempted from it after the fact.
	registerWebhookRoutes(r, deps.Webhook)

	// Checkout Sessions feature: GET /checkout/{id}/public and
	// POST /checkout/{id}/confirm — registered at the top level, BEFORE
	// the /v1 group, for the exact same reason as
	// registerWebhookRoutes above: the caller is the end user's
	// BROWSER, which never holds a Bearer token (it authenticates via
	// the checkout session's own client secret instead — see
	// checkout_sessions.go's authenticateCheckoutSession), so these two
	// routes must never pass through authMW.Middleware at all. See
	// registerPublicCheckoutSessionRoutes's own doc comment for why
	// these live at a sibling "/checkout/..." prefix rather than nested
	// under "/v1/checkout-sessions/{id}/..." — flagged there as the
	// single riskiest unverified routing decision in this change.
	checkoutSessionsDeps := CheckoutSessionsRouteDeps{
		Store:         deps.CheckoutSessionsStore,
		PaymentsStore: deps.PaymentsStore,
		Registry:      deps.Registry,
		Idempotency:   deps.Idempotency,
		Cache:         deps.Cache,
		Logger:        deps.Logger,
		Breaker:       deps.Breaker,
	}
	registerPublicCheckoutSessionRoutes(r, checkoutSessionsDeps)

	authMW := NewAuthMiddleware(AuthDeps{
		Tokens: deps.TokenStore,
		Audit:  deps.AuditLogWriter,
		Logger: deps.Logger,
	})

	r.Route("/v1", func(v1 chi.Router) {
		v1.Use(authMW.Middleware)

		registerPaymentsRoutes(v1, PaymentsRouteDeps{
			Store:       deps.PaymentsStore,
			Registry:    deps.Registry,
			Idempotency: deps.Idempotency,
			Cache:       deps.Cache,
			Logger:      deps.Logger,
			Breaker:     deps.Breaker,
		})
		// POST /v1/checkout-sessions — Bearer-authenticated (the
		// MERCHANT's own server calls this one, unlike the two routes
		// registered above), so it belongs inside this /v1 group
		// exactly like registerPaymentsRoutes/registerCustomersRoutes,
		// automatically picking up authMW.Middleware.
		registerCheckoutSessionsRoutes(v1, checkoutSessionsDeps)
		registerCustomersRoutes(v1, CustomersRouteDeps{
			Store: deps.CustomersStore,
		})
		// GET/PUT /v1/retry-settings — Bearer-authenticated exactly like
		// every other /v1/* route above; see retry_settings.go's
		// registerRetrySettingsRoutes doc comment for why this resource
		// has no unauthenticated/browser-facing routes the way
		// checkout-sessions does.
		registerRetrySettingsRoutes(v1, RetrySettingsRouteDeps{
			Store: deps.RetrySettingsStore,
		})
		// POST/GET/GET-by-id/PATCH/DELETE /v1/plans — Bearer-
		// authenticated exactly like every other /v1/* route above; see
		// plans.go's registerPlansRoutes doc comment for why the
		// mutating routes here deliberately do NOT require an
		// Idempotency-Key the way payments/checkout-sessions do.
		registerPlansRoutes(v1, PlansRouteDeps{
			Store: deps.PlansStore,
		})
		// POST/GET/DELETE /v1/agent-tokens — Bearer-authenticated exactly
		// like every other /v1/* route above; see agent_tokens.go's top
		// doc comment for the MCP-agent-token feature this backs.
		registerAgentTokensRoutes(v1, AgentTokensRouteDeps{
			Store: deps.AgentTokenStore,
		})
		// POST /v1/subscriptions/{id}/cancel — Bearer-authenticated,
		// scope-checked (RequireWriteScope); see subscriptions.go's top
		// doc comment.
		registerSubscriptionsRoutes(v1, SubscriptionsRouteDeps{
			Pool: deps.SubscriptionsPool,
		})
	})

	return r
}

// requestLoggingMiddleware logs one line per request (method, path,
// status, duration, request id) via slog — the Go analogue of
// Fastify's disableRequestLogging: false access-log line, which
// server.ts opts into explicitly on the Fastify constructor.
func requestLoggingMiddleware(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)

			next.ServeHTTP(ww, r)

			logger.Info("request",
				"request_id", middleware.GetReqID(r.Context()),
				"method", r.Method,
				"path", r.URL.Path,
				"status", ww.Status(),
				"duration_ms", time.Since(start).Milliseconds(),
			)
		})
	}
}

// recoverMiddleware catches any panic from a downstream handler and
// responds 500 rather than letting the panic crash the process — the
// Go analogue of Fastify's built-in behavior of catching a thrown
// error from any handler and routing it to app.setErrorHandler instead
// of crashing (server.ts's app.setErrorHandler; note that
// setErrorHandler handles both thrown errors AND rejected promises —
// this middleware only needs to handle the panic case, since a Go
// handler "throwing" is a panic; a Go handler *returning* an error
// value is handled by each route's own inline error-to-status mapping,
// not by this middleware).
func recoverMiddleware(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if rec := recover(); rec != nil {
					logger.Error("panic recovered",
						"request_id", middleware.GetReqID(r.Context()),
						"panic", rec,
					)
					WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}

// contextKey is a private type for context values set by this
// package, avoiding collisions with keys set by other packages (the
// standard Go idiom; the TS equivalent is the `declare module 'fastify'
// { interface FastifyRequest { auth?: AuthContext } }` ambient
// augmentation in auth.ts, which this package's context-value approach
// replaces since Go has no equivalent way to augment a request type).
type contextKey string

const authContextKey contextKey = "api.auth"

// authFromContext retrieves the AuthContext a preceding Auth
// middleware stored on the request context. The second return value
// is false if no auth context is present (should never happen for a
// route registered under the /v1 group, since AuthMiddleware always
// runs first and always either sets this or short-circuits with 401).
func authFromContext(ctx context.Context) (AuthContext, bool) {
	v, ok := ctx.Value(authContextKey).(AuthContext)
	return v, ok
}
