package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/alphapayments/payment-orchestrator/internal/adapters"
	"github.com/alphapayments/payment-orchestrator/internal/adapters/registry"
	"github.com/alphapayments/payment-orchestrator/internal/domain"
)

// This file is a 1:1 port of src/api/routes/payments.ts's route
// SHAPES and business logic, wired against this Go port's real
// internal/domain (Phase 1), internal/adapters + registry (Phase 2),
// internal/routing (Phase 4), and internal/statemachine +
// internal/webhooks (Phase 5) packages.
//
// UPDATED Phase 5: PaymentsStore now has a real, pgx-backed
// implementation — PgxPaymentsStore (pgpaymentsstore.go), wired for
// real in cmd/api/main.go, replacing every prior phase's
// UnimplementedPaymentsStore{}. Every method below is now genuinely
// end-to-end real:
//   - Request parsing/validation shapes (money, citMit, captureMethod).
//   - Idempotency-Key handling via WithIdempotencyKey (idempotency.go).
//   - domain.Money construction/validation.
//   - initialAttemptEvents/captureAttemptEvents/voidAttemptEvents/
//     refundAttemptEvents (attempt_events.go) — pure functions, no I/O.
//   - registry.Registry.Resolve — resolving a psp_accounts row to a
//     real adapters.PspAdapter and calling CreatePayment/Capture/Void/
//     Refund on it for real.
//   - ResolveRouting — PgxPaymentsStore delegates to a real
//     *routing.Evaluator (Phase 4's routing_rules engine + circuit
//     breaker), not a stub.
//   - The circuit breaker (breaker.recordFailure/recordSuccess) — wired
//     for real since Phase 4 (*routing.CircuitBreaker against a live
//     Redis client).
//   - ApplyCanonicalEvents — PgxPaymentsStore delegates to
//     internal/webhooks.ApplyCanonicalEvents, which runs every event
//     through internal/statemachine.Transition (the DB-effectful state
//     machine shell: SELECT...FOR UPDATE, payment_events/outbox writes,
//     all in one transaction) — the SAME underlying function the
//     webhook-driven apply path and gap-detection call, not a
//     duplicate. This file's job remains only to compute WHICH events
//     apply (via attempt_events.go, pure) and hand them off — that
//     division of labor is unchanged from Phase 3/4; only the "hand
//     them off to what" answer changed, from a 501 stub to a real
//     implementation.
//   - Response serialization shapes (serializePayment/serializeAttempt/
//     SerializePaymentMethod) — exact field names/JSON shape ported
//     from the TS serializers.
//
// See MIGRATION_NOTES.md's Phase 5 section for exactly how confident
// this port is in each of PgxPaymentsStore's methods (ListPayments
// cursor pagination and the ResolveRouting/merchant_entity_id flow are
// both called out explicitly there) and for the transactions-row
// transaction-boundary decision (internal/webhooks/apply.go's
// maybeRecordLedgerEntry runs in a SEPARATE call from
// statemachine.Transition's own transaction — a deliberate, documented
// decision, not an oversight).
type PaymentsRouteDeps struct {
	Store       PaymentsStore
	Registry    *registry.Registry
	Idempotency IdempotencyStore
	Cache       IdempotencyCache
	Logger      *slog.Logger
	// Breaker records PSP call outcomes for Milestone 5's circuit
	// breaker (see the CircuitBreaker doc comment below). cmd/api/main.go
	// wires a real *routing.CircuitBreaker (Phase 4) against a live
	// Redis client; nil is also tolerated
	// (recordBreakerFailure/recordBreakerSuccess no-op on a nil Breaker)
	// so tests can omit it entirely.
	Breaker CircuitBreaker
}

// MoneyDTO mirrors the TS moneySchema's wire shape exactly:
// {"minorUnits": number, "currency": string}.
type MoneyDTO struct {
	MinorUnits int64  `json:"minorUnits"`
	Currency   string `json:"currency"`
}

// CreatePaymentRequest mirrors createPaymentBodySchema's wire shape.
// CustomerID/CustomerEmail are pointers because the TS schema makes
// both optional but requires at least one via `.refine(...)` — checked
// explicitly in the handler below, matching that refine's exact
// message.
type CreatePaymentRequest struct {
	CustomerID       *string  `json:"customerId,omitempty"`
	CustomerEmail    *string  `json:"customerEmail,omitempty"`
	Amount           MoneyDTO `json:"amount"`
	PaymentMethodRef string   `json:"paymentMethodRef"`
	CitMit           string   `json:"citMit"`
	CaptureMethod    string   `json:"captureMethod"`
}

// RefundRequest mirrors refundBodySchema's wire shape — amount is
// optional; absent means "refund the full payment amount."
type RefundRequest struct {
	Amount *MoneyDTO `json:"amount,omitempty"`
}

// PaymentDTO mirrors serializePayment's exact output shape and field
// names/order.
type PaymentDTO struct {
	ID           string   `json:"id"`
	ProductID    string   `json:"productId"`
	CustomerID   string   `json:"customerId"`
	Amount       MoneyDTO `json:"amount"`
	State        string   `json:"state"`
	CitMit       string   `json:"citMit"`
	CreatedAt    string   `json:"createdAt"`
	UpdatedAt    string   `json:"updatedAt"`
	ClientSecret *string  `json:"clientSecret,omitempty"`
}

