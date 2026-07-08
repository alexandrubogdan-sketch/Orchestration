// Package adapters defines the PspAdapter contract every PSP
// integration (Stripe, Solidgate, mock) implements and nothing more —
// a 1:1 port of the TS reference implementation's src/adapters/types.ts
// (SPEC.md T2.1). Non-negotiable #7: "PSP specifics never leak above
// the adapter. Nothing outside adapters/ may import a PSP SDK or
// reference a PSP-specific status/code." Concretely:
//
//   - internal/adapters/stripe/** is the only package allowed to import
//     github.com/stripe/stripe-go.
//   - internal/adapters/solidgate/** is the only package allowed to
//     build Solidgate-specific request/response shapes.
//   - Every method here returns/accepts canonical types (domain.Money,
//     domain.CanonicalEvent, domain.NormalizedDecline,
//     CanonicalAttemptStatus) — never a raw PSP object, PSP status
//     string, or PSP error type.
//   - NormalizeEvent is the boundary: raw webhook payload in, a slice of
//     domain.CanonicalEvent (the exact same type domain.ApplyTransition
//     consumes) out. The state machine never knows which PSP produced
//     an event.
package adapters

import (
	"context"

	"github.com/alphapayments/payment-orchestrator/internal/domain"
)

// CanonicalAttemptStatus is the normalized attempt status every adapter
// must translate its own PSP-specific status into.
type CanonicalAttemptStatus string

const (
	AttemptStatusPending        CanonicalAttemptStatus = "pending"
	AttemptStatusRequiresAction CanonicalAttemptStatus = "requires_action"
	AttemptStatusAuthorized     CanonicalAttemptStatus = "authorized"
	AttemptStatusCaptured       CanonicalAttemptStatus = "captured"
	AttemptStatusDeclined       CanonicalAttemptStatus = "declined"
	AttemptStatusFailed         CanonicalAttemptStatus = "failed"
	AttemptStatusVoided         CanonicalAttemptStatus = "voided"
	AttemptStatusRefunded       CanonicalAttemptStatus = "refunded"
)

// CanonicalAttemptStatuses enumerates every valid CanonicalAttemptStatus,
// in the same order as the TS CANONICAL_ATTEMPT_STATUSES array.
var CanonicalAttemptStatuses = []CanonicalAttemptStatus{
	AttemptStatusPending,
	AttemptStatusRequiresAction,
	AttemptStatusAuthorized,
	AttemptStatusCaptured,
	AttemptStatusDeclined,
	AttemptStatusFailed,
	AttemptStatusVoided,
	AttemptStatusRefunded,
}

// AuthenticationFlow describes how a completed/attempted 3DS challenge
// resolved.
type AuthenticationFlow string

const (
	AuthenticationFlowFrictionless AuthenticationFlow = "frictionless"
	AuthenticationFlowChallenge    AuthenticationFlow = "challenge"
)

// ThreeDsInfo carries 3D Secure state on an AttemptResult.
type ThreeDsInfo struct {
	Required bool
	// AuthenticationFlow is present only once a challenge has been
	// attempted/completed.
	AuthenticationFlow *AuthenticationFlow
	// ECI is the Electronic Commerce Indicator, when the PSP surfaces one.
	ECI *string
}

// CitMit discriminates customer-initiated from merchant-initiated
// transactions.
type CitMit string

const (
	CitMitCIT CitMit = "cit"
	CitMitMIT CitMit = "mit"
)

// AttemptContext carries the CIT/MIT distinction every attempt must
// make explicit (Non-negotiable #9). MIT attempts must carry
// NetworkTransactionID sourced from a prior CIT attempt on the same
// instrument.
type AttemptContext struct {
	CitMit                CitMit
	NetworkTransactionID *string
}

// CaptureMethod discriminates auth-only from auth+capture-in-one-step.
type CaptureMethod string

const (
	CaptureMethodAutomatic CaptureMethod = "automatic"
	CaptureMethodManual    CaptureMethod = "manual"
)

// ThreeDsMode is the workflow's PayNext-modeled 3DS mode
// (docs.paynext.com/guides/payments/3d-secure's three modes).
type ThreeDsMode string

