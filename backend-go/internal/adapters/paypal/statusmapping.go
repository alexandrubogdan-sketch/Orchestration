package paypal

import (
	"github.com/alphapayments/payment-orchestrator/internal/adapters"
	"github.com/alphapayments/payment-orchestrator/internal/domain"
)

// Order mirrors PayPal's Orders API v2 order resource
// (developer.paypal.com/docs/api/orders/v2/#orders_create /
// #orders_get / #orders_capture responses), the subset this adapter
// reads. status enum (confirmed against PayPal's documented Order
// Status values): "CREATED", "SAVED", "APPROVED", "VOIDED",
// "COMPLETED", "PAYER_ACTION_REQUIRED".
type Order struct {
	ID            string          `json:"id"`
	Status        string          `json:"status"`
	Intent        string          `json:"intent,omitempty"`
	PurchaseUnits []PurchaseUnit  `json:"purchase_units,omitempty"`
	Links         []Link          `json:"links,omitempty"`
}

// PurchaseUnit mirrors one entry of order.purchase_units — this
// adapter only ever sends/reads a single purchase unit per order (see
// CreatePayment in paypal.go), so every accessor below indexes [0]
// defensively rather than modeling PayPal's array as a first-class
// concept this codebase's callers need to reason about.
type PurchaseUnit struct {
	Amount   *Amount          `json:"amount,omitempty"`
	CustomID string           `json:"custom_id,omitempty"`
	Payments *PurchaseUnitPayments `json:"payments,omitempty"`
}

// Amount mirrors PayPal's amount object: {"currency_code": "USD",
// "value": "100.00"} — value is a DECIMAL STRING, not minor units, per
// PayPal's documented amount object (unlike Stripe/Solidgate, which
// both take integer minor units) — see amountToPayPalValue/
// payPalValueToMinorUnits in paypal.go for the conversion this
// difference requires.
type Amount struct {
	CurrencyCode string `json:"currency_code"`
	Value        string `json:"value"`
}

// PurchaseUnitPayments mirrors purchase_units[0].payments, populated
// on a captured/authorized order.
type PurchaseUnitPayments struct {
	Captures      []Capture      `json:"captures,omitempty"`
	Authorizations []Authorization `json:"authorizations,omitempty"`
	Refunds       []Refund       `json:"refunds,omitempty"`
}

// Capture mirrors a PayPal capture resource
// (developer.paypal.com/docs/api/payments/v2/#captures_get). status
// enum: "COMPLETED", "DECLINED", "PARTIALLY_REFUNDED", "PENDING",
// "REFUNDED", "FAILED".
type Capture struct {
	ID            string               `json:"id"`
	Status        string               `json:"status"`
	Amount        *Amount              `json:"amount,omitempty"`
	StatusDetails *CaptureStatusDetails `json:"status_details,omitempty"`
}

// CaptureStatusDetails mirrors capture.status_details.reason — the
// field this adapter's decline normalization reads (see
// ExtractDeclineCode below). reason enum confirmed against PayPal's
// documented Capture Status Details values.
type CaptureStatusDetails struct {
	Reason string `json:"reason,omitempty"`
}

// Authorization mirrors a PayPal authorization resource
// (developer.paypal.com/docs/api/payments/v2/#authorizations_get).
// status enum: "CREATED", "CAPTURED", "DENIED", "PARTIALLY_CAPTURED",
// "VOIDED", "PENDING".
type Authorization struct {
	ID     string  `json:"id"`
	Status string  `json:"status"`
	Amount *Amount `json:"amount,omitempty"`
}

// Refund mirrors a PayPal refund resource
// (developer.paypal.com/docs/api/payments/v2/#refunds_get). status
// enum: "CANCELLED", "COMPLETED", "PENDING", "FAILED".
type Refund struct {
	ID     string  `json:"id"`
	Status string  `json:"status"`
	Amount *Amount `json:"amount,omitempty"`
}

// Link mirrors one entry of order.links — HATEOAS navigation links
// PayPal returns alongside a created order. rel == "approve" is the
// buyer-approval redirect URL this adapter surfaces as
// AttemptResult.ClientSecret's PayPal-shaped analogue (see
// approveLink/toAttemptResult in paypal.go).
type Link struct {
	Href   string `json:"href"`
	Rel    string `json:"rel"`
	Method string `json:"method,omitempty"`
}

