package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/alphapayments/payment-orchestrator/internal/adapters"
	"github.com/alphapayments/payment-orchestrator/internal/adapters/registry"
	"github.com/alphapayments/payment-orchestrator/internal/domain"
)

// This file adds the checkout_sessions resource — the browser-safe
// credential the new embeddable checkout SDK (a parallel workstream)
// needs to tokenize a card and submit a payment WITHOUT ever holding
// the merchant's Bearer API token. See
// db/migrations/1735777200000_checkout-sessions.up.sql's doc comment
// for the full flow description and MIGRATION_NOTES.md's Checkout
// Sessions section for the security-model writeup (why the plaintext
// secret is never stored, the constant-time-compare + 404-not-410
// ordering, and this port's own confidence-tiered list of what's least
// verified here without a compiler).
//
// This file deliberately follows payments.go's established shapes
// (narrow store interface, PaymentRow-style DTOs, WithIdempotencyKey
// for the mutating confirm call, WriteProblem for every error path)
// rather than inventing new conventions — the one genuinely new thing
// here is that two of this file's three routes are NOT Bearer-
// authenticated at all (see router.go's wiring), because the caller is
// the END USER's browser, which structurally cannot hold that token.

// CheckoutSessionRow is the minimal shape this file needs back from
// CheckoutSessionsStore — mirrors the checkout_sessions table exactly,
// narrowed to the columns actually read below (matching this codebase's
// established PaymentRow/AttemptRow convention).
type CheckoutSessionRow struct {
	ID               string
	MerchantEntityID string
	ProductID        string
	CustomerID       string
	AmountMinor      int64
	Currency         string
	CitMit           string
	PspAccountID     string
	ClientSecretHash string
	Status           string
	PaymentID        *string
	CreatedAt        time.Time
	ExpiresAt        time.Time
}

// CreateCheckoutSessionRow is the input to
// CheckoutSessionsStore.CreateCheckoutSession — every column the INSERT
// needs, computed by the handler before the store is ever called
// (matching CreatePaymentRow's own "handler resolves everything, store
// just persists it" division of labor).
type CreateCheckoutSessionRow struct {
	MerchantEntityID string
	ProductID        string
	CustomerID       string
	AmountMinor      int64
	Currency         string
	CitMit           string
	PspAccountID     string
	ClientSecretHash string
	ExpiresAt        time.Time
}

// CheckoutSessionsStore is the minimal persistence capability the
// checkout-sessions routes need — a separate, narrow interface (this
// codebase's standing convention: see PaymentsStore/CustomersStore each
// being their own interface rather than one shared "Store" grab-bag)
// rather than folded into PaymentsStore, since a checkout session is
// its own resource with its own lifecycle (open -> consumed/expired),
// not a payments-table concern.
type CheckoutSessionsStore interface {
	CreateCheckoutSession(ctx context.Context, input CreateCheckoutSessionRow) (CheckoutSessionRow, error)
	GetCheckoutSession(ctx context.Context, id string) (CheckoutSessionRow, bool, error)
	MarkCheckoutSessionConsumed(ctx context.Context, id string, paymentID string) error
}

// CheckoutSessionsRouteDeps is everything the three checkout-sessions
// handlers need. Deliberately a superset of what any single handler
// uses — POST /v1/checkout-sessions only needs PaymentsStore (for
// ResolveCustomerID/ResolveRouting) plus its own Store, while
// POST .../confirm additionally needs Registry/Idempotency/Cache/Breaker
// to run the same attempt-creation flow createPaymentHandler runs. One
// combined deps struct (rather than three narrower ones) reads cleaner
// here specifically because router.go constructs exactly one of these
// and threads it to all three registration calls — see
// registerCheckoutSessionsRoutes below.
type CheckoutSessionsRouteDeps struct {
	Store         CheckoutSessionsStore
	PaymentsStore PaymentsStore
	Registry      *registry.Registry
	Idempotency   IdempotencyStore
	Cache         IdempotencyCache
	Logger        *slog.Logger
	Breaker       CircuitBreaker
	// RateLimiter backs the per-client-IP rate limit
	// registerPublicCheckoutSessionRoutes applies to BOTH public routes
	// (see ratelimit.go's top doc comment for why this exists — POST
	// .../confirm actually charges a card and is otherwise gated only by
	// clientSecret possession). nil is handled explicitly (rate limiting
	// is skipped, not a panic) so a caller/test that doesn't wire Redis
	// still works, but cmd/api/main.go's real boot path always wires this
	// — see that file's construction of CheckoutSessionsRouteDeps.
	RateLimiter PublicRateLimiterStore
	// RateLimitConfig: zero-value falls back to
	// DefaultPublicCheckoutRateLimitConfig inside
	// rateLimitPublicCheckoutRoute, so leaving this unset is the normal,
	// supported case.
	RateLimitConfig PublicCheckoutRateLimitConfig
}

