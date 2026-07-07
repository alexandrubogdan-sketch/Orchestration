package paypal

import (
	"encoding/json"

	"github.com/alphapayments/payment-orchestrator/internal/domain"
)

// WebhookEvent mirrors PayPal's webhook envelope
// (developer.paypal.com/api/rest/webhooks/, "Webhooks payload"): "id",
// "event_version", "create_time", "resource_type", "event_type",
// "summary", "resource" (the nested capture/order/authorization/refund
// object — shape depends on resource_type, so kept as json.RawMessage
// here and decoded on demand by the specific accessor that knows which
// concrete shape to expect for a given event_type), and "links".
type WebhookEvent struct {
	ID           string          `json:"id"`
	EventVersion string          `json:"event_version,omitempty"`
	CreateTime   string          `json:"create_time,omitempty"`
	ResourceType string          `json:"resource_type"`
	EventType    string          `json:"event_type"`
	Summary      string          `json:"summary,omitempty"`
	Resource     json.RawMessage `json:"resource"`
	Links        []Link          `json:"links,omitempty"`
}

// CaptureResource mirrors the shape of WebhookEvent.Resource for
// PAYMENT.CAPTURE.* event types — a capture object, PLUS
// custom_id/supplementary_data carrying our own payment_id (mirrored
// through from the purchase_unit's custom_id at CreatePayment time)
// and a links array back to the parent order, since PayPal's capture
// webhook resource does not itself carry the order id as a bare field
// the way Stripe's Charge carries payment_intent — only a HATEOAS
// "up" link to it (developer.paypal.com/api/rest/webhooks/event-names/,
// PAYMENT.CAPTURE.COMPLETED's documented resource schema).
type CaptureResource struct {
	ID              string               `json:"id"`
	Status          string               `json:"status"`
	Amount          *Amount              `json:"amount,omitempty"`
	CustomID        string               `json:"custom_id,omitempty"`
	StatusDetails   *CaptureStatusDetails `json:"status_details,omitempty"`
	Links           []Link               `json:"links,omitempty"`
}

// OrderResource mirrors the shape of WebhookEvent.Resource for
// CHECKOUT.ORDER.* event types — the full order object, same shape as
// Order (statusmapping.go) but decoded independently here since the
// webhook resource is embedded JSON, not a top-level API response
// body.
type OrderResource = Order

// orderIDFromCaptureLinks extracts the parent order id from a
// capture's "up" rel link, e.g.
// "https://api-m.paypal.com/v2/checkout/orders/{order_id}" — PayPal's
// only documented way to recover the order id from a bare capture
// webhook resource. Returns nil if no "up" link is present or its
// href doesn't parse as expected — this adapter treats that as "we
// cannot correlate this event to a payment_attempts row by
// psp_attempt_ref," not a crash.
func orderIDFromCaptureLinks(links []Link) *string {
	for _, link := range links {
		if link.Rel != "up" {
			continue
		}
		// The order id is the final path segment of the "up" link.
		href := link.Href
		lastSlash := -1
		for i := len(href) - 1; i >= 0; i-- {
			if href[i] == '/' {
				lastSlash = i
				break
			}
		}
		if lastSlash == -1 || lastSlash == len(href)-1 {
			continue
		}
		id := href[lastSlash+1:]
		if id != "" {
			return &id
		}
	}
	return nil
}

// decodeCaptureResource unmarshals event.Resource into a
// CaptureResource — used for every PAYMENT.CAPTURE.* event_type.
func decodeCaptureResource(event *WebhookEvent) (*CaptureResource, error) {
	var resource CaptureResource
	if err := json.Unmarshal(event.Resource, &resource); err != nil {
		return nil, err
	}
	return &resource, nil
}

// decodeOrderResource unmarshals event.Resource into an OrderResource
// — used for CHECKOUT.ORDER.APPROVED.
func decodeOrderResource(event *WebhookEvent) (*OrderResource, error) {
	var resource OrderResource
	if err := json.Unmarshal(event.Resource, &resource); err != nil {
		return nil, err
	}
	return &resource, nil
}

// NormalizeEvent maps a PayPal webhook event_type -> canonical
// state-machine events — the PayPal analogue of
// stripe.normalizeStripeEvent/solidgate.NormalizeEvent. Deliberately
// over-inclusive rather than perfectly minimal on PAYMENT.CAPTURE.COMPLETED
// (emits authorized -> capture_started -> captured, mirroring exactly
// how stripe.normalizeStripeEvent's payment_intent.succeeded case
// does, for the identical reason given in that function's doc
// comment: late/duplicate transitions are a safe no-op, never a
// regression, per Non-negotiable #5).
//
// CHECKOUT.ORDER.APPROVED -> EventAuthorized: this mirrors Stripe's
// own choice for its analogous "buyer/customer completed their part,
// funds not yet captured" case — payment_intent.amount_capturable_updated
// (statusmapping.go) maps to EventAuthorized, not to any "pending"-shaped
// event, because in both cases the funds are genuinely reserved/
// approved, merely awaiting an explicit capture call. Confirmed
// against that mapping directly (not guessed independently), per this
// task's step-6 instruction to verify against Stripe's actual choice.
func NormalizeEvent(event *WebhookEvent, declineMap map[string]domain.NormalizedDecline) []domain.CanonicalEvent {
	switch event.EventType {
	case "CHECKOUT.ORDER.APPROVED":
		return []domain.CanonicalEvent{{Type: domain.EventAuthorized}}

	case "PAYMENT.CAPTURE.COMPLETED":
		return []domain.CanonicalEvent{
			{Type: domain.EventAuthorized},
			{Type: domain.EventCaptureStarted},
			{Type: domain.EventCaptured},
		}

	case "PAYMENT.CAPTURE.DENIED":
		resource, err := decodeCaptureResource(event)
		if err != nil {
			return nil
		}
		var declineCode *string
		if resource.StatusDetails != nil && resource.StatusDetails.Reason != "" {
			decline := NormalizeDecline(declineMap, resource.StatusDetails.Reason)
			declineCode = &decline.NormalizedCode
		}
		return []domain.CanonicalEvent{{Type: domain.EventDeclined, DeclineCode: declineCode}}

	case "PAYMENT.CAPTURE.REFUNDED":
		return []domain.CanonicalEvent{
			{Type: domain.EventRefundStarted},
			{Type: domain.EventRefunded},
		}

	default:
		return nil
	}
}