// mapOrderStatus maps a PayPal Order.Status -> canonical attempt
// status (the CreatePayment/GetPayment side of the split PayPal
// requires between orders and captures/authorizations — see
// mapCaptureStatus/mapAuthorizationStatus below for the other half).
//
// "CREATED"/"SAVED" (nothing has happened yet, no buyer action taken)
// map to pending, matching Stripe's requires_payment_method-before-
// any-confirm-attempt case (statusmapping.go's mapPaymentIntentStatus
// docblock). "APPROVED" (buyer completed the approval redirect, funds
// not yet captured) maps to authorized — mirroring Stripe's
// requires_capture exactly, per this port's step-6 confirmation that
// Stripe's requires_capture -> AttemptStatusAuthorized (not "pending")
// is the template CHECKOUT.ORDER.APPROVED must follow, since in both
// cases the payment is reserved/approved and merely awaiting an
// explicit capture call, not still pending buyer action.
// "PAYER_ACTION_REQUIRED" (3DS/additional buyer action still pending,
// distinct from the initial approval redirect) maps to
// requires_action, PayPal's own documented status for this case.
// "COMPLETED" maps to captured (an order intent=CAPTURE order that
// has finished capturing). "VOIDED" maps to voided.
func mapOrderStatus(status string) adapters.CanonicalAttemptStatus {
	switch status {
	case "CREATED", "SAVED":
		return adapters.AttemptStatusPending
	case "APPROVED":
		return adapters.AttemptStatusAuthorized
	case "PAYER_ACTION_REQUIRED":
		return adapters.AttemptStatusRequiresAction
	case "COMPLETED":
		return adapters.AttemptStatusCaptured
	case "VOIDED":
		return adapters.AttemptStatusVoided
	default:
		return adapters.AttemptStatusPending
	}
}

// mapCaptureStatus maps a PayPal Capture.Status -> canonical attempt
// status — the result of an explicit /capture call (order-level or
// authorization-level).
func mapCaptureStatus(status string) adapters.CanonicalAttemptStatus {
	switch status {
	case "COMPLETED":
		return adapters.AttemptStatusCaptured
	case "PENDING":
		return adapters.AttemptStatusPending
	case "DECLINED", "FAILED":
		return adapters.AttemptStatusDeclined
	case "REFUNDED":
		return adapters.AttemptStatusRefunded
	case "PARTIALLY_REFUNDED":
		// No canonical status distinguishes "fully" vs "partially"
		// refunded — captured is the closer of the two available
		// options (the capture itself is still fundamentally settled
		// funds, just with a later, separate refund reducing it),
		// matching how this codebase's canonical taxonomy has no
		// partial-refund concept at the attempt-status level anywhere
		// else either (see adapters.AttemptStatusRefunded's own single,
		// non-partial meaning throughout stripe/solidgate).
		return adapters.AttemptStatusCaptured
	default:
		return adapters.AttemptStatusPending
	}
}

// mapAuthorizationStatus maps a PayPal Authorization.Status ->
// canonical attempt status — used only when this adapter is dealing
// with a prior authorization directly (Capture-a-prior-authorization,
// Void).
func mapAuthorizationStatus(status string) adapters.CanonicalAttemptStatus {
	switch status {
	case "CREATED", "PENDING":
		return adapters.AttemptStatusAuthorized
	case "CAPTURED":
		return adapters.AttemptStatusCaptured
	case "PARTIALLY_CAPTURED":
		return adapters.AttemptStatusCaptured
	case "DENIED":
		return adapters.AttemptStatusDeclined
	case "VOIDED":
		return adapters.AttemptStatusVoided
	default:
		return adapters.AttemptStatusPending
	}
}

// extractCapture returns purchase_units[0].payments.captures[0], if
// present — the shape a successful order-level or
// authorization-level capture call populates.
func extractCapture(order *Order) *Capture {
	if order == nil || len(order.PurchaseUnits) == 0 || order.PurchaseUnits[0].Payments == nil {
		return nil
	}
	captures := order.PurchaseUnits[0].Payments.Captures
	if len(captures) == 0 {
		return nil
	}
	return &captures[0]
}

// extractAuthorization returns
// purchase_units[0].payments.authorizations[0], if present.
func extractAuthorization(order *Order) *Authorization {
	if order == nil || len(order.PurchaseUnits) == 0 || order.PurchaseUnits[0].Payments == nil {
		return nil
	}
	auths := order.PurchaseUnits[0].Payments.Authorizations
	if len(auths) == 0 {
		return nil
	}
	return &auths[0]
}

// approveLink returns the "approve" rel link's Href from order.links,
// if present — the redirect URL a CIT buyer must complete before this
// order can be captured (PayPal's fundamentally different, browser-
// redirect-based flow vs. Stripe/Solidgate's server-to-server
// confirm — see paypal.go's package doc comment).
func approveLink(order *Order) *string {
	if order == nil {
		return nil
	}
	for _, link := range order.Links {
		if link.Rel == "approve" {
			href := link.Href
			return &href
		}
	}
	return nil
}

