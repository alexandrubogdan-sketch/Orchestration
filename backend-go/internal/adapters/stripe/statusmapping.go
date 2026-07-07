package stripe

import (
	stripesdk "github.com/stripe/stripe-go/v81"

	"github.com/alphapayments/payment-orchestrator/internal/adapters"
	"github.com/alphapayments/payment-orchestrator/internal/domain"
)

// mapPaymentIntentStatus maps a Stripe PaymentIntent.Status ->
// canonical status (T2.4). This is the ONLY function in this codebase
// allowed to reference a raw Stripe status string (Non-negotiable #7).
//
// Ambiguity flagged per SPEC.md's working agreement ("encode ambiguity
// as a golden-file contract test with a comment"): requires_payment_method
// is Stripe's status both *before* the first confirm attempt (nothing
// has happened yet) and *after* a failed confirm attempt (the customer
// needs to try a different payment method). We disambiguate using
// LastPaymentError: present -> declined, absent -> still pending. See
// internal/adapters/stripe/testdata/requires_payment_method.*.json for
// both cases.
//
// status/lastPaymentError are taken as plain string / *stripe.Error
// rather than the named stripe.PaymentIntentStatus type: this function
// compares against Stripe's own documented status string values
// directly (stripe-go's stripe.PaymentIntent.Status field is exported
// as a named string type in most SDK versions, which converts
// implicitly to/from a plain string at the call site — comparing raw
// string literals here avoids depending on the exact spelling of
// per-status named constants like "PaymentIntentStatusRequiresCapture",
// which this port's author could not verify against the installed
// SDK version without network access).
func mapPaymentIntentStatus(status string, lastPaymentError *stripesdk.Error) adapters.CanonicalAttemptStatus {
	switch status {
	case "succeeded":
		return adapters.AttemptStatusCaptured
	case "requires_capture":
		return adapters.AttemptStatusAuthorized
	case "canceled":
		return adapters.AttemptStatusVoided
	case "requires_action":
		return adapters.AttemptStatusRequiresAction
	case "processing", "requires_confirmation":
		return adapters.AttemptStatusPending
	case "requires_payment_method":
		if lastPaymentError != nil {
			return adapters.AttemptStatusDeclined
		}
		return adapters.AttemptStatusPending
	default:
		return adapters.AttemptStatusPending
	}
}

// extractRawDeclineCode extracts the raw decline code Stripe attaches
// to a failed confirmation. Prefers DeclineCode (issuer-level reason,
// e.g. "insufficient_funds") over Code (Stripe-level error code, e.g.
// "card_declined") since DeclineCode is the more specific signal our
// decline_code_map is keyed on — but Code is the fallback for non-card
// errors that never populate DeclineCode.
func extractRawDeclineCode(lastPaymentError *stripesdk.Error) *string {
	if lastPaymentError == nil {
		return nil
	}
	if lastPaymentError.DeclineCode != "" {
		code := lastPaymentError.DeclineCode
		return &code
	}
	if lastPaymentError.Code != "" {
		code := string(lastPaymentError.Code) // stripe.ErrorCode is a named string type; converts cleanly.
		return &code
	}
	return nil
}

// mapThreeDsModeToStripe maps the workflow's PayNext-modeled 3DS mode
// to Stripe's payment_method_options.card.request_three_d_secure —
// confirmed accepted values automatic | any | challenge
// (docs.stripe.com/api/payment_intents/confirm, verified against
// ADR-0012 in the TS reference implementation, itself search-verified
// against live Stripe docs, not recalled from training data): "any" is
// Stripe's own documented "preference for a frictionless flow",
// "challenge" the inverse preference, "automatic" its risk-based
// default.
//
// adaptive -> automatic (both are "let risk/issuer requirements
// decide"). frictionless -> any (both prefer no challenge). no_3ds/nil
// -> "" (omit the param) — Stripe has no request-level "never run 3DS"
// override; see adapters.CreatePaymentInput.ThreeDsMode's doc comment
// and ADR-0012 for why this is a real product gap, not an oversight in
// this mapping. PRESERVED DELIBERATELY, NOT FIXED — see
// MIGRATION_NOTES.md's Phase 2 section.
//
// Return type is a plain string, not a stripe-go named enum type:
// stripe-go's PaymentIntentPaymentMethodOptionsCardParams.RequestThreeDSecure
// field is typed *string in every stripe-go version this port's author
// has verified (there is no dedicated named enum type for this
// request-shape field in the SDK — only RESPONSE fields typically get
// named enum types in stripe-go). Using plain string here avoids
// depending on an invented type name if that assumption is wrong.
func mapThreeDsModeToStripe(mode *adapters.ThreeDsMode) string {
	if mode == nil {
		return ""
	}
	switch *mode {
	case adapters.ThreeDsModeAdaptive:
		return "automatic"
	case adapters.ThreeDsModeFrictionless:
		return "any"
	case adapters.ThreeDsModeNo3DS:
		return ""
	default:
		return ""
	}
}