// checkoutSessionTTL is how long a checkout session stays open before
// expiring — 15 minutes, matching a typical single checkout-page
// session length (long enough for a customer to enter card details and
// complete a 3DS challenge; short enough that a leaked client secret
// isn't useful for long).
const checkoutSessionTTL = 15 * time.Minute

// CreateCheckoutSessionRequest mirrors POST /v1/checkout-sessions's
// wire shape. CustomerID/CustomerEmail follow CreatePaymentRequest's own
// exact pattern (either may be given; resolved via
// PaymentsStore.ResolveCustomerID, which itself requires at least one —
// see that method's own doc comment). CitMit defaults to "cit" when
// empty, matching handleCreatePayment's own default.
type CreateCheckoutSessionRequest struct {
	CustomerID    *string  `json:"customerId,omitempty"`
	CustomerEmail *string  `json:"customerEmail,omitempty"`
	Amount        MoneyDTO `json:"amount"`
	CitMit        string   `json:"citMit"`
}

// CreateCheckoutSessionResponse mirrors POST /v1/checkout-sessions's
// response shape. ClientSecret is the ONLY time the plaintext secret is
// ever returned by this API — every subsequent read
// (GetCheckoutSession/the store) only ever sees/stores its SHA-256 hash.
type CreateCheckoutSessionResponse struct {
	ID           string   `json:"id"`
	ClientSecret string   `json:"clientSecret"`
	ExpiresAt    string   `json:"expiresAt"`
	Amount       MoneyDTO `json:"amount"`
}

// PublicConfigDTO mirrors adapters.PublicConfig's wire shape exactly.
type PublicConfigDTO struct {
	PSP                string  `json:"psp"`
	PublishableKey     string  `json:"publishableKey"`
	MerchantIdentifier *string `json:"merchantIdentifier,omitempty"`
}

// PublicCheckoutSessionResponse mirrors GET
// /checkout/{id}/public's response shape (see
// registerPublicCheckoutSessionRoutes's doc comment for exactly why
// this route lives at this sibling path rather than nested under
// /v1/checkout-sessions/{id}/public) — everything the
// browser needs to initialize the correct PSP's tokenization UI, and
// nothing else (no merchant/customer/product ids — Non-negotiable #8-
// adjacent reasoning: this response is readable by anyone holding the
// client secret, so it carries only what the checkout widget itself
// needs to render and tokenize a card).
type PublicCheckoutSessionResponse struct {
	ID           string          `json:"id"`
	Amount       MoneyDTO        `json:"amount"`
	Status       string          `json:"status"`
	ExpiresAt    string          `json:"expiresAt"`
	PSP          string          `json:"psp"`
	PublicConfig PublicConfigDTO `json:"publicConfig"`
}

// ConfirmCheckoutSessionRequest mirrors POST
// /checkout/{id}/confirm's wire shape.
type ConfirmCheckoutSessionRequest struct {
	ClientSecret     string `json:"clientSecret"`
	PaymentMethodRef string `json:"paymentMethodRef"`
}