const (
	ThreeDsModeNo3DS        ThreeDsMode = "no_3ds"
	ThreeDsModeAdaptive     ThreeDsMode = "adaptive"
	ThreeDsModeFrictionless ThreeDsMode = "frictionless"
)

// CreatePaymentInput is the canonical request shape every adapter's
// CreatePayment accepts.
type CreatePaymentInput struct {
	// PaymentID is our internal payment id — always set as PSP metadata
	// for correlation.
	PaymentID        string
	Amount           domain.Money
	PaymentMethodRef string
	Context          AttemptContext
	// IdempotencyKey is forwarded as the PSP's own idempotency key
	// (Non-negotiable #4).
	IdempotencyKey      string
	CaptureMethod       CaptureMethod
	StatementDescriptor *string
	// StatementDescriptorSuffix: 2026-07-08, multi-integration
	// descriptors — Stripe's dynamic per-charge suffix, appended to
	// whatever static prefix is configured on the connected Stripe
	// account itself (docs.stripe.com/get-started/account/
	// statement-descriptors). Lets two psp_accounts against the same
	// Stripe account type (e.g. two brands/business lines routed
	// through separate integrations) show up differently on a
	// cardholder's statement, without needing separate Stripe
	// accounts. Card charges only — see stripe.go's CreatePayment for
	// where this is actually set on the PaymentIntent; adapters that
	// don't support a separate suffix concept (Solidgate, PayPal) may
	// fall back to treating this the same as StatementDescriptor.
	StatementDescriptorSuffix *string
	// CustomerEmail: Milestone 8, T8.5/ADR-0011 — added for Solidgate,
	// whose POST /charge requires a customer email (Stripe does not).
	// Optional so every existing adapter/call site is unaffected;
	// SolidgateAdapter returns a clear error if it's absent rather than
	// silently omitting a field Solidgate's API documents as required.
	CustomerEmail *string
	// ThreeDsMode: optional, defaults to PSP-native behavior if omitted.
	// See stripe package's mapThreeDsModeToStripe for the mapping and
	// its documented gap (no_3ds cannot force-skip issuer-mandated 3DS
	// on Stripe).
	ThreeDsMode *ThreeDsMode
}

// AttemptResult is the canonical response shape every adapter's
// CreatePayment/Capture/Void/GetPayment returns.
type AttemptResult struct {
	// PspAttemptRef is the PSP-side reference (e.g. Stripe PaymentIntent id).
	PspAttemptRef string
	Status        CanonicalAttemptStatus
	// ClientSecret is present only for CIT flows still requiring customer
	// action (e.g. Stripe's PaymentIntent client_secret). Non-negotiable
	// #8: this is the one PSP value allowed to reach the client directly
	// — it must never be logged and never persisted to our own DB.
	ClientSecret         *string
	Decline              *domain.NormalizedDecline
	ThreeDs              *ThreeDsInfo
	NetworkTransactionID *string
	// RawResponseRef is an opaque pointer to where the raw PSP payload
	// was stored, if at all — never the payload itself.
	RawResponseRef *string
}

// RefundStatus is the canonical status a Refund call returns.
type RefundStatus string

const (
	RefundStatusPending   RefundStatus = "pending"
	RefundStatusSucceeded RefundStatus = "succeeded"
	RefundStatusFailed    RefundStatus = "failed"
)

// RefundResult is the canonical response shape every adapter's Refund
// returns.
type RefundResult struct {
	PspRefundRef string
	Status       RefundStatus
	Amount       domain.Money
}

// AttemptSnapshot is the canonical response shape every adapter's
// GetPayment returns — gap-detection polling (Milestone 3, T3.5) for
// when a webhook is missed.
type AttemptSnapshot struct {
	PspAttemptRef string
	Status        CanonicalAttemptStatus
	Decline       *domain.NormalizedDecline
}

// VerifiedEvent is returned by VerifyWebhook once a signature has been
// confirmed valid.
type VerifiedEvent struct {
	// ProviderEventID is the PSP's own event id — the natural key for
	// webhook_inbox dedup.
	ProviderEventID string
	RawPayload      any
}

// InvalidSignatureError is returned by VerifyWebhook — never a "maybe
// valid" result, so callers (the webhook route) can treat any
// non-error return as trustworthy.
type InvalidSignatureError struct {
	PSP    string
	Detail string
}