// AttemptDTO mirrors serializeAttempt's exact output shape.
type AttemptDTO struct {
	AttemptNumber int    `json:"attemptNumber"`
	Status        string `json:"status"`
	CreatedAt     string `json:"createdAt"`
}

// PaymentMethodDTO mirrors serializePaymentMethod's exact output shape
// (exported — src/api/routes/customers.ts re-exports serializePaymentMethod
// for reuse by the customers route; this Go port's customers.go imports
// SerializePaymentMethod directly from this file for the same reason).
type PaymentMethodDTO struct {
	ID        string  `json:"id"`
	Type      string  `json:"type"`
	CardBrand *string `json:"cardBrand"`
	CardLast4 *string `json:"cardLast4"`
	IsActive  bool    `json:"isActive"`
	CreatedAt string  `json:"createdAt"`
}

// TimelineEntryDTO mirrors src/api/timeline.ts's TimelineEntry shape.
type TimelineEntryDTO struct {
	Event       string  `json:"event"`
	OccurredAt  string  `json:"occurredAt"`
	DeclineCode *string `json:"declineCode,omitempty"`
	Outcome     *string `json:"outcome,omitempty"`
}

// PaymentDetailResponse is the actual GET /v1/payments/:id response —
// separated from PaymentDetailDTO above because embedding PaymentDTO
// plus a same-shape Timeline field needs an explicit struct rather
// than Go's embedding-with-json-tag-collision rules; this is the type
// every handler in this file actually serializes.
type PaymentDetailResponse struct {
	PaymentDTO
	Attempts []AttemptDTO       `json:"attempts"`
	Timeline []TimelineEntryDTO `json:"timeline"`
}

// ListPaymentsResponse mirrors GET /v1/payments's exact response shape.
type ListPaymentsResponse struct {
	Data       []PaymentDTO      `json:"data"`
	Pagination ListPaginationDTO `json:"pagination"`
}

// ListPaginationDTO mirrors the TS `{ hasMore, nextCursor }` shape.
type ListPaginationDTO struct {
	HasMore    bool    `json:"hasMore"`
	NextCursor *string `json:"nextCursor"`
}

// ListPaymentsQuery mirrors listPaymentsQuerySchema's parsed shape.
type ListPaymentsQuery struct {
	CustomerID    *string
	State         *string
	CreatedAfter  *string
	CreatedBefore *string
	Limit         int
	Cursor        *string
}

// RoutingDecision is the minimal shape this port needs from a routing
// decision. PspAccountID is the one field every call site in this file
// actually needs. Phase 5: PgxPaymentsStore.ResolveRouting populates
// this from a real *routing.Decision (internal/routing/rules.go);
// still deliberately narrower than routing.Decision's full shape
// (Strategy/RuleID/Reason), matching this file's own established
// "carry only the columns this file actually reads" convention.
type RoutingDecision struct {
	PspAccountID string
}

// PspAccountRow is the subset of a psp_accounts row this file needs —
// mirrors registry.PspAccount's shape plus the PSP field the route
// handler reads directly (pspAccount.psp) to pass to
// ApplyCanonicalEvents.
type PspAccountRow struct {
	ID        string
	PSP       string
	Mode      string
	SecretRef string
	// StatementDescriptorSuffix: 2026-07-08, multi-integration
	// descriptors (see db/migrations/…_psp-account-statement-descriptor
	// and adapters.CreatePaymentInput's own doc comment). Nil when this
	// account has no override configured — createPaymentHandler passes
	// it straight through to adapters.CreatePaymentInput unconditionally
	// so "no override" and "adapter ignores it" are the same nil case.
	StatementDescriptorSuffix *string
}

func (p PspAccountRow) toRegistryAccount() registry.PspAccount {
	return registry.PspAccount{ID: p.ID, PSP: p.PSP, Mode: p.Mode, SecretRef: p.SecretRef}
}

// PaymentRow/AttemptRow/PaymentMethodRow are the minimal shapes this
// file needs back from PaymentsStore — narrower Go analogues of the
// TS Payment/PaymentAttemptsTable/PaymentMethodsTable Kysely row
// types, carrying only the columns the route handlers/serializers
// actually read.
type PaymentRow struct {
	ID          string
	ProductID   string
	CustomerID  string
	AmountMinor int64
	Currency    string
	State       string
	CitMit      string
	CreatedAt   time.Time
	UpdatedAt   time.Time
	// RoutingDecision is nil for a brand-new payment being created in
	// this same request (the handler computes and passes it explicitly
	// in that case) and populated when re-reading an existing payment
	// row found by idempotency key.
	RoutingDecision *RoutingDecision
}

type AttemptRow struct {
	AttemptNumber int
	Status        string
	PspAttemptRef *string
	PspAccountID  string
	CreatedAt     time.Time
}

type PaymentMethodRow struct {
	ID                  string
	Type                string
	CardBrand           *string
	CardLast4           *string
	IsActive            bool
	CreatedAt           time.Time
	PspPaymentMethodRef string
}