// registerCheckoutSessionsRoutes registers POST /v1/checkout-sessions —
// the one Bearer-authenticated route in this file. Called from inside
// router.go's r.Route("/v1", ...) block, alongside
// registerPaymentsRoutes/registerCustomersRoutes, so it goes through
// authMW.Middleware exactly like every other /v1/* route.
func registerCheckoutSessionsRoutes(r chi.Router, deps CheckoutSessionsRouteDeps) {
	r.Post("/checkout-sessions", handleCreateCheckoutSession(deps))
}

// registerPublicCheckoutSessionRoutes registers the two clientSecret-
// authenticated routes: GET .../public and POST .../confirm. Called
// from router.go BEFORE the /v1 route group is even constructed —
// mirroring registerWebhookRoutes's exact placement and rationale (see
// router.go's BuildRouter doc comment) — because the caller here is the
// end user's BROWSER, which never holds a Bearer token, so these routes
// must never pass through authMW.Middleware at all, not merely be
// exempted from it after the fact.
//
// ROUTING RISK, FLAGGED EXPLICITLY (see this task's final report and
// MIGRATION_NOTES.md's Checkout Sessions section for the fuller
// writeup): these two routes are mounted at a SIBLING path prefix,
// "/checkout/{id}/public" and "/checkout/{id}/confirm" — deliberately
// NOT under "/v1/checkout-sessions/{id}/...", even though that would
// read more RESTfully as "the public view of the same resource
// POST /v1/checkout-sessions creates." The reason is chi routing
// precedence: this port's author could not verify, without a working Go
// toolchain, whether chi's radix tree lets a literal path registered at
// the top level (e.g. "/v1/checkout-sessions/{id}/public") take
// precedence over — or even coexist cleanly with — the "/v1" prefix
// ALSO being registered as its own r.Route(...) group carrying
// authMW.Middleware. chi's own documentation states literal segments
// win over wildcard segments at the same tree depth, which suggests
// this WOULD have worked (much like registerWebhookRoutes's
// "/webhooks/{psp}" already coexists with "/v1/..." at the top level
// today, just under a totally distinct top-level segment rather than
// nested one level inside "/v1"), but "/v1" being both a literal prefix
// segment AND a chi sub-router mounted via r.Route is a materially
// different case than two disjoint top-level literal segments, and this
// port's author was not confident enough in that distinction to bet a
// security-sensitive, unauthenticated route on it without a compiler
// and integration test to check. Using a disjoint top-level prefix
// ("/checkout/...") sidesteps the question entirely at the cost of a
// slightly less RESTful URL shape — correctness over aesthetics here,
// exactly per this task's own instruction. RE-VERIFY THIS FIRST once a
// real Go toolchain is available: if nesting under /v1 turns out to
// route cleanly, moving these two routes there is a pure win with no
// other code changes required (CheckoutSessionsRouteDeps/the handlers
// themselves are unaffected either way).
func registerPublicCheckoutSessionRoutes(r chi.Router, deps CheckoutSessionsRouteDeps) {
	// Fixed 2026-07-10 (backend review): both routes are wrapped in the
	// per-client-IP rate limit ratelimit.go defines — see
	// CheckoutSessionsRouteDeps.RateLimiter's doc comment for the full
	// rationale (POST .../confirm charges a real card and was otherwise
	// unrate-limited, a card-testing/carding risk).
	r.Get("/checkout/{id}/public", rateLimitPublicCheckoutRoute(
		deps.RateLimiter, deps.RateLimitConfig, "get-public", handleGetPublicCheckoutSession(deps)))
	r.Post("/checkout/{id}/confirm", rateLimitPublicCheckoutRoute(
		deps.RateLimiter, deps.RateLimitConfig, "post-confirm", handleConfirmCheckoutSession(deps)))
}

func serializeCheckoutSession(s CheckoutSessionRow) CreateCheckoutSessionResponse {
	return CreateCheckoutSessionResponse{
		ID:        s.ID,
		ExpiresAt: s.ExpiresAt.UTC().Format(time.RFC3339Nano),
		Amount:    MoneyDTO{MinorUnits: s.AmountMinor, Currency: s.Currency},
	}
}