func (e *InvalidSignatureError) Error() string {
	return "Invalid webhook signature for " + e.PSP + ": " + e.Detail
}

// NewInvalidSignatureError constructs an *InvalidSignatureError.
func NewInvalidSignatureError(psp string, detail string) *InvalidSignatureError {
	return &InvalidSignatureError{PSP: psp, Detail: detail}
}

// PspCapabilities describes what a PSP integration supports.
type PspCapabilities struct {
	Methods               []string
	Currencies            []string
	ThreeDs               bool
	SupportsNetworkTokens bool
}

// SettlementType discriminates the kind of settlement line.
type SettlementType string

const (
	SettlementTypeCapture SettlementType = "capture"
	SettlementTypeRefund  SettlementType = "refund"
	SettlementTypeFee     SettlementType = "fee"
	SettlementTypePayout  SettlementType = "payout"
)

// SettlementRecord is one normalized settlement line — Milestone 6,
// T6.2/ADR-0008: "this PSP-side attempt was settled, for this much, net
// of this fee, as part of this payout" — the settlement-side
// counterpart to AttemptResult. Every field is canonical; nothing
// PSP-specific leaks through (Non-negotiable #7).
type SettlementRecord struct {
	// PspAttemptRef ties back to payment_attempts.psp_attempt_ref for
	// capture/refund lines.
	PspAttemptRef string
	Type          SettlementType
	// Amount is the gross amount of this settlement line (never negative).
	Amount domain.Money
	// FeeAmount is the fee the PSP netted out of this line, if any.
	FeeAmount *domain.Money
	// PspPayoutRef is which payout batch this line was paid out in, if
	// already known.
	PspPayoutRef *string
	OccurredAt   string
}

// PayoutStatus discriminates the state of a payout batch.
type PayoutStatus string

const (
	PayoutStatusPending PayoutStatus = "pending"
	PayoutStatusPaid    PayoutStatus = "paid"
	PayoutStatusFailed  PayoutStatus = "failed"
)

// PayoutRecord is one normalized payout batch.
type PayoutRecord struct {
	PspPayoutRef string
	Status       PayoutStatus
	Amount       domain.Money
	ArrivalDate  *string
}

// AccountUpdateType discriminates the kind of account-updater
// notification.
type AccountUpdateType string

const (
	AccountUpdateTypeCardUpdated AccountUpdateType = "card_updated"
	AccountUpdateTypeCardClosed  AccountUpdateType = "card_closed"
)

// AccountUpdateRecord is a card-network/PSP "account updater"
// notification (Milestone 8, T8.3) — the issuer reissued a card (new
// expiry, or an entirely new PAN behind the same token relationship) or
// closed the account entirely. PspPaymentMethodRef identifies which
// payment_methods row this applies to.
type AccountUpdateRecord struct {
	PspPaymentMethodRef string
	Type                AccountUpdateType
	// NewCardExpMonth/NewCardExpYear are present for card_updated when
	// the issuer supplied a new expiry.
	NewCardExpMonth *int
	NewCardExpYear  *int
	// NewPspPaymentMethodRef is present for card_updated when the PSP
	// reissues an entirely new token rather than updating the existing
	// one in place.
	NewPspPaymentMethodRef *string
}

// PublicConfig is browser-safe configuration for a psp_account — never
// a secret key. Added for the embeddable checkout SDK (checkout_sessions
// feature): the SDK runs in the END USER's browser, which can never
// hold a merchant's Bearer API token or a PSP secret key, but DOES need
// to know which PSP the routing engine picked and that PSP's
// publishable/public key before it can mount the right tokenization UI
// and hand a card off directly to the PSP's own client-side JS.
// GET /v1/checkout-sessions/{id}/public (internal/api/checkout_sessions.go)
// is the only place this crosses the wire.
type PublicConfig struct {
	PSP            string
	PublishableKey string
	// MerchantIdentifier is non-nil only when the PSP needs a second
	// public identifier beyond the publishable/public key itself (e.g.
	// Solidgate's widgets take the same public key as both an account
	// identifier and a "key" parameter — see solidgate.Adapter.PublicConfig's
	// doc comment for exactly what this adapter populates here and why).
	MerchantIdentifier *string
}