type PaymentEventRow struct {
	EventType   string
	DeclineCode *string
	OccurredAt  time.Time
}

// CircuitBreaker is the minimal capability the payments route needs
// from Milestone 5's circuit breaker (src/routing/circuitBreaker.ts).
// Represented here as a narrow interface so this file's business logic
// can call RecordFailure/RecordSuccess at exactly the same points the
// TS source does. cmd/api/main.go wires a real *routing.CircuitBreaker
// (Phase 4) against a live Redis client — *routing.CircuitBreaker
// satisfies this interface structurally, with no adapter type needed.
type CircuitBreaker interface {
	RecordFailure(ctx context.Context, pspAccountID string) error
	RecordSuccess(ctx context.Context, pspAccountID string) error
}

// PaymentsStore is the minimal set of persistence operations the
// payments routes need — the Go analogue of every `db.selectFrom(...)`/
// `insertInto(...)` call in src/api/routes/payments.ts, collapsed into
// one interface per the same DB-independence rationale as
// TokenStore/IdempotencyStore.
//
// Phase 5: implemented for real by PgxPaymentsStore
// (pgpaymentsstore.go), wired in cmd/api/main.go. See
// MIGRATION_NOTES.md's Phase 5 section for the exact confidence level
// per method.
type PaymentsStore interface {
	ResolveCustomerID(ctx context.Context, merchantEntityID string, customerID *string, customerEmail *string) (string, error)
	// FindPaymentByIdempotencyKey is scoped by productID — see
	// pgpaymentsstore.go's doc comment on this method for the
	// cross-tenant IDOR this scoping closes.
	FindPaymentByIdempotencyKey(ctx context.Context, productID string, idempotencyKey string) (PaymentRow, bool, error)
	ResolveRouting(ctx context.Context, productID string, currency string, citMit string, paymentMethodType string) (RoutingDecision, error)
	CreatePayment(ctx context.Context, input CreatePaymentRow) (PaymentRow, error)
	GetPspAccount(ctx context.Context, id string) (PspAccountRow, error)
	FindAttempt(ctx context.Context, paymentID string, attemptNumber int) (AttemptRow, bool, error)
	LatestAttempt(ctx context.Context, paymentID string) (AttemptRow, bool, error)
	UpsertPaymentMethod(ctx context.Context, customerID string, pspAccountID string, pspPaymentMethodRef string) (PaymentMethodRow, error)
	LookupCustomerEmail(ctx context.Context, customerID string) (string, bool, error)
	RecordAttempt(ctx context.Context, input RecordAttemptRow) error
	ApplyCanonicalEvents(ctx context.Context, paymentID string, events []domain.CanonicalEvent, psp string) error
	GetPayment(ctx context.Context, id string, productID string) (PaymentRow, bool, error)
	ListAttempts(ctx context.Context, paymentID string) ([]AttemptRow, error)
	ListEvents(ctx context.Context, paymentID string) ([]PaymentEventRow, error)
	ListPayments(ctx context.Context, productID string, query ListPaymentsQuery) ([]PaymentRow, error)
}

// CreatePaymentRow is the input to PaymentsStore.CreatePayment.
type CreatePaymentRow struct {
	MerchantEntityID string
	ProductID        string
	CustomerID       string
	AmountMinor      int64
	Currency         string
	CitMit           string
	RoutingDecision  RoutingDecision
	IdempotencyKey   string
}

// RecordAttemptRow is the input to PaymentsStore.RecordAttempt.
type RecordAttemptRow struct {
	PaymentID      string
	PspAccountID   string
	AttemptNumber  int
	PspAttemptRef  string
	IdempotencyKey string
	Status         string
}

// ErrNotImplemented is returned by any stub PaymentsStore/
// CustomersStore implementation (stubs.go's UnimplementedPaymentsStore/
// UnimplementedCustomersStore) — no longer wired by default in
// cmd/api/main.go as of Phase 5, but kept available for tests or a
// deployment that deliberately wants to disable these routes.
var ErrNotImplemented = errors.New("not implemented in this phase — requires a later phase's DB/routing layer")

// registerPaymentsRoutes registers every /v1/payments* route — the Go
// analogue of registerPaymentsRoutes(app, deps) in
// src/api/routes/payments.ts. Mounted under chi's /v1 route group by
// router.go's BuildRouter, so every route here is already behind the
// Auth middleware.
func registerPaymentsRoutes(r chi.Router, deps PaymentsRouteDeps) {
	r.Post("/payments", handleCreatePayment(deps))
	r.Get("/payments/{id}", handleGetPayment(deps))
	r.Get("/payments", handleListPayments(deps))
	r.Post("/payments/{id}/capture", handleCapturePayment(deps))
	r.Post("/payments/{id}/void", handleVoidPayment(deps))
	r.Post("/payments/{id}/refunds", handleRefundPayment(deps))
}