// generateClientSecret returns a cryptographically random client secret
// ("cs_live_" + 32 URL-safe base64 characters, no padding) and its
// SHA-256 hex digest — the only thing ever persisted (see this file's
// top doc comment and the migration's own doc comment for why). Uses
// crypto/rand, never math/rand, exactly matching auth.ts's
// generateApiToken's own use of the OS CSPRNG for a bearer-token-
// equivalent value.
func generateClientSecret() (secret string, hash string, err error) {
	buf := make([]byte, 24) // 24 raw bytes -> 32 base64url characters, no padding
	if _, err := rand.Read(buf); err != nil {
		return "", "", err
	}
	secret = "cs_live_" + base64.RawURLEncoding.EncodeToString(buf)
	sum := sha256.Sum256([]byte(secret))
	hash = hex.EncodeToString(sum[:])
	return secret, hash, nil
}

func hashClientSecret(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

// handleCreateCheckoutSession implements POST /v1/checkout-sessions —
// Bearer-authenticated. Mirrors handleCreatePayment/createPaymentHandler's
// own shape: resolve customerId, resolve routing ONCE (the whole point
// of this resource is pinning that routing decision so
// GET .../public and POST .../confirm never have to re-run it), generate
// and hash a client secret, persist, respond 201 with the plaintext
// secret — the one and only time it is ever returned.
func handleCreateCheckoutSession(deps CheckoutSessionsRouteDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth, _ := authFromContext(r.Context())

		var body CreateCheckoutSessionRequest
		if !decodeJSONBody(w, r, &body) {
			return
		}
		if body.CustomerID == nil && body.CustomerEmail == nil {
			WriteProblem(w, http.StatusBadRequest, "Validation failed", "customerId or customerEmail is required")
			return
		}
		if body.CitMit == "" {
			body.CitMit = "cit"
		}
		if body.Amount.Currency == "" {
			WriteProblem(w, http.StatusBadRequest, "Validation failed", "amount.currency: required")
			return
		}
		// handleCreatePayment (payments.go) has this same gap — a
		// negative/zero amount is currently only caught by the
		// checkout_sessions table's own amount_minor_units >= 0 CHECK
		// constraint, surfacing as an opaque 500 rather than a 400.
		// Validated explicitly here rather than left to the DB, since
		// this is new code and the fix is one `if` — payments.go's own
		// pre-existing gap is left alone to avoid an unrelated change to
		// a working, already-tested handler.
		if body.Amount.MinorUnits < 0 {
			WriteProblem(w, http.StatusBadRequest, "Validation failed", "amount.minorUnits: must be >= 0")
			return
		}

		if deps.Store == nil || deps.PaymentsStore == nil {
			WriteProblem(w, http.StatusNotImplemented, "Not implemented", ErrNotImplemented.Error())
			return
		}

		ctx := r.Context()

		customerID, err := deps.PaymentsStore.ResolveCustomerID(ctx, auth.MerchantEntityID, body.CustomerID, body.CustomerEmail)
		if err != nil {
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}

		// Resolve routing ONCE, up front — this is the entire reason
		// checkout_sessions exists as its own row rather than the SDK
		// just calling POST /v1/payments directly: the browser needs to
		// learn which PSP/publishable key to tokenize against BEFORE it
		// has a paymentMethodRef, and POST .../confirm below reuses this
		// EXACT psp_account_id rather than re-resolving routing, so the
		// PSP the browser tokenized against is guaranteed to be the PSP
		// that actually charges the card.
		routingDecision, err := deps.PaymentsStore.ResolveRouting(ctx, auth.ProductID, body.Amount.Currency, body.CitMit, "card")
		if err != nil {
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}

		clientSecret, clientSecretHash, err := generateClientSecret()
		if err != nil {
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}

		session, err := deps.Store.CreateCheckoutSession(ctx, CreateCheckoutSessionRow{
			MerchantEntityID: auth.MerchantEntityID,
			ProductID:        auth.ProductID,
			CustomerID:       customerID,
			AmountMinor:      body.Amount.MinorUnits,
			Currency:         body.Amount.Currency,
			CitMit:           body.CitMit,
			PspAccountID:     routingDecision.PspAccountID,
			ClientSecretHash: clientSecretHash,
			ExpiresAt:        time.Now().Add(checkoutSessionTTL),
		})
		if err != nil {
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}

		resp := serializeCheckoutSession(session)
		resp.ClientSecret = clientSecret
		writeJSON(w, http.StatusCreated, resp)
	}
}