// PspAdapter is the contract every PSP integration implements — every
// call that mutates state accepts/forwards an idempotency key
// (Non-negotiable #4). CreatePayment's key comes from
// CreatePaymentInput.IdempotencyKey; the others take it explicitly
// since they aren't tied to a single CreatePaymentInput.
type PspAdapter interface {
	PSP() string

	// PublicConfig returns browser-safe configuration for this PSP
	// account — never a secret key (Non-negotiable #7/#8-adjacent: the
	// only PSP values ever allowed to reach a browser directly are a
	// publishable/public key and, for a CIT flow requiring further
	// action, a client_secret — see AttemptResult.ClientSecret's own doc
	// comment for that second case). The checkout SDK uses this to
	// initialize the correct PSP's client-side JS and mount tokenization
	// fields.
	PublicConfig() PublicConfig

	CreatePayment(ctx context.Context, input CreatePaymentInput) (AttemptResult, error)
	Capture(ctx context.Context, pspAttemptRef string, amount *domain.Money, idempotencyKey string) (AttemptResult, error)
	Void(ctx context.Context, pspAttemptRef string, idempotencyKey string) (AttemptResult, error)
	Refund(ctx context.Context, pspAttemptRef string, amount domain.Money, idempotencyKey string) (RefundResult, error)

	// GetPayment: gap-detection polling (Milestone 3, T3.5) — for when a
	// webhook is missed.
	GetPayment(ctx context.Context, pspAttemptRef string) (AttemptSnapshot, error)

	// VerifyWebhook verifies an inbound webhook's signature. Returns the
	// verified event (opaque raw payload + provider event id) or an
	// *InvalidSignatureError — never a "maybe valid" result, so callers
	// can treat any non-error return as trustworthy.
	VerifyWebhook(rawBody []byte, headers map[string][]string) (VerifiedEvent, error)

	// NormalizeEvent is the ONLY place a raw PSP payload is parsed into
	// canonical events. Returns zero or more domain.CanonicalEvent — zero
	// when the payload doesn't correspond to a payment-state-machine
	// transition we care about.
	NormalizeEvent(rawPayload any) []domain.CanonicalEvent

	// ExtractPaymentID pulls our own internal payment id back out of a
	// raw webhook payload (Milestone 3, T3.2). Every adapter's
	// CreatePayment stamps this id into PSP metadata at creation time
	// specifically so this lookup never needs a database round-trip —
	// nil only if the payload is missing the metadata entirely.
	ExtractPaymentID(rawPayload any) *string

	// ExtractPspAttemptRef pulls the PSP-side attempt reference out of a
	// raw webhook payload, whatever kind of object the event wraps. Some
	// event types don't carry our own metadata (Stripe disputes,
	// notably) so ExtractPaymentID alone can't always resolve the
	// payment; the normalizer worker falls back to looking up
	// payment_attempts.psp_attempt_ref against whatever this returns.
	ExtractPspAttemptRef(rawPayload any) *string

	// NormalizeDecline maps a raw PSP decline code to our taxonomy, via
	// decline_code_map.
	NormalizeDecline(rawCode string) domain.NormalizedDecline

	Capabilities() PspCapabilities

	// ListSettlements returns every settlement line (capture/refund/fee/
	// payout) the PSP recorded at or after sinceISO, normalized
	// (Milestone 6, T6.2). This is the ONLY place a PSP's settlement/
	// balance-transaction API is called.
	ListSettlements(ctx context.Context, sinceISO string) ([]SettlementRecord, error)

	// ListPayouts returns every payout batch at or after sinceISO,
	// normalized.
	ListPayouts(ctx context.Context, sinceISO string) ([]PayoutRecord, error)

	// ListAccountUpdates returns every card-network account-updater
	// notification at or after sinceISO (Milestone 8, T8.3). Not every
	// PSP exposes an equivalent polling API for this — an empty slice is
	// a legitimate response, not a bug, for a PSP whose account updates
	// arrive some other way (or not at all through this integration).
	ListAccountUpdates(ctx context.Context, sinceISO string) ([]AccountUpdateRecord, error)
}
