package solidgate

import (
	"github.com/alphapayments/payment-orchestrator/internal/adapters"
	"github.com/alphapayments/payment-orchestrator/internal/domain"
)

// ChargeOrder mirrors Solidgate's order shape, confirmed against
// api-docs.solidgate.com/api/card-payments/make-card-charge (per the TS
// reference implementation, fetched and read there — not guessed):
//
//   - order.status enum: "processing", "3ds_verify", "refunded",
//     "auth_ok", "auth_failed", "settle_ok", "partial_settled",
//     "void_ok".
type ChargeOrder struct {
	OrderID        string `json:"order_id"`
	Status         string `json:"status"`
	SubscriptionID string `json:"subscription_id,omitempty"`
}

// ChargeTransaction mirrors Solidgate's transaction shape:
//   - transaction.operation enum: "recurring-auth", "refund",
//     "resign-auth", "auth", "settle", "void", "apple-pay", "google-pay".
//   - transaction.status enum: "processing", "success", "fail", "verify".
type ChargeTransaction struct {
	ID        string         `json:"id"`
	Operation string         `json:"operation"`
	Status    string         `json:"status"`
	CardToken *CardTokenInfo `json:"card_token,omitempty"`
}

// CardTokenInfo mirrors transaction.card_token in Solidgate's response.
type CardTokenInfo struct {
	Token string `json:"token"`
}

// ChargeResponse is Solidgate's /charge (and /settle, /void, /refund,
// /status) response shape.
//
// FLAGGED (per SPEC.md's working agreement — encode ambiguity, don't
// guess): the confirmed response schema (read through the "Success"
// variant in the TS reference implementation's research session) has
// no explicit decline/error-code field in the portion fetched. Rather
// than invent a plausible-sounding field name with no evidence behind
// it, ExtractDeclineCode always returns nil today — every decline
// normalizes via domain.UnmappedDecline, which is honest ("we know it
// declined, we don't yet know why") rather than silently wrong. Confirm
// the actual field (likely somewhere in Solidgate's error-response
// variant, a oneOf branch the original research session's fetch didn't
// expand) against a live sandbox response before this adapter's
// decline handling is production-ready.
type ChargeResponse struct {
	Order       ChargeOrder         `json:"order"`
	Transaction *ChargeTransaction  `json:"transaction,omitempty"`
}

var orderStatusToCanonical = map[string]adapters.CanonicalAttemptStatus{
	"processing":      adapters.AttemptStatusPending,
	"3ds_verify":       adapters.AttemptStatusRequiresAction,
	"auth_ok":          adapters.AttemptStatusAuthorized,
	"auth_failed":      adapters.AttemptStatusDeclined,
	"settle_ok":        adapters.AttemptStatusCaptured,
	"partial_settled":  adapters.AttemptStatusCaptured,
	"void_ok":          adapters.AttemptStatusVoided,
	"refunded":         adapters.AttemptStatusRefunded,
}

// MapOrderStatus maps a raw Solidgate order.status to a canonical
// attempt status. Falls back to "failed" for any unrecognized status —
// the field this project's SPEC.md convention calls "encode ambiguity,
// don't guess": an unrecognized status is closer to "something went
// wrong we don't have a mapping for" than any of the known success/
// pending statuses.
func MapOrderStatus(orderStatus string) adapters.CanonicalAttemptStatus {
	if status, ok := orderStatusToCanonical[orderStatus]; ok {
		return status
	}
	return adapters.AttemptStatusFailed
}

// ExtractDeclineCode: see ChargeResponse's docblock — always nil until
// the real field is confirmed against a live sandbox response.
func ExtractDeclineCode(_ ChargeResponse) *string {
	return nil
}

// NormalizeDecline looks up a raw Solidgate code against the in-memory
// decline map and falls back to domain.UnmappedDecline.
func NormalizeDecline(declineMap map[string]domain.NormalizedDecline, rawCode string) domain.NormalizedDecline {
	if d, ok := declineMap[rawCode]; ok {
		return d
	}
	return domain.UnmappedDecline("solidgate", rawCode)
}

// NormalizeEvent maps a Solidgate webhook payload shape —
// card_gate.order.updated
// (docs.solidgate.com/payments/integrate/webhooks/#card-payments) — to
// canonical state-machine events.
//
// FLAGGED: assumed to carry the same {order, transaction} shape as the
// charge response's own "Success" body — Solidgate's docs describe the
// webhook body as "event-related information, like order events"
// without an independently fetched schema for this specific event type
// (same limitation as the TS reference implementation).
func NormalizeEvent(body *ChargeResponse) []domain.CanonicalEvent {
	if body == nil || body.Order.OrderID == "" {
		return nil
	}

	status := MapOrderStatus(body.Order.Status)
	switch status {
	case adapters.AttemptStatusRequiresAction:
		return []domain.CanonicalEvent{{Type: domain.EventAuthenticationRequired}}
	case adapters.AttemptStatusAuthorized:
		return []domain.CanonicalEvent{{Type: domain.EventAuthorized}}
	case adapters.AttemptStatusCaptured:
		return []domain.CanonicalEvent{
			{Type: domain.EventAuthorized},
			{Type: domain.EventCaptureStarted},
			{Type: domain.EventCaptured},
		}
	case adapters.AttemptStatusDeclined:
		declineCode := ExtractDeclineCode(*body)
		return []domain.CanonicalEvent{{Type: domain.EventDeclined, DeclineCode: declineCode}}
	case adapters.AttemptStatusFailed:
		return []domain.CanonicalEvent{{Type: domain.EventAuthorizationFailed}}
	case adapters.AttemptStatusVoided:
		return []domain.CanonicalEvent{{Type: domain.EventVoided}}
	case adapters.AttemptStatusRefunded:
		return []domain.CanonicalEvent{
			{Type: domain.EventRefundStarted},
			{Type: domain.EventRefunded},
		}
	case adapters.AttemptStatusPending:
		return nil
	default:
		return nil
	}
}