func serializePayment(p PaymentRow) PaymentDTO {
	return PaymentDTO{
		ID:         p.ID,
		ProductID:  p.ProductID,
		CustomerID: p.CustomerID,
		Amount:     MoneyDTO{MinorUnits: p.AmountMinor, Currency: p.Currency},
		State:      p.State,
		CitMit:     p.CitMit,
		CreatedAt:  p.CreatedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt:  p.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func serializeAttempt(a AttemptRow) AttemptDTO {
	return AttemptDTO{
		AttemptNumber: a.AttemptNumber,
		Status:        a.Status,
		CreatedAt:     a.CreatedAt.UTC().Format(time.RFC3339Nano),
	}
}

// SerializePaymentMethod mirrors serializePaymentMethod exactly.
// Exported (capital S) because customers.go — the Go analogue of the
// TS customers.ts's `import { serializePaymentMethod } from
// './payments.js'` — calls it directly, matching the TS source's own
// `export { serializePaymentMethod }` at the bottom of payments.ts.
func SerializePaymentMethod(pm PaymentMethodRow) PaymentMethodDTO {
	return PaymentMethodDTO{
		ID:        pm.ID,
		Type:      pm.Type,
		CardBrand: pm.CardBrand,
		CardLast4: pm.CardLast4,
		IsActive:  pm.IsActive,
		CreatedAt: pm.CreatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func handleCreatePayment(deps PaymentsRouteDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth, _ := authFromContext(r.Context())
		// Fixed 2026-07-10: this was the one mutating route in the
		// package that never called RequireWriteScope, so a
		// read_only-scoped MCP agent token — meant to be able to browse
		// data only — could still initiate a real charge. Every other
		// mutating handler here (capture/void/refund) already enforces
		// this; creating a payment must too.
		if !RequireWriteScope(w, auth) {
			return
		}

		idemKey, err := RequireIdempotencyKey(r.Header)
		if err != nil {
			WriteProblem(w, http.StatusBadRequest, err.Error(), "")
			return
		}

		var body CreatePaymentRequest
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
		if body.CaptureMethod == "" {
			body.CaptureMethod = "automatic"
		}
		if body.PaymentMethodRef == "" {
			WriteProblem(w, http.StatusBadRequest, "Validation failed", "paymentMethodRef: required")
			return
		}

		if deps.Store == nil {
			WriteProblem(w, http.StatusNotImplemented, "Not implemented", ErrNotImplemented.Error())
			return
		}

		outcome, err := WithIdempotencyKey(
			r.Context(),
			IdempotencyDeps{Store: deps.Idempotency, Cache: deps.Cache},
			auth.ProductID,
			idemKey,
			IdempotentRequestDescriptor{Method: r.Method, Path: r.URL.Path, Body: body},
			func(ctx context.Context) (IdempotentResult, error) {
				return createPaymentHandler(ctx, deps, auth, body, idemKey)
			},
		)
		writeIdempotentOutcomeOrError(w, outcome, err)
	}
}

// createPaymentHandler is the 1:1 port of the closure passed to
// withIdempotencyKey in the TS POST /v1/payments handler.
func createPaymentHandler(
	ctx context.Context,
	deps PaymentsRouteDeps,
	auth AuthContext,
	body CreatePaymentRequest,
	idempotencyKey string,
) (IdempotentResult, error) {
	if deps.Store == nil {
		return IdempotentResult{}, ErrNotImplemented
	}

	customerID, err := deps.Store.ResolveCustomerID(ctx, auth.MerchantEntityID, body.CustomerID, body.CustomerEmail)
	if err != nil {
		return IdempotentResult{}, err
	}

	// Second idempotency layer — see
	// db/migrations/..._payments-idempotency-key-unique.up.sql's
	// docblock for why this lookup exists on top of this file's own
	// Idempotency-Key caching. Scoped by auth.ProductID (see
	// pgpaymentsstore.go's doc comment) so a colliding idempotency key
	// submitted by a different tenant can never be mistaken for this
	// caller's own payment.
	payment, found, err := deps.Store.FindPaymentByIdempotencyKey(ctx, auth.ProductID, idempotencyKey)
	if err != nil {
		return IdempotentResult{}, err
	}

	var routingDecision RoutingDecision
	var clientSecret *string

	if !found {
		routingDecision, err = deps.Store.ResolveRouting(ctx, auth.ProductID, body.Amount.Currency, body.CitMit, "card")
		if err != nil {
			return IdempotentResult{}, err
		}
		payment, err = deps.Store.CreatePayment(ctx, CreatePaymentRow{
			MerchantEntityID: auth.MerchantEntityID,
			ProductID:        auth.ProductID,
			CustomerID:       customerID,
			AmountMinor:      body.Amount.MinorUnits,
			Currency:         body.Amount.Currency,
			CitMit:           body.CitMit,
			RoutingDecision:  routingDecision,
			IdempotencyKey:   idempotencyKey,
		})
		if err != nil {
			return IdempotentResult{}, err
		}
	} else if payment.RoutingDecision != nil {
		routingDecision = *payment.RoutingDecision
	}

	pspAccount, err := deps.Store.GetPspAccount(ctx, routingDecision.PspAccountID)
	if err != nil {
		return IdempotentResult{}, err
	}
	adapter, err := deps.Registry.Resolve(pspAccount.toRegistryAccount())
	if err != nil {
		return IdempotentResult{}, err
	}

	_, existingAttempt, err := findExistingAttempt(ctx, deps.Store, payment.ID)
	if err != nil {
		return IdempotentResult{}, err
	}

	if !existingAttempt {
		paymentMethod, err := deps.Store.UpsertPaymentMethod(ctx, customerID, pspAccount.ID, body.PaymentMethodRef)
		if err != nil {
			return IdempotentResult{}, err
		}
		pspIdempotencyKey := payment.ID + "-attempt-1"

		// Milestone 8/ADR-0011: Solidgate's /charge requires a customer
		// email; Stripe/mock ignore this field entirely. Falls back to a
		// DB lookup when the request identified the customer by
		// customerId rather than customerEmail.
		customerEmail := body.CustomerEmail
		if customerEmail == nil {
			if email, ok, err := deps.Store.LookupCustomerEmail(ctx, customerID); err != nil {
				return IdempotentResult{}, err
			} else if ok {
				customerEmail = &email
			}
		}

		amount, err := domain.MakeMoney(body.Amount.MinorUnits, body.Amount.Currency)
		if err != nil {
			return IdempotentResult{}, err
		}

		captureMethod := adapters.CaptureMethodAutomatic
		if body.CaptureMethod == "manual" {
			captureMethod = adapters.CaptureMethodManual
		}
		citMit := adapters.CitMitCIT
		if body.CitMit == "mit" {
			citMit = adapters.CitMitMIT
		}

		// T5.3: the circuit breaker only ever hears about `technical`
		// failures (adapter throws, or a technical-category decline) —
		// never about business declines, which say nothing about
		// whether the PSP itself is healthy. See CircuitBreaker's doc
		// comment for this Go port's Milestone-5 scope note.
		result, createErr := adapter.CreatePayment(ctx, adapters.CreatePaymentInput{
			PaymentID:        payment.ID,
			Amount:           amount,
			PaymentMethodRef: paymentMethod.PspPaymentMethodRef,
			Context:          adapters.AttemptContext{CitMit: citMit},
			IdempotencyKey:   pspIdempotencyKey,
			CaptureMethod:    captureMethod,
			CustomerEmail:    customerEmail,
			// 2026-07-08: the routed-to psp_account's own configured
			// suffix (nil if none set) — see PspAccountRow's doc
			// comment. This is what makes "multiple descriptors" work:
			// two psp_accounts against the same PSP type route through
			// here with two different pspAccount.StatementDescriptorSuffix
			// values.
			StatementDescriptorSuffix: pspAccount.StatementDescriptorSuffix,
		})
		if createErr != nil {
			_ = recordBreakerFailure(ctx, deps, pspAccount.ID)
			return IdempotentResult{}, createErr
		}

		if result.Decline != nil && domain.IsEligibleForPspFailover(result.Decline.RetryClass) {
			_ = recordBreakerFailure(ctx, deps, pspAccount.ID)
		} else {
			_ = recordBreakerSuccess(ctx, deps, pspAccount.ID)
		}
		clientSecret = result.ClientSecret

		if err := deps.Store.RecordAttempt(ctx, RecordAttemptRow{
			PaymentID:      payment.ID,
			PspAccountID:   pspAccount.ID,
			AttemptNumber:  1,
			PspAttemptRef:  result.PspAttemptRef,
			IdempotencyKey: pspIdempotencyKey,
			Status:         string(result.Status),
		}); err != nil {
			return IdempotentResult{}, err
		}

		if err := deps.Store.ApplyCanonicalEvents(ctx, payment.ID, initialAttemptEvents(result), pspAccount.PSP); err != nil {
			return IdempotentResult{}, err
		}
	}

	finalPayment, found, err := deps.Store.GetPayment(ctx, payment.ID, auth.ProductID)
	if err != nil {
		return IdempotentResult{}, err
	}
	if !found {
		// GetPayment is scoped by auth.ProductID; a miss here means this
		// payment id genuinely does not belong to the caller's product —
		// including the now-impossible-in-practice-but-still-worth-
		// guarding-against case of `payment` above having come from a
		// different tenant's row. Never fall back to the earlier,
		// less-strictly-scoped `payment` value: doing so was the exact
		// cross-tenant IDOR this handler used to have (see
		// FindPaymentByIdempotencyKey's doc comment).
		return IdempotentResult{}, fmt.Errorf("api: payment %s not visible under product %s after create", payment.ID, auth.ProductID)
	}

	dto := serializePayment(finalPayment)
	dto.ClientSecret = clientSecret
	return IdempotentResult{Status: http.StatusCreated, Body: dto}, nil
}

func findExistingAttempt(ctx context.Context, store PaymentsStore, paymentID string) (AttemptRow, bool, error) {
	return store.FindAttempt(ctx, paymentID, 1)
}

func recordBreakerFailure(ctx context.Context, deps PaymentsRouteDeps, pspAccountID string) error {
	if deps.Breaker == nil {
		return nil
	}
	return deps.Breaker.RecordFailure(ctx, pspAccountID)
}

func recordBreakerSuccess(ctx context.Context, deps PaymentsRouteDeps, pspAccountID string) error {
	if deps.Breaker == nil {
		return nil
	}
	return deps.Breaker.RecordSuccess(ctx, pspAccountID)
}

func handleGetPayment(deps PaymentsRouteDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth, _ := authFromContext(r.Context())
		id := chi.URLParam(r, "id")

		if deps.Store == nil {
			WriteProblem(w, http.StatusNotImplemented, "Not implemented", ErrNotImplemented.Error())
			return
		}

		payment, found, err := deps.Store.GetPayment(r.Context(), id, auth.ProductID)
		if err != nil {
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}
		if !found {
			WriteProblem(w, http.StatusNotFound, "Payment not found", "")
			return
		}

		attempts, err := deps.Store.ListAttempts(r.Context(), id)
		if err != nil {
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}
		events, err := deps.Store.ListEvents(r.Context(), id)
		if err != nil {
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}

		attemptDTOs := make([]AttemptDTO, 0, len(attempts))
		for _, a := range attempts {
			attemptDTOs = append(attemptDTOs, serializeAttempt(a))
		}

		resp := PaymentDetailResponse{
			PaymentDTO: serializePayment(payment),
			Attempts:   attemptDTOs,
			Timeline:   serializeTimeline(events),
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

func handleListPayments(deps PaymentsRouteDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth, _ := authFromContext(r.Context())

		query, err := parseListPaymentsQuery(r.URL.Query())
		if err != nil {
			WriteProblem(w, http.StatusBadRequest, "Validation failed", err.Error())
			return
		}

		if deps.Store == nil {
			WriteProblem(w, http.StatusNotImplemented, "Not implemented", ErrNotImplemented.Error())
			return
		}

		rows, err := deps.Store.ListPayments(r.Context(), auth.ProductID, query)
		if err != nil {
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}

		// UUIDv7 primary keys are time-sortable, so `id` doubles as a
		// stable keyset-pagination cursor — matching the TS route's own
		// `.orderBy('id', 'desc').limit(query.limit + 1)` +
		// hasMore-via-fetch-one-extra pattern exactly. The actual
		// ORDER BY/LIMIT/WHERE id < cursor logic lives in
		// PgxPaymentsStore.ListPayments (pgpaymentsstore.go, Phase 5);
		// this handler only computes hasMore/nextCursor from whatever
		// rows come back, matching the TS handler's own division of
		// labor.
		hasMore := len(rows) > query.Limit
		page := rows
		if hasMore {
			page = rows[:query.Limit]
		}

		dtos := make([]PaymentDTO, 0, len(page))
		for _, p := range page {
			dtos = append(dtos, serializePayment(p))
		}

		var nextCursor *string
		if hasMore && len(page) > 0 {
			c := page[len(page)-1].ID
			nextCursor = &c
		}

		writeJSON(w, http.StatusOK, ListPaymentsResponse{
			Data:       dtos,
			Pagination: ListPaginationDTO{HasMore: hasMore, NextCursor: nextCursor},
		})
	}
}

func parseListPaymentsQuery(values map[string][]string) (ListPaymentsQuery, error) {
	get := func(key string) *string {
		if vs, ok := values[key]; ok && len(vs) > 0 && vs[0] != "" {
			v := vs[0]
			return &v
		}
		return nil
	}

	query := ListPaymentsQuery{
		CustomerID:    get("customerId"),
		State:         get("state"),
		CreatedAfter:  get("createdAfter"),
		CreatedBefore: get("createdBefore"),
		Cursor:        get("cursor"),
		Limit:         20,
	}
	if limitStr := get("limit"); limitStr != nil {
		limit, err := strconv.Atoi(*limitStr)
		if err != nil || limit < 1 || limit > 100 {
			return ListPaymentsQuery{}, errors.New("limit: must be an integer between 1 and 100")
		}
		query.Limit = limit
	}
	return query, nil
}

func handleCapturePayment(deps PaymentsRouteDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		handleAttemptAction(w, r, deps, "capture", func(ctx context.Context, deps PaymentsRouteDeps, auth AuthContext, id string, idemKey string) (IdempotentResult, error) {
			// Payment row itself isn't needed beyond the existence check
			// below — the actual capture goes through the latest attempt
			// + PSP adapter, and any state-transition validity is
			// enforced by the state machine when ApplyCanonicalEvents
			// applies the resulting events, not here.
			_, found, err := deps.Store.GetPayment(ctx, id, auth.ProductID)
			if err != nil {
				return IdempotentResult{}, err
			}
			if !found {
				return IdempotentResult{Status: http.StatusNotFound, Body: problemBody{Type: "about:blank", Title: "Payment not found", Status: http.StatusNotFound}}, nil
			}

			attempt, ok, err := deps.Store.LatestAttempt(ctx, id)
			if err != nil {
				return IdempotentResult{}, err
			}
			if !ok || attempt.PspAttemptRef == nil {
				return IdempotentResult{Status: http.StatusConflict, Body: problemBody{Type: "about:blank", Title: "Payment has no PSP attempt to capture", Status: http.StatusConflict}}, nil
			}

			pspAccount, err := deps.Store.GetPspAccount(ctx, attempt.PspAccountID)
			if err != nil {
				return IdempotentResult{}, err
			}
			adapter, err := deps.Registry.Resolve(pspAccount.toRegistryAccount())
			if err != nil {
				return IdempotentResult{}, err
			}

			result, err := adapter.Capture(ctx, *attempt.PspAttemptRef, nil, id+"-capture-"+idemKey)
			if err != nil {
				return IdempotentResult{}, err
			}
			if err := deps.Store.ApplyCanonicalEvents(ctx, id, captureAttemptEvents(result), pspAccount.PSP); err != nil {
				return IdempotentResult{}, err
			}

			finalPayment, _, err := deps.Store.GetPayment(ctx, id, auth.ProductID)
			if err != nil {
				return IdempotentResult{}, err
			}
			return IdempotentResult{Status: http.StatusOK, Body: serializePayment(finalPayment)}, nil
		})
	}
}

func handleVoidPayment(deps PaymentsRouteDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		handleAttemptAction(w, r, deps, "void", func(ctx context.Context, deps PaymentsRouteDeps, auth AuthContext, id string, idemKey string) (IdempotentResult, error) {
			// Same rationale as handleCapturePayment above: the payment
			// row is only needed for the existence check here.
			_, found, err := deps.Store.GetPayment(ctx, id, auth.ProductID)
			if err != nil {
				return IdempotentResult{}, err
			}
			if !found {
				return IdempotentResult{Status: http.StatusNotFound, Body: problemBody{Type: "about:blank", Title: "Payment not found", Status: http.StatusNotFound}}, nil
			}

			attempt, ok, err := deps.Store.LatestAttempt(ctx, id)
			if err != nil {
				return IdempotentResult{}, err
			}
			if !ok || attempt.PspAttemptRef == nil {
				return IdempotentResult{Status: http.StatusConflict, Body: problemBody{Type: "about:blank", Title: "Payment has no PSP attempt to void", Status: http.StatusConflict}}, nil
			}

			pspAccount, err := deps.Store.GetPspAccount(ctx, attempt.PspAccountID)
			if err != nil {
				return IdempotentResult{}, err
			}
			adapter, err := deps.Registry.Resolve(pspAccount.toRegistryAccount())
			if err != nil {
				return IdempotentResult{}, err
			}

			result, err := adapter.Void(ctx, *attempt.PspAttemptRef, id+"-void-"+idemKey)
			if err != nil {
				return IdempotentResult{}, err
			}
			if err := deps.Store.ApplyCanonicalEvents(ctx, id, voidAttemptEvents(result), pspAccount.PSP); err != nil {
				return IdempotentResult{}, err
			}

			finalPayment, _, err := deps.Store.GetPayment(ctx, id, auth.ProductID)
			if err != nil {
				return IdempotentResult{}, err
			}
			return IdempotentResult{Status: http.StatusOK, Body: serializePayment(finalPayment)}, nil
		})
	}
}

func handleRefundPayment(deps PaymentsRouteDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth, _ := authFromContext(r.Context())
		if !RequireWriteScope(w, auth) {
			return
		}
		id := chi.URLParam(r, "id")
		idemKey, err := RequireIdempotencyKey(r.Header)
		if err != nil {
			WriteProblem(w, http.StatusBadRequest, err.Error(), "")
			return
		}

		var body RefundRequest
		if r.ContentLength != 0 {
			if !decodeJSONBody(w, r, &body) {
				return
			}
		}

		if deps.Store == nil {
			WriteProblem(w, http.StatusNotImplemented, "Not implemented", ErrNotImplemented.Error())
			return
		}

		outcome, err := WithIdempotencyKey(
			r.Context(),
			IdempotencyDeps{Store: deps.Idempotency, Cache: deps.Cache},
			auth.ProductID,
			idemKey,
			IdempotentRequestDescriptor{Method: r.Method, Path: r.URL.Path, Body: body},
			func(ctx context.Context) (IdempotentResult, error) {
				payment, found, err := deps.Store.GetPayment(ctx, id, auth.ProductID)
				if err != nil {
					return IdempotentResult{}, err
				}
				if !found {
					return IdempotentResult{Status: http.StatusNotFound, Body: problemBody{Type: "about:blank", Title: "Payment not found", Status: http.StatusNotFound}}, nil
				}

				attempt, ok, err := deps.Store.LatestAttempt(ctx, id)
				if err != nil {
					return IdempotentResult{}, err
				}
				if !ok || attempt.PspAttemptRef == nil {
					return IdempotentResult{Status: http.StatusConflict, Body: problemBody{Type: "about:blank", Title: "Payment has no PSP attempt to refund", Status: http.StatusConflict}}, nil
				}

				pspAccount, err := deps.Store.GetPspAccount(ctx, attempt.PspAccountID)
				if err != nil {
					return IdempotentResult{}, err
				}
				adapter, err := deps.Registry.Resolve(pspAccount.toRegistryAccount())
				if err != nil {
					return IdempotentResult{}, err
				}

				// Partial refunds supported via the optional body amount;
				// defaults to the full payment amount. Tracking
				// *remaining* refundable balance across multiple partial
				// refunds is Milestone 6 ledger territory — flagged, not
				// guessed at, here, exactly as the TS source flags it.
				var refundAmount domain.Money
				if body.Amount != nil {
					refundAmount, err = domain.MakeMoney(body.Amount.MinorUnits, body.Amount.Currency)
				} else {
					refundAmount, err = domain.MakeMoney(payment.AmountMinor, payment.Currency)
				}
				if err != nil {
					return IdempotentResult{}, err
				}

				_, err = adapter.Refund(ctx, *attempt.PspAttemptRef, refundAmount, id+"-refund-"+idemKey)
				if err != nil {
					return IdempotentResult{}, err
				}
				if err := deps.Store.ApplyCanonicalEvents(ctx, id, refundAttemptEvents(), pspAccount.PSP); err != nil {
					return IdempotentResult{}, err
				}

				finalPayment, _, err := deps.Store.GetPayment(ctx, id, auth.ProductID)
				if err != nil {
					return IdempotentResult{}, err
				}
				return IdempotentResult{Status: http.StatusOK, Body: serializePayment(finalPayment)}, nil
			},
		)
		writeIdempotentOutcomeOrError(w, outcome, err)
	}
}

// handleAttemptAction is the shared skeleton for POST
// /v1/payments/:id/capture and .../void — both TS handlers follow the
// identical shape (require Idempotency-Key, run the whole body through
// withIdempotencyKey, look up payment -> latest attempt -> psp_account
// -> adapter, call one adapter method, applyCanonicalEvents, re-read
// and return the payment). Refund is NOT folded into this helper
// because its body-parsing step (optional refund amount) differs
// enough to be clearer written out directly (see handleRefundPayment).
func handleAttemptAction(
	w http.ResponseWriter,
	r *http.Request,
	deps PaymentsRouteDeps,
	action string,
	body func(ctx context.Context, deps PaymentsRouteDeps, auth AuthContext, id string, idemKey string) (IdempotentResult, error),
) {
	auth, _ := authFromContext(r.Context())
	// Covers both handleCapturePayment and handleVoidPayment, the two
	// callers of this shared helper — a read_only-scoped MCP agent
	// token (agent_tokens.go) gets 403 on either action from this one
	// check, rather than needing it duplicated at each call site.
	if !RequireWriteScope(w, auth) {
		return
	}
	id := chi.URLParam(r, "id")
	idemKey, err := RequireIdempotencyKey(r.Header)
	if err != nil {
		WriteProblem(w, http.StatusBadRequest, err.Error(), "")
		return
	}

	if deps.Store == nil {
		WriteProblem(w, http.StatusNotImplemented, "Not implemented", ErrNotImplemented.Error())
		return
	}

	var requestBody any
	if r.ContentLength != 0 {
		var raw map[string]any
		if !decodeJSONBody(w, r, &raw) {
			return
		}
		requestBody = raw
	}

	outcome, err := WithIdempotencyKey(
		r.Context(),
		IdempotencyDeps{Store: deps.Idempotency, Cache: deps.Cache},
		auth.ProductID,
		idemKey,
		IdempotentRequestDescriptor{Method: r.Method, Path: r.URL.Path, Body: requestBody},
		func(ctx context.Context) (IdempotentResult, error) {
			return body(ctx, deps, auth, id, idemKey)
		},
	)
	writeIdempotentOutcomeOrError(w, outcome, err)
}

// writeIdempotentOutcomeOrError translates the result of
// WithIdempotencyKey into an HTTP response — the Go analogue of the TS
// handler's shared tail: `return reply.status(outcome.status).send(outcome.body)`,
// plus (since Go has no central setErrorHandler — see router.go's
// BuildRouter doc comment) this function's own inline mapping of the
// three idempotency sentinel error types to their stable status codes,
// matching server.ts's setErrorHandler instanceof-chain exactly:
//
//	MissingIdempotencyKeyError -> 400
//	IdempotencyConflictError -> 409
//	IdempotencyStillInProgressError -> 409
//
// Any other error falls through to 500, matching the TS
// `const status = error.statusCode ?? 500` default.
func writeIdempotentOutcomeOrError(w http.ResponseWriter, outcome IdempotentOutcome, err error) {
	if err != nil {
		var missingKey *MissingIdempotencyKeyError
		var conflict *IdempotencyConflictError
		var inProgress *IdempotencyStillInProgressError
		switch {
		case errors.As(err, &missingKey):
			WriteProblem(w, http.StatusBadRequest, err.Error(), "")
		case errors.As(err, &conflict):
			WriteProblem(w, http.StatusConflict, err.Error(), "")
		case errors.As(err, &inProgress):
			WriteProblem(w, http.StatusConflict, err.Error(), "")
		default:
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
		}
		return
	}
	writeJSON(w, outcome.Status, outcome.Body)
}

// decodeJSONBody decodes r.Body into dst, writing a 400 problem+json
// response and returning false if the body is missing/malformed —
// the Go analogue of the TS `parsed.success` early-return-with-
// sendValidationError branch, without Zod's structured issue list
// (Go's encoding/json does not expose per-field errors the way Zod
// does — this port surfaces the raw decode error as the problem
// detail instead, which is a materially less precise error message
// than the TS version's per-field Zod issues; see this task's final
// report for this called out as a known gap).
func decodeJSONBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	if r.Body == nil {
		WriteProblem(w, http.StatusBadRequest, "Validation failed", "request body is required")
		return false
	}
	defer r.Body.Close()
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		WriteProblem(w, http.StatusBadRequest, "Validation failed", err.Error())
		return false
	}
	return true
}