// normalizeStripeDecline looks up a raw Stripe code against the
// in-memory decline map (loaded from decline_code_map at adapter
// construction) and falls back to domain.UnmappedDecline, exactly per
// T1.4's "unmapped -> technical/review fallback + metric" rule. The
// metric increment itself is the caller's responsibility (this
// function is pure).
func normalizeStripeDecline(declineMap map[string]domain.NormalizedDecline, rawCode string) domain.NormalizedDecline {
	if d, ok := declineMap[rawCode]; ok {
		return d
	}
	return domain.UnmappedDecline("stripe", rawCode)
}

// normalizeStripeEvent maps a Stripe event -> canonical state-machine
// events (T2.4's NormalizeEvent half). Deliberately over-inclusive
// rather than perfectly minimal: for example payment_intent.succeeded
// always emits the full authorized -> capture_started -> captured
// sequence, even though a separate amount_capturable_updated webhook
// may have already carried the authorized transition. This is safe
// because late-event handling (a later phase) treats any transition
// that's already been applied as a harmless no-op timeline entry,
// never a regression (Non-negotiable #5) — so NormalizeEvent can favor
// completeness over precision, and let the state machine be the single
// source of truth for what actually changes.
func normalizeStripeEvent(event *stripesdk.Event, declineMap map[string]domain.NormalizedDecline) []domain.CanonicalEvent {
	switch event.Type {
	case "payment_intent.requires_action":
		return []domain.CanonicalEvent{{Type: domain.EventAuthenticationRequired}}

	case "payment_intent.amount_capturable_updated":
		return []domain.CanonicalEvent{{Type: domain.EventAuthorized}}

	case "payment_intent.succeeded":
		return []domain.CanonicalEvent{
			{Type: domain.EventAuthorized},
			{Type: domain.EventCaptureStarted},
			{Type: domain.EventCaptured},
		}

	case "payment_intent.payment_failed":
		pi, err := decodePaymentIntent(event)
		if err != nil {
			return nil
		}
		rawCode := extractRawDeclineCode(pi.LastPaymentError)
		var declineCode *string
		if rawCode != nil {
			decline := normalizeStripeDecline(declineMap, *rawCode)
			declineCode = &decline.NormalizedCode
		}
		return []domain.CanonicalEvent{{Type: domain.EventDeclined, DeclineCode: declineCode}}

	case "payment_intent.canceled":
		return []domain.CanonicalEvent{{Type: domain.EventVoided}}

	case "charge.refunded":
		return []domain.CanonicalEvent{
			{Type: domain.EventRefundStarted},
			{Type: domain.EventRefunded},
		}

	case "charge.dispute.created":
		return []domain.CanonicalEvent{{Type: domain.EventDisputeOpened}}

	case "charge.dispute.closed":
		dispute, err := decodeDispute(event)
		if err != nil {
			return nil
		}
		// Compared as a plain string (dispute.Status is
		// stripe.DisputeStatus, a named string type in stripe-go) rather
		// than named constants like "DisputeStatusWon" — same rationale
		// as mapPaymentIntentStatus above.
		switch string(dispute.Status) {
		case "won":
			// Ambiguous without payment history: ResolvedTarget
			// (captured vs. settled) is decided by the apply worker (a
			// later phase), which knows the payment's actual prior
			// state — the adapter only signals "won." See
			// domain.AllowedTransitions's dispute_won handling.
			target := domain.StateCaptured
			return []domain.CanonicalEvent{{Type: domain.EventDisputeWon, ResolvedTarget: &target}}
		case "lost":
			return []domain.CanonicalEvent{{Type: domain.EventDisputeLost}}
		default:
			return nil
		}

	default:
		return nil
	}
}