// authenticateCheckoutSession looks up a checkout session by id and
// verifies the supplied client secret against its stored hash — shared
// by both clientSecret-authenticated handlers below. Returns
// (row, true) only once the secret has been proven correct; the caller
// is responsible for the status/expiry check AFTER this returns, never
// before — see this function's own doc comment on ordering.
//
// SECURITY-CRITICAL ORDERING, matching this task's explicit instruction
// and MIGRATION_NOTES.md's Checkout Sessions section: the secret is
// checked BEFORE anything about the session's status/expiry is
// examined, and a wrong secret and a nonexistent session id produce the
// EXACT SAME 404 response (never a 410, never a different message) —
// so a caller cannot distinguish "this session id doesn't exist" from
// "this session exists but you guessed the wrong secret" from "this
// session exists, is expired/consumed, AND you have the wrong secret."
// Only once the secret is proven correct does this function return
// success, and only THEN do the two callers below check status/expiry
// and potentially return 410 — a 410 is therefore itself a signal that
// the caller already knows the correct secret, which is fine to leak
// (it doesn't help an attacker who doesn't already have the secret).
func authenticateCheckoutSession(ctx context.Context, store CheckoutSessionsStore, id string, clientSecret string) (CheckoutSessionRow, bool) {
	if clientSecret == "" {
		return CheckoutSessionRow{}, false
	}
	session, found, err := store.GetCheckoutSession(ctx, id)
	if err != nil || !found {
		return CheckoutSessionRow{}, false
	}
	suppliedHash := hashClientSecret(clientSecret)
	// crypto/subtle.ConstantTimeCompare requires equal-length slices to
	// be meaningful — both operands here are always 64-character hex
	// SHA-256 digests (this package's own hashClientSecret/
	// generateClientSecret produce nothing else), so this never leaks
	// timing information through slice length either.
	if subtle.ConstantTimeCompare([]byte(suppliedHash), []byte(session.ClientSecretHash)) != 1 {
		return CheckoutSessionRow{}, false
	}
	return session, true
}

func writeCheckoutSessionNotFound(w http.ResponseWriter) {
	WriteProblem(w, http.StatusNotFound, "Checkout session not found", "")
}

// isCheckoutSessionUsable reports whether session is still open and
// unexpired — the ONLY two conditions POST .../confirm and
// GET .../public require, checked identically by both (a 410 Gone from
// either handler means the same thing: the secret was correct, but this
// session cannot be used anymore).
func isCheckoutSessionUsable(session CheckoutSessionRow) bool {
	return session.Status == "open" && time.Now().Before(session.ExpiresAt)
}

func writeCheckoutSessionGone(w http.ResponseWriter) {
	WriteProblem(w, http.StatusGone, "Checkout session is no longer open", "")
}

