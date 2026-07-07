package solidgate

import (
	"context"
	"testing"

	"github.com/alphapayments/payment-orchestrator/internal/adapters"
	"github.com/alphapayments/payment-orchestrator/internal/domain"
)

// TestMapOrderStatus_AllDocumentedStatuses ports the TS statusMapping's
// ORDER_STATUS_TO_CANONICAL table.
func TestMapOrderStatus_AllDocumentedStatuses(t *testing.T) {
	tests := []struct {
		raw  string
		want adapters.CanonicalAttemptStatus
	}{
		{"processing", adapters.AttemptStatusPending},
		{"3ds_verify", adapters.AttemptStatusRequiresAction},
		{"auth_ok", adapters.AttemptStatusAuthorized},
		{"auth_failed", adapters.AttemptStatusDeclined},
		{"settle_ok", adapters.AttemptStatusCaptured},
		{"partial_settled", adapters.AttemptStatusCaptured},
		{"void_ok", adapters.AttemptStatusVoided},
		{"refunded", adapters.AttemptStatusRefunded},
		{"some_unrecognized_status", adapters.AttemptStatusFailed},
	}
	for _, tt := range tests {
		t.Run(tt.raw, func(t *testing.T) {
			if got := MapOrderStatus(tt.raw); got != tt.want {
				t.Errorf("MapOrderStatus(%q) = %s, want %s", tt.raw, got, tt.want)
			}
		})
	}
}

// TestExtractDeclineCode_AlwaysNil pins down the documented "honest
// gap" — no confirmed decline-code field exists in the researched
// response schema, so this must always return nil, never a guessed
// field name.
func TestExtractDeclineCode_AlwaysNil(t *testing.T) {
	response := ChargeResponse{Order: ChargeOrder{OrderID: "o1", Status: "auth_failed"}}
	if got := ExtractDeclineCode(response); got != nil {
		t.Errorf("ExtractDeclineCode = %v, want nil", got)
	}
}

// TestNormalizeEvent_OrderStatusTable ports the TS normalizeSolidgateEvent
// switch table.
func TestNormalizeEvent_OrderStatusTable(t *testing.T) {
	tests := []struct {
		name   string
		status string
		want   []domain.CanonicalEventType
	}{
		{"3ds_verify", "3ds_verify", []domain.CanonicalEventType{domain.EventAuthenticationRequired}},
		{"auth_ok", "auth_ok", []domain.CanonicalEventType{domain.EventAuthorized}},
		{"settle_ok", "settle_ok", []domain.CanonicalEventType{
			domain.EventAuthorized, domain.EventCaptureStarted, domain.EventCaptured,
		}},
		{"auth_failed", "auth_failed", []domain.CanonicalEventType{domain.EventDeclined}},
		{"void_ok", "void_ok", []domain.CanonicalEventType{domain.EventVoided}},
		{"refunded", "refunded", []domain.CanonicalEventType{
			domain.EventRefundStarted, domain.EventRefunded,
		}},
		{"processing (pending, no events)", "processing", nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body := &ChargeResponse{Order: ChargeOrder{OrderID: "o1", Status: tt.status}}
			got := NormalizeEvent(body)
			if len(got) != len(tt.want) {
				t.Fatalf("got %d events, want %d: %+v", len(got), len(tt.want), got)
			}
			for i, want := range tt.want {
				if got[i].Type != want {
					t.Errorf("event[%d].Type = %s, want %s", i, got[i].Type, want)
				}
			}
		})
	}
}

// TestNormalizeEvent_NilOrMissingOrder verifies the nil/empty-order-id
// guard.
func TestNormalizeEvent_NilOrMissingOrder(t *testing.T) {
	if got := NormalizeEvent(nil); got != nil {
		t.Errorf("NormalizeEvent(nil) = %+v, want nil", got)
	}
	if got := NormalizeEvent(&ChargeResponse{}); got != nil {
		t.Errorf("NormalizeEvent(empty order) = %+v, want nil", got)
	}
}

