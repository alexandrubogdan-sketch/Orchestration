package api

import (
	"context"

	"github.com/alphapayments/payment-orchestrator/internal/domain"
)

// This file collects every "not yet implemented" stand-in this phase
// wires by default in cmd/api/main.go — see payments.go's and
// customers.go's top doc comments for exactly what each stub is
// standing in for and why (every one of them depends on a later
// phase's DB layer, routing engine, or circuit breaker, none of which
// exist yet in this Go port). Each stub method returns ErrNotImplemented
// (or, for TokenStore/AuditLogWriter/IdempotencyStore/IdempotencyCache,
// the closest equivalent sentinel) rather than panicking, so the
// server as a whole still boots and /healthz, /readyz still work
// correctly even though every /v1/* business route currently responds
// 501/401 — a deliberate "fail loud and structured, not crash" choice
// for this phase's narrower scope.

// UnimplementedPaymentsStore is the default PaymentsStore
// cmd/api/main.go wires until a later phase's DB + routing-engine
// layers exist.
type UnimplementedPaymentsStore struct{}

func (UnimplementedPaymentsStore) ResolveCustomerID(context.Context, string, *string, *string) (string, error) {
	return "", ErrNotImplemented
}
func (UnimplementedPaymentsStore) FindPaymentByIdempotencyKey(context.Context, string) (PaymentRow, bool, error) {
	return PaymentRow{}, false, ErrNotImplemented
}
func (UnimplementedPaymentsStore) ResolveRouting(context.Context, string, string, string, string) (RoutingDecision, error) {
	return RoutingDecision{}, ErrNotImplemented
}
func (UnimplementedPaymentsStore) CreatePayment(context.Context, CreatePaymentRow) (PaymentRow, error) {
	return PaymentRow{}, ErrNotImplemented
}
func (UnimplementedPaymentsStore) GetPspAccount(context.Context, string) (PspAccountRow, error) {
	return PspAccountRow{}, ErrNotImplemented
}
func (UnimplementedPaymentsStore) FindAttempt(context.Context, string, int) (AttemptRow, bool, error) {
	return AttemptRow{}, false, ErrNotImplemented
}
func (UnimplementedPaymentsStore) LatestAttempt(context.Context, string) (AttemptRow, bool, error) {
	return AttemptRow{}, false, ErrNotImplemented
}
func (UnimplementedPaymentsStore) UpsertPaymentMethod(context.Context, string, string, string) (PaymentMethodRow, error) {
	return PaymentMethodRow{}, ErrNotImplemented
}
func (UnimplementedPaymentsStore) LookupCustomerEmail(context.Context, string) (string, bool, error) {
	return "", false, ErrNotImplemented
}
func (UnimplementedPaymentsStore) RecordAttempt(context.Context, RecordAttemptRow) error {
	return ErrNotImplemented
}
func (UnimplementedPaymentsStore) ApplyCanonicalEvents(context.Context, string, []domain.CanonicalEvent, string) error {
	return ErrNotImplemented
}
func (UnimplementedPaymentsStore) GetPayment(context.Context, string, string) (PaymentRow, bool, error) {
	return PaymentRow{}, false, ErrNotImplemented
}
func (UnimplementedPaymentsStore) ListAttempts(context.Context, string) ([]AttemptRow, error) {
	return nil, ErrNotImplemented
}
func (UnimplementedPaymentsStore) ListEvents(context.Context, string) ([]PaymentEventRow, error) {
	return nil, ErrNotImplemented
}
func (UnimplementedPaymentsStore) ListPayments(context.Context, string, ListPaymentsQuery) ([]PaymentRow, error) {
	return nil, ErrNotImplemented
}

// UnimplementedCustomersStore is the default CustomersStore
// cmd/api/main.go wires until a later phase's DB layer exists.
type UnimplementedCustomersStore struct{}

func (UnimplementedCustomersStore) FindCustomer(context.Context, string, string) (bool, error) {
	return false, ErrNotImplemented
}
func (UnimplementedCustomersStore) ListActivePaymentMethods(context.Context, string) ([]PaymentMethodRow, error) {
	return nil, ErrNotImplemented
}

// NoopCircuitBreaker is the default CircuitBreaker cmd/api/main.go
// wires until T5.3's Go port exists — every call is a no-op success,
// matching "no circuit breaker installed" rather than "every call
// trips the breaker."
type NoopCircuitBreaker struct{}

func (NoopCircuitBreaker) RecordFailure(context.Context, string) error { return nil }
func (NoopCircuitBreaker) RecordSuccess(context.Context, string) error { return nil }

// UnavailableTokenStore is the default TokenStore cmd/api/main.go
// wires until a later phase's DB layer exists — every lookup fails
// closed (ErrTokenNotFound), so every /v1/* request is rejected 401
// rather than the server accidentally running with authentication
// silently disabled.
type UnavailableTokenStore struct{}

func (UnavailableTokenStore) Lookup(context.Context, string) (TokenRow, error) {
	return TokenRow{}, ErrTokenNotFound
}

// NoopAuditLogWriter is the default AuditLogWriter cmd/api/main.go
// wires until a later phase's DB layer exists — writes are accepted
// and discarded rather than erroring, matching this file's stated
// "audit logging must never break the request" guarantee: better to
// silently not audit yet than to reject every request over a missing
// audit sink.
type NoopAuditLogWriter struct{}

func (NoopAuditLogWriter) Write(context.Context, AuditLogEntry) error { return nil }

// UnavailableIdempotencyStore is the default IdempotencyStore
// cmd/api/main.go wires until a later phase's DB layer exists. Every
// method fails with ErrNotImplemented — a mutating route that reaches
// WithIdempotencyKey with this store wired returns 500, which is
// correct: without a real Postgres-backed store, this phase cannot
// honestly claim to enforce Non-negotiable #4/#2's idempotency
// guarantee at all, so it must not silently pretend to.
type UnavailableIdempotencyStore struct{}

func (UnavailableIdempotencyStore) Insert(context.Context, string, string) error {
	return ErrNotImplemented
}
func (UnavailableIdempotencyStore) Get(context.Context, string) (IdempotencyKeyRow, error) {
	return IdempotencyKeyRow{}, ErrNotImplemented
}
func (UnavailableIdempotencyStore) Complete(context.Context, string, int, any) error {
	return ErrNotImplemented
}
func (UnavailableIdempotencyStore) Delete(context.Context, string) error {
	return ErrNotImplemented
}