// handleGetPublicCheckoutSession implements
// GET /checkout/{id}/public — NOT Bearer-authenticated (see
// registerPublicCheckoutSessionRoutes's doc comment for exactly where
// and why this is mounted outside the /v1 auth group). Authenticates
// via the X-Checkout-Session-Secret header (primary, as of the Stripe
// integration audit's Task #321e fix — the SDK now sends the secret
// this way) or ?clientSecret= (secondary/legacy fallback, kept only
// for backward compatibility with any SDK build still in the field
// during rollout; a query-string secret leaks into server access
// logs, browser history, and Referer headers, so no caller should
// rely on this path going forward).
func handleGetPublicCheckoutSession(deps CheckoutSessionsRouteDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		clientSecret := r.Header.Get("X-Checkout-Session-Secret")
		if clientSecret == "" {
			clientSecret = r.URL.Query().Get("clientSecret")
		}

		if deps.Store == nil || deps.Registry == nil {
			WriteProblem(w, http.StatusNotImplemented, "Not implemented", ErrNotImplemented.Error())
			return
		}

		session, ok := authenticateCheckoutSession(r.Context(), deps.Store, id, clientSecret)
		if !ok {
			writeCheckoutSessionNotFound(w)
			return
		}
		if !isCheckoutSessionUsable(session) {
			writeCheckoutSessionGone(w)
			return
		}

		pspAccount, err := deps.PaymentsStore.GetPspAccount(r.Context(), session.PspAccountID)
		if err != nil {
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}
		adapter, err := deps.Registry.Resolve(pspAccount.toRegistryAccount())
		if err != nil {
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}

		publicConfig := adapter.PublicConfig()
		writeJSON(w, http.StatusOK, PublicCheckoutSessionResponse{
			ID:        session.ID,
			Amount:    MoneyDTO{MinorUnits: session.AmountMinor, Currency: session.Currency},
			Status:    session.Status,
			ExpiresAt: session.ExpiresAt.UTC().Format(time.RFC3339Nano),
			PSP:       pspAccount.PSP,
			PublicConfig: PublicConfigDTO{
				PSP:                publicConfig.PSP,
				PublishableKey:     publicConfig.PublishableKey,
				MerchantIdentifier: publicConfig.MerchantIdentifier,
			},
		})
	}
}

// handleConfirmCheckoutSession implements
// POST /checkout/{id}/confirm — NOT Bearer-authenticated, same
// clientSecret model as the GET above. On success, runs essentially the
// same attempt-creation flow createPaymentHandler runs in payments.go,
// EXCEPT every identifying value (CustomerID, ProductID/
// MerchantEntityID, Amount, Currency, CitMit, and — critically —
// PspAccountID) is sourced from the session row itself, never from a
// Bearer auth context (there is none here) and never by re-running
// ResolveRouting (the whole point of this resource: confirm must charge
// the SAME psp_account the browser already tokenized against via
// GET .../public, not whatever routing might pick now).
//
// DUPLICATION NOTE, deliberate: the attempt-creation block below
// (UpsertPaymentMethod -> adapter.CreatePayment -> RecordAttempt ->
// ApplyCanonicalEvents -> breaker bookkeeping) duplicates roughly the
// same ~30 lines createPaymentHandler already has in payments.go,
// rather than factoring a shared helper out of both. This is a
// deliberate choice, not an oversight: refactoring createPaymentHandler
// (a working, already-tested handler) to extract a shared helper is
// exactly the kind of change this task's brief flags as risky without a
// compiler to verify the refactor didn't subtly change payments.go's own
// behavior or break its existing test coverage. Duplicating ~30 lines
// with this comment is the safer of the two options given that
// constraint — if a later phase has a real Go toolchain in hand, this
// is a good, low-risk candidate for exactly that refactor then.
func handleConfirmCheckoutSession(deps CheckoutSessionsRouteDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")

		var body ConfirmCheckoutSessionRequest
		if !decodeJSONBody(w, r, &body) {
			return
		}
		if body.PaymentMethodRef == "" {
			WriteProblem(w, http.StatusBadRequest, "Validation failed", "paymentMethodRef: required")
			return
		}

		if deps.Store == nil || deps.PaymentsStore == nil || deps.Registry == nil {
			WriteProblem(w, http.StatusNotImplemented, "Not implemented", ErrNotImplemented.Error())
			return
		}

		session, ok := authenticateCheckoutSession(r.Context(), deps.Store, id, body.ClientSecret)
		if !ok {
			writeCheckoutSessionNotFound(w)
			return
		}
		if !isCheckoutSessionUsable(session) {
			writeCheckoutSessionGone(w)
			return
		}

		// The session id itself is the idempotency key — chosen
		// specifically so POST .../confirm is naturally safe to retry
		// (a flaky network on the browser side, a duplicate tap of
		// "pay now") WITHOUT requiring the browser to generate and
		// manage its own Idempotency-Key header the way a Bearer-
		// authenticated server-to-server caller does for
		// POST /v1/payments. A given checkout session can only ever
		// confirm once (enforced by WithIdempotencyKey's own
		// insert-or-replay semantics, the same guarantee
		// POST /v1/payments relies on), so reusing the session id this
		// way is exactly as strong an idempotency key as a
		// purpose-generated one would be.
		idemKey := checkoutSessionIdempotencyKey(session.ID)

		outcome, err := WithIdempotencyKey(
			r.Context(),
			IdempotencyDeps{Store: deps.Idempotency, Cache: deps.Cache},
			session.ProductID,
			idemKey,
			IdempotentRequestDescriptor{Method: r.Method, Path: r.URL.Path, Body: body},
			func(ctx context.Context) (IdempotentResult, error) {
				return confirmCheckoutSessionHandler(ctx, deps, session, body)
			},
		)
		writeIdempotentOutcomeOrError(w, outcome, err)
	}
}