// TestCreatePayment_RequiresCustomerEmail verifies the ADR-0011
// required-field contract: a missing CustomerEmail must error clearly
// rather than silently omit the field.
func TestCreatePayment_RequiresCustomerEmail(t *testing.T) {
	a := New(Options{
		Credentials: Credentials{APIBaseURL: "https://example.invalid"},
	})
	amount, err := domain.MakeMoney(1000, "USD")
	if err != nil {
		t.Fatalf("MakeMoney failed: %v", err)
	}
	_, err = a.CreatePayment(context.Background(), adapters.CreatePaymentInput{
		PaymentID:        "pay_1",
		Amount:           amount,
		PaymentMethodRef: "card_tok_1",
		Context:          adapters.AttemptContext{CitMit: adapters.CitMitCIT},
		IdempotencyKey:   "idem_1",
		CaptureMethod:    adapters.CaptureMethodAutomatic,
		// CustomerEmail intentionally omitted.
	})
	if err == nil {
		t.Fatal("CreatePayment returned no error, want a customerEmail-required error")
	}
}

// TestVerifyWebhook_NoCredentialsConfigured verifies the
// no-webhook-credentials guard.
func TestVerifyWebhook_NoCredentialsConfigured(t *testing.T) {
	a := New(Options{Credentials: Credentials{APIBaseURL: "https://example.invalid"}})
	_, err := a.VerifyWebhook([]byte(`{}`), map[string][]string{"merchant": {"pk"}, "signature": {"sig"}})
	if err == nil {
		t.Fatal("VerifyWebhook returned no error, want a no-webhook-credentials error")
	}
	if _, ok := err.(*adapters.InvalidSignatureError); !ok {
		t.Errorf("error type = %T, want *adapters.InvalidSignatureError", err)
	}
}

// TestVerifyWebhook_ValidSignatureRoundTrip verifies a correctly signed
// webhook body verifies successfully and normalizes to a canonical
// event.
func TestVerifyWebhook_ValidSignatureRoundTrip(t *testing.T) {
	webhookCreds := WebhookCredentials{WebhookPublicKey: "wh_pk_1", WebhookSecretKey: "wh_sk_1"}
	a := New(Options{
		Credentials:        Credentials{APIBaseURL: "https://example.invalid"},
		WebhookCredentials: &webhookCreds,
	})

	body := `{"order":{"order_id":"pay_42","status":"settle_ok"}}`
	signature := ComputeSignature(webhookCreds.WebhookPublicKey, webhookCreds.WebhookSecretKey, &body)

	verified, err := a.VerifyWebhook([]byte(body), map[string][]string{
		"merchant":  {webhookCreds.WebhookPublicKey},
		"signature": {signature},
	})
	if err != nil {
		t.Fatalf("VerifyWebhook returned an error: %v", err)
	}
	if verified.ProviderEventID != "pay_42" {
		t.Errorf("ProviderEventID = %s, want pay_42 (falls back to order_id when no event-id header)", verified.ProviderEventID)
	}

	events := a.NormalizeEvent(verified.RawPayload)
	if len(events) != 3 {
		t.Fatalf("got %d events, want 3 (authorized, capture_started, captured)", len(events))
	}
	if events[2].Type != domain.EventCaptured {
		t.Errorf("last event type = %s, want captured", events[2].Type)
	}
}

// TestVerifyWebhook_TamperedBodyFailsSignature verifies a tampered body
// fails signature verification.
func TestVerifyWebhook_TamperedBodyFailsSignature(t *testing.T) {
	webhookCreds := WebhookCredentials{WebhookPublicKey: "wh_pk_1", WebhookSecretKey: "wh_sk_1"}
	a := New(Options{
		Credentials:        Credentials{APIBaseURL: "https://example.invalid"},
		WebhookCredentials: &webhookCreds,
	})

	originalBody := `{"order":{"order_id":"pay_42","status":"settle_ok"}}`
	signature := ComputeSignature(webhookCreds.WebhookPublicKey, webhookCreds.WebhookSecretKey, &originalBody)

	tamperedBody := `{"order":{"order_id":"pay_42","status":"refunded"}}`
	_, err := a.VerifyWebhook([]byte(tamperedBody), map[string][]string{
		"merchant":  {webhookCreds.WebhookPublicKey},
		"signature": {signature},
	})
	if err == nil {
		t.Fatal("VerifyWebhook returned no error for a tampered body, want a signature mismatch error")
	}
}