// declineReasonToCategory maps PayPal's documented
// capture.status_details.reason values (on a DENIED/FAILED capture)
// to this codebase's domain.DeclineCategory taxonomy — the same
// target enum stripe/statusmapping.go's decline handling normalizes
// into via decline_code_map, except here the mapping is a static,
// hand-authored table rather than a DB-backed decline_code_map lookup,
// because PayPal's reason values are a small, fully enumerated set
// (unlike card-network issuer decline codes, which decline_code_map
// exists specifically to keep out of code). NormalizeDecline (below)
// still checks the injected declineMap FIRST, exactly like
// stripe.normalizeStripeDecline/solidgate.NormalizeDecline, so an
// operator-configured decline_code_map row always wins over this
// built-in fallback table.
var declineReasonToCategory = map[string]domain.DeclineCategory{
	"INSUFFICIENT_FUNDS":                   domain.DeclineCategorySoft,
	"INSTRUMENT_DECLINED":                  domain.DeclineCategorySoft,
	"ECHECK":                               domain.DeclineCategorySoft,
	"PAYER_CANNOT_PAY":                     domain.DeclineCategorySoft,
	"TRANSACTION_RECEIVING_LIMIT_EXCEEDED": domain.DeclineCategorySoft,
	"INSTRUMENT_TYPE_CHANGE":               domain.DeclineCategorySoft,

	"BUYER_COMPLAINT":            domain.DeclineCategoryFraud,
	"CHARGEBACK":                 domain.DeclineCategoryFraud,
	"REFUNDED":                   domain.DeclineCategoryFraud,
	"COMPLIANCE_VIOLATION":       domain.DeclineCategoryFraud,
	"PAYEE_FILTER_RESTRICTIONS":  domain.DeclineCategoryFraud,

	"PAYER_ACCOUNT_RESTRICTED":  domain.DeclineCategoryHard,
	"PAYEE_ACCOUNT_RESTRICTED":  domain.DeclineCategoryHard,
	"USER_UNAUTHORIZED":         domain.DeclineCategoryHard,
	"DECLINED_ORDER":            domain.DeclineCategoryHard,
	"GUARANTEE":                 domain.DeclineCategoryHard,

	"INTERNAL_SERVER_ERROR": domain.DeclineCategoryTechnical,
}

// declineReasonToRetryClass mirrors declineReasonToCategory's keys,
// mapping each to this codebase's domain.DeclineRetryClass taxonomy —
// see that struct's own doc comment (internal/domain/declines.go) for
// what each class means to the retry engine (a later phase).
var declineReasonToRetryClass = map[string]domain.DeclineRetryClass{
	"INSUFFICIENT_FUNDS":                   domain.RetryClassSameInstrumentLater,
	"INSTRUMENT_DECLINED":                  domain.RetryClassSameInstrumentLater,
	"ECHECK":                               domain.RetryClassSameInstrumentLater,
	"PAYER_CANNOT_PAY":                     domain.RetryClassSameInstrumentLater,
	"TRANSACTION_RECEIVING_LIMIT_EXCEEDED": domain.RetryClassSameInstrumentLater,
	"INSTRUMENT_TYPE_CHANGE":               domain.RetryClassRetryAfterChallenge,

	"BUYER_COMPLAINT":           domain.RetryClassReview,
	"CHARGEBACK":                domain.RetryClassReview,
	"REFUNDED":                  domain.RetryClassNever,
	"COMPLIANCE_VIOLATION":      domain.RetryClassReview,
	"PAYEE_FILTER_RESTRICTIONS": domain.RetryClassReview,

	"PAYER_ACCOUNT_RESTRICTED": domain.RetryClassNever,
	"PAYEE_ACCOUNT_RESTRICTED": domain.RetryClassNever,
	"USER_UNAUTHORIZED":        domain.RetryClassNever,
	"DECLINED_ORDER":           domain.RetryClassNever,
	"GUARANTEE":                domain.RetryClassNever,

	"INTERNAL_SERVER_ERROR": domain.RetryClassRetryDifferentPSP,
}

// NormalizeDecline looks up a raw PayPal status_details.reason against
// the in-memory decline map (loaded from decline_code_map at adapter
// construction, exactly like stripe.normalizeStripeDecline/
// solidgate.NormalizeDecline) first, then falls back to this
// package's own built-in declineReasonToCategory/RetryClass tables
// (see their doc comments for why a built-in fallback exists here
// specifically), and finally to domain.UnmappedDecline if the reason
// is not recognized by either.
func NormalizeDecline(declineMap map[string]domain.NormalizedDecline, rawCode string) domain.NormalizedDecline {
	if d, ok := declineMap[rawCode]; ok {
		return d
	}
	category, categoryOK := declineReasonToCategory[rawCode]
	retryClass, retryClassOK := declineReasonToRetryClass[rawCode]
	if categoryOK && retryClassOK {
		return domain.NormalizedDecline{
			PSP:            "paypal",
			RawCode:        rawCode,
			NormalizedCode: rawCode,
			Category:       category,
			RetryClass:     retryClass,
		}
	}
	return domain.UnmappedDecline("paypal", rawCode)
}

// ExtractDeclineCode reads capture.status_details.reason off a
// DENIED/FAILED capture — the field PayPal documents as carrying the
// decline reason (developer.paypal.com/docs/api/payments/v2/#captures_get,
// "status_details.reason"). Returns nil if absent, matching how
// stripe/statusmapping.go's extractRawDeclineCode returns nil when
// Stripe's own decline-code fields are unpopulated.
func ExtractDeclineCode(capture *Capture) *string {
	if capture == nil || capture.StatusDetails == nil || capture.StatusDetails.Reason == "" {
		return nil
	}
	reason := capture.StatusDetails.Reason
	return &reason
}