// confirmCheckoutSessionHandler is the closure passed to
// WithIdempotencyKey by handleConfirmCheckoutSession — see that
// function's doc comment for the full rationale of what's deliberately
// duplicated from createPaymentHandler and why.
func confirmCheckoutSessionHandler(
	ctx context.Context,
	deps CheckoutSessionsRouteDeps,
	session CheckoutSessionRow,
	body ConfirmCheckoutSessionRequest,
) (IdempotentResult, error) {
	pspAccount, err := deps.PaymentsStore.GetPspAccount(ctx, session.PspAccountID)
	if err != nil {
		return IdempotentResult{}, err
	}
	adapter, err := deps.Registry.Resolve(pspAccount.toRegistryAccount())
	if err != nil {
		return IdempotentResult{}, err
	}

	// Reuses PaymentsStore.CreatePayment so the resulting row lives in
	// the exact same `payments` table serializePayment already knows how
	// to read/serialize — a checkout-session-confirmed payment is a
	// completely ordinary payment from every other route's point of
	// view (GET /v1/payments/:id, capture/void/refund, webhooks) once
	// this call returns; nothing downstream needs to know it originated
	// from a checkout session rather than a direct POST /v1/payments
	// call.
	payment, err := deps.PaymentsStore.CreatePayment(ctx, CreatePaymentRow{
		MerchantEntityID: session.MerchantEntityID,
		ProductID:        session.ProductID,
		CustomerID:       session.CustomerID,
		AmountMinor:      session.AmountMinor,
		Currency:         session.Currency,
		CitMit:           session.CitMit,
		RoutingDecision:  RoutingDecision{PspAccountID: session.PspAccountID},
		IdempotencyKey:   checkoutSessionIdempotencyKey(session.ID),
	})
	if err != nil {
		return IdempotentResult{}, err
	}

	paymentMethod, err := deps.PaymentsStore.UpsertPaymentMethod(ctx, session.CustomerID, pspAccount.ID, body.PaymentMethodRef)
	if err != nil {
		return IdempotentResult{}, err
	}
	pspIdempotencyKey := payment.ID + "-attempt-1"

	// Milestone 8/ADR-0011: Solidgate's /charge requires a customer
	// email; Stripe/mock ignore this field entirely — same fallback
	// createPaymentHandler uses, via a DB lookup since a checkout
	// session's own CreateCheckoutSessionRequest may have identified the
	// customer by customerId rather than customerEmail.
	var customerEmail *string
	if email, ok, err := deps.PaymentsStore.LookupCustomerEmail(ctx, session.CustomerID); err != nil {
		return IdempotentResult{}, err
	} else if ok {
		customerEmail = &email
	}

	amount, err := domain.MakeMoney(session.AmountMinor, session.Currency)
	if err != nil {
		return IdempotentResult{}, err
	}

	citMit := adapters.CitMitCIT
	if session.CitMit == "mit" {
		citMit = adapters.CitMitMIT
	}

	// T5.3: the circuit breaker only ever hears about `technical`
	// failures — see createPaymentHandler's identical comment in
	// payments.go for the full rationale, unchanged here.
	result, createErr := adapter.CreatePayment(ctx, adapters.CreatePaymentInput{
		PaymentID:        payment.ID,
		Amount:           amount,
		PaymentMethodRef: paymentMethod.PspPaymentMethodRef,
		Context:          adapters.AttemptContext{CitMit: citMit},
		IdempotencyKey:   pspIdempotencyKey,
		CaptureMethod:    adapters.CaptureMethodAutomatic,
		CustomerEmail:    customerEmail,
	})
	if createErr != nil {
		_ = recordBreakerFailure(ctx, PaymentsRouteDeps{Breaker: deps.Breaker}, pspAccount.ID)
		return IdempotentResult{}, createErr
	}

	if result.Decline != nil && domain.IsEligibleForPspFailover(result.Decline.RetryClass) {
		_ = recordBreakerFailure(ctx, PaymentsRouteDeps{Breaker: deps.Breaker}, pspAccount.ID)
	} else {
		_ = recordBreakerSuccess(ctx, PaymentsRouteDeps{Breaker: deps.Breaker}, pspAccount.ID)
	}
	clientSecretForThreeDS := result.ClientSecret

	if err := deps.PaymentsStore.RecordAttempt(ctx, RecordAttemptRow{
		PaymentID:      payment.ID,
		PspAccountID:   pspAccount.ID,
		AttemptNumber:  1,
		PspAttemptRef:  result.PspAttemptRef,
		IdempotencyKey: pspIdempotencyKey,
		Status:         string(result.Status),
	}); err != nil {
		return IdempotentResult{}, err
	}

	if err := deps.PaymentsStore.ApplyCanonicalEvents(ctx, payment.ID, initialAttemptEvents(result), pspAccount.PSP); err != nil {
		return IdempotentResult{}, err
	}

	// Mark the checkout session consumed AFTER the payment itself has
	// fully succeeded. If this secondary bookkeeping call fails, log it
	// and still return the successful payment response — the payment
	// succeeded; failing to flip checkout_sessions.status to 'consumed'
	// is not a reason to fail a request whose actual purpose (charging
	// the customer) already completed. A session stuck in 'open' past
	// its expires_at is harmless (isCheckoutSessionUsable/the expiry
	// check treats it as unusable regardless of status once expired),
	// and a retry of this same idempotency key would replay the cached
	// success response anyway rather than re-attempt this bookkeeping
	// call — so there is no retry path that depends on this call having
	// succeeded the first time.
	if err := deps.Store.MarkCheckoutSessionConsumed(ctx, session.ID, payment.ID); err != nil && deps.Logger != nil {
		deps.Logger.Error("failed to mark checkout session consumed after a successful payment — payment succeeded regardless",
			"checkout_session_id", session.ID,
			"payment_id", payment.ID,
			"error", err,
		)
	}

	finalPayment, found, err := deps.PaymentsStore.GetPayment(ctx, payment.ID, session.ProductID)
	if err != nil {
		return IdempotentResult{}, err
	}
	if !found {
		finalPayment = payment
	}

	dto := serializePayment(finalPayment)
	dto.ClientSecret = clientSecretForThreeDS
	return IdempotentResult{Status: http.StatusCreated, Body: dto}, nil
}

// checkoutSessionIdempotencyKey is the single source of truth for the
// idempotency key POST .../confirm uses — both
// handleConfirmCheckoutSession (WithIdempotencyKey's own key parameter)
// and confirmCheckoutSessionHandler (PaymentsStore.CreatePayment's
// idempotency_key column, via CreatePaymentRow.IdempotencyKey, which
// FindPaymentByIdempotencyKey later re-reads on a replay — see
// pgpaymentsstore.go's doc comment on why that second idempotency layer
// exists) must derive the exact same string from the same session id,
// or a retried confirm could win the WithIdempotencyKey race a second
// time yet fail to find the row FindPaymentByIdempotencyKey would
// otherwise have located, and create a duplicate payments row.
func checkoutSessionIdempotencyKey(sessionID string) string {
	return "checkout-session-confirm-" + sessionID
}
