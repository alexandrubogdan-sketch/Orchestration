package paypal

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alphapayments/payment-orchestrator/internal/adapters"
	"github.com/alphapayments/payment-orchestrator/internal/domain"
)

// loadFixture reads a fixture from testdata/<name>.json — mirrors
// stripe_test.go's loadEvent/solidgate_test.go's inline os.ReadFile
// pattern.
func loadFixture(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("failed to read fixture %s: %v", name, err)
	}
	return raw
}

func loadOrder(t *testing.T, name string) *Order {
	t.Helper()
	var order Order
	if err := json.Unmarshal(loadFixture(t, name), &order); err != nil {
		t.Fatalf("failed to unmarshal order fixture %s: %v", name, err)
	}
	return &order
}

func loadWebhookEvent(t *testing.T, name string) *WebhookEvent {
	t.Helper()
	var event WebhookEvent
	if err := json.Unmarshal(loadFixture(t, name), &event); err != nil {
		t.Fatalf("failed to unmarshal webhook fixture %s: %v", name, err)
	}
	return &event
}

var testDeclineMap = map[string]domain.NormalizedDecline{
	"INSUFFICIENT_FUNDS": {
		PSP:            "paypal",
		RawCode:        "INSUFFICIENT_FUNDS",
		NormalizedCode: "insufficient_funds",
		Category:       domain.DeclineCategorySoft,
		RetryClass:     domain.RetryClassSameInstrumentLater,
	},
}

// --- mapOrderStatus / mapCaptureStatus / mapAuthorizationStatus ---

func TestMapOrderStatus_AllDocumentedStatuses(t *testing.T) {
	tests := []struct {
		raw  string
		want adapters.CanonicalAttemptStatus
	}{
		{"CREATED", adapters.AttemptStatusPending},
		{"SAVED", adapters.AttemptStatusPending},
		{"APPROVED", adapters.AttemptStatusAuthorized},
		{"PAYER_ACTION_REQUIRED", adapters.AttemptStatusRequiresAction},
		{"COMPLETED", adapters.AttemptStatusCaptured},
		{"VOIDED", adapters.AttemptStatusVoided},
		{"some_unrecognized_status", adapters.AttemptStatusPending},
	}
	for _, tt := range tests {
		t.Run(tt.raw, func(t *testing.T) {
			if got := mapOrderStatus(tt.raw); got != tt.want {
				t.Errorf("mapOrderStatus(%q) = %s, want %s", tt.raw, got, tt.want)
			}
		})
	}
}

func TestMapCaptureStatus_AllDocumentedStatuses(t *testing.T) {
	tests := []struct {
		raw  string
		want adapters.CanonicalAttemptStatus
	}{
		{"COMPLETED", adapters.AttemptStatusCaptured},
		{"PENDING", adapters.AttemptStatusPending},
		{"DECLINED", adapters.AttemptStatusDeclined},
		{"FAILED", adapters.AttemptStatusDeclined},
		{"REFUNDED", adapters.AttemptStatusRefunded},
		{"PARTIALLY_REFUNDED", adapters.AttemptStatusCaptured},
	}
	for _, tt := range tests {
		t.Run(tt.raw, func(t *testing.T) {
			if got := mapCaptureStatus(tt.raw); got != tt.want {
				t.Errorf("mapCaptureStatus(%q) = %s, want %s", tt.raw, got, tt.want)
			}
		})
	}
}

func TestMapAuthorizationStatus_AllDocumentedStatuses(t *testing.T) {
	tests := []struct {
		raw  string
		want adapters.CanonicalAttemptStatus
	}{
		{"CREATED", adapters.AttemptStatusAuthorized},
		{"PENDING", adapters.AttemptStatusAuthorized},
		{"CAPTURED", adapters.AttemptStatusCaptured},
		{"PARTIALLY_CAPTURED", adapters.AttemptStatusCaptured},
		{"DENIED", adapters.AttemptStatusDeclined},
		{"VOIDED", adapters.AttemptStatusVoided},
	}
	for _, tt := range tests {
		t.Run(tt.raw, func(t *testing.T) {
			if got := mapAuthorizationStatus(tt.raw); got != tt.want {
				t.Errorf("mapAuthorizationStatus(%q) = %s, want %s", tt.raw, got, tt.want)
			}
		})
	}
}

// --- toAttemptResultFromOrder, via golden fixtures ---

func TestToAttemptResultFromOrder_ApprovedCarriesApproveLink(t *testing.T) {
	order := loadOrder(t, "order-create-success.json")
	a := New(Options{})
	result := a.toAttemptResultFromOrder(order)

	if result.PspAttemptRef != "5O190127TN364715T" {
		t.Errorf("PspAttemptRef = %s, want 5O190127TN364715T", result.PspAttemptRef)
	}
	if result.Status != adapters.AttemptStatusAuthorized {
		t.Errorf("Status = %s, want authorized", result.Status)
	}
	if result.ClientSecret == nil || *result.ClientSecret == "" {
		t.Fatal("ClientSecret (approve link) was not populated for an APPROVED order")
	}
}

func TestToAttemptResultFromOrder_CreatedIsPending(t *testing.T) {
	order := loadOrder(t, "order-create-pending.json")
	a := New(Options{})
	result := a.toAttemptResultFromOrder(order)

	if result.Status != adapters.AttemptStatusPending {
		t.Errorf("Status = %s, want pending", result.Status)
	}
	if result.ClientSecret != nil {
		t.Errorf("ClientSecret = %v, want nil for a pending (not yet approved) order", result.ClientSecret)
	}
}

func TestToAttemptResultFromOrder_CapturedOrderPrefersCaptureStatus(t *testing.T) {
	order := loadOrder(t, "order-capture-success.json")
	a := New(Options{})
	result := a.toAttemptResultFromOrder(order)

	if result.Status != adapters.AttemptStatusCaptured {
		t.Errorf("Status = %s, want captured", result.Status)
	}
	if result.PspAttemptRef != "5O190127TN364715T" {
		t.Errorf("PspAttemptRef = %s, want the ORDER id, not the capture id", result.PspAttemptRef)
	}
}

func TestToAttemptResultFromOrder_DeniedCaptureNormalizesDecline(t *testing.T) {
	order := loadOrder(t, "order-capture-denied.json")
	a := New(Options{DeclineMap: testDeclineMap})
	result := a.toAttemptResultFromOrder(order)

	if result.Status != adapters.AttemptStatusDeclined {
		t.Fatalf("Status = %s, want declined", result.Status)
	}
	if result.Decline == nil {
		t.Fatal("Decline was not populated for a DECLINED capture")
	}
	if result.Decline.NormalizedCode != "insufficient_funds" {
		t.Errorf("Decline.NormalizedCode = %s, want insufficient_funds", result.Decline.NormalizedCode)
	}
}

// --- NormalizeEvent, via golden webhook fixtures ---

func TestNormalizeEvent_GoldenFixtures(t *testing.T) {
	tests := []struct {
		fixture string
		want    []domain.CanonicalEventType
	}{
		{"webhook.checkout_order_approved.json", []domain.CanonicalEventType{
			domain.EventAuthorized,
		}},
		{"webhook.payment_capture_completed.json", []domain.CanonicalEventType{
			domain.EventAuthorized, domain.EventCaptureStarted, domain.EventCaptured,
		}},
		{"webhook.payment_capture_denied.json", []domain.CanonicalEventType{
			domain.EventDeclined,
		}},
		{"webhook.payment_capture_refunded.json", []domain.CanonicalEventType{
			domain.EventRefundStarted, domain.EventRefunded,
		}},
	}

	for _, tt := range tests {
		t.Run(tt.fixture, func(t *testing.T) {
			event := loadWebhookEvent(t, tt.fixture)
			got := NormalizeEvent(event, testDeclineMap)
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

func TestNormalizeEvent_DeniedCaptureCarriesDeclineCode(t *testing.T) {
	event := loadWebhookEvent(t, "webhook.payment_capture_denied.json")
	got := NormalizeEvent(event, testDeclineMap)
	if len(got) != 1 || got[0].Type != domain.EventDeclined {
		t.Fatalf("got %+v, want one declined event", got)
	}
	if got[0].DeclineCode == nil || *got[0].DeclineCode != "insufficient_funds" {
		t.Errorf("DeclineCode = %v, want insufficient_funds", got[0].DeclineCode)
	}
}

// --- ExtractPaymentID / ExtractPspAttemptRef ---

func TestExtractPaymentID_FromCheckoutOrderApproved(t *testing.T) {
	a := New(Options{})
	event := loadWebhookEvent(t, "webhook.checkout_order_approved.json")
	got := a.ExtractPaymentID(event)
	if got == nil || *got != "pay_int_abc123" {
		t.Errorf("ExtractPaymentID = %v, want pay_int_abc123", got)
	}
}

func TestExtractPaymentID_FromPaymentCaptureCompleted(t *testing.T) {
	a := New(Options{})
	event := loadWebhookEvent(t, "webhook.payment_capture_completed.json")
	got := a.ExtractPaymentID(event)
	if got == nil || *got != "pay_int_abc123" {
		t.Errorf("ExtractPaymentID = %v, want pay_int_abc123", got)
	}
}

func TestExtractPspAttemptRef_FromCaptureEventUsesUpLink(t *testing.T) {
	a := New(Options{})
	event := loadWebhookEvent(t, "webhook.payment_capture_completed.json")
	got := a.ExtractPspAttemptRef(event)
	if got == nil || *got != "5O190127TN364715T" {
		t.Errorf("ExtractPspAttemptRef = %v, want the order id from the capture's up link (5O190127TN364715T)", got)
	}
}

func TestExtractPspAttemptRef_FromOrderApprovedEventIsTheOrderItself(t *testing.T) {
	a := New(Options{})
	event := loadWebhookEvent(t, "webhook.checkout_order_approved.json")
	got := a.ExtractPspAttemptRef(event)
	if got == nil || *got != "5O190127TN364715T" {
		t.Errorf("ExtractPspAttemptRef = %v, want 5O190127TN364715T", got)
	}
}

// --- amountToPayPalValue / payPalValueToMinorUnits round trip ---

func TestAmountToPayPalValue(t *testing.T) {
	money, err := domain.MakeMoney(10000, "USD")
	if err != nil {
		t.Fatalf("MakeMoney failed: %v", err)
	}
	if got := amountToPayPalValue(money); got != "100.00" {
		t.Errorf("amountToPayPalValue(10000 minor units) = %s, want 100.00", got)
	}

	small, err := domain.MakeMoney(5, "USD")
	if err != nil {
		t.Fatalf("MakeMoney failed: %v", err)
	}
	if got := amountToPayPalValue(small); got != "0.05" {
		t.Errorf("amountToPayPalValue(5 minor units) = %s, want 0.05", got)
	}
}

// Regression test for the backend review's confirmed zero-decimal
// currency gap (2026-07-10): amountToPayPalValue used to unconditionally
// divide by 100, which would have produced "1.00" for ¥100 (JPY) instead
// of the correct "100" — domain.MakeMoney already accepts JPY (it's in
// domain.KnownCurrencies) even though PayPal's own Capabilities() below
// doesn't advertise it yet, so this was a live landmine, not a
// theoretical one.
func TestAmountToPayPalValue_ZeroDecimalCurrency(t *testing.T) {
	yen, err := domain.MakeMoney(10000, "JPY")
	if err != nil {
		t.Fatalf("MakeMoney failed: %v", err)
	}
	if got := amountToPayPalValue(yen); got != "10000" {
		t.Errorf("amountToPayPalValue(10000 minor units, JPY) = %s, want 10000 (bare integer, no decimal point)", got)
	}
}

func TestPayPalValueToMinorUnits(t *testing.T) {
	tests := []struct {
		value    string
		currency string
		want     int64
	}{
		{"100.00", "USD", 10000},
		{"0.05", "USD", 5},
		{"42.5", "USD", 4250},
		{"7", "USD", 700},
	}
	for _, tt := range tests {
		t.Run(tt.value, func(t *testing.T) {
			got, err := payPalValueToMinorUnits(tt.value, tt.currency)
			if err != nil {
				t.Fatalf("payPalValueToMinorUnits(%q, %q) returned an error: %v", tt.value, tt.currency, err)
			}
			if got != tt.want {
				t.Errorf("payPalValueToMinorUnits(%q, %q) = %d, want %d", tt.value, tt.currency, got, tt.want)
			}
		})
	}
}

// Regression test for the same zero-decimal fix, on the decode side:
// a PayPal JPY amount.value of "10000" means ¥10000 (minor units ==
// whole units), not 10000 cents.
func TestPayPalValueToMinorUnits_ZeroDecimalCurrency(t *testing.T) {
	got, err := payPalValueToMinorUnits("10000", "JPY")
	if err != nil {
		t.Fatalf("payPalValueToMinorUnits returned an error: %v", err)
	}
	if got != 10000 {
		t.Errorf("payPalValueToMinorUnits(\"10000\", JPY) = %d, want 10000", got)
	}
}

// Round-trips a zero-decimal amount through both directions to confirm
// they're genuine inverses of each other for JPY, exactly like the
// existing (unwritten but implied) USD round-trip already was.
func TestAmountToPayPalValue_RoundTripsWithZeroDecimalCurrency(t *testing.T) {
	original, err := domain.MakeMoney(500, "JPY")
	if err != nil {
		t.Fatalf("MakeMoney failed: %v", err)
	}
	value := amountToPayPalValue(original)
	roundTripped, err := payPalValueToMinorUnits(value, "JPY")
	if err != nil {
		t.Fatalf("payPalValueToMinorUnits(%q, JPY) returned an error: %v", value, err)
	}
	if roundTripped != original.MinorUnits() {
		t.Errorf("round-trip mismatch: got %d, want %d", roundTripped, original.MinorUnits())
	}
}

// --- Decline normalization ---

func TestNormalizeDecline_FallsBackToBuiltInTable(t *testing.T) {
	a := New(Options{}) // no declineMap configured
	d := a.NormalizeDecline("CHARGEBACK")
	if d.Category != domain.DeclineCategoryFraud {
		t.Errorf("Category = %s, want fraud", d.Category)
	}
	if d.RetryClass != domain.RetryClassReview {
		t.Errorf("RetryClass = %s, want review", d.RetryClass)
	}
}

func TestNormalizeDecline_DeclineMapTakesPrecedenceOverBuiltIn(t *testing.T) {
	a := New(Options{DeclineMap: testDeclineMap})
	d := a.NormalizeDecline("INSUFFICIENT_FUNDS")
	if d.NormalizedCode != "insufficient_funds" {
		t.Errorf("NormalizedCode = %s, want the decline-map-provided value insufficient_funds", d.NormalizedCode)
	}
}

func TestNormalizeDecline_UnknownCodeIsUnmapped(t *testing.T) {
	a := New(Options{})
	d := a.NormalizeDecline("SOME_FUTURE_REASON_CODE")
	if d.Category != domain.DeclineCategoryUnmapped {
		t.Errorf("Category = %s, want unmapped", d.Category)
	}
}

// --- OAuth2 token caching ---

// fakeTokenDoer is a minimal HTTPDoer that counts how many times the
// oauth2 token endpoint is actually hit, and otherwise returns a
// canned successful token response — used to verify getAccessToken's
// caching (a cache hit must not re-issue the HTTP call) without any
// real network access.
type fakeTokenDoer struct {
	tokenCalls  int
	expiresIn   int64
	accessToken string
}

func (f *fakeTokenDoer) Do(req *http.Request) (*http.Response, error) {
	f.tokenCalls++
	body := tokenResponse{
		AccessToken: f.accessToken,
		TokenType:   "Bearer",
		ExpiresIn:   f.expiresIn,
	}
	encoded, _ := json.Marshal(body)
	return &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(bytes.NewReader(encoded)),
		Header:     make(http.Header),
	}, nil
}

func TestGetAccessToken_CachesUntilExpiry(t *testing.T) {
	fake := &fakeTokenDoer{expiresIn: 32400, accessToken: "A21AAFakeToken"}
	current := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	a := New(Options{
		Credentials: Credentials{ClientID: "id", ClientSecret: "secret", APIBaseURL: "https://api-m.sandbox.paypal.com"},
		HTTPClient:  fake,
		Now:         func() time.Time { return current },
	})

	token1, err := a.getAccessToken(context.Background())
	if err != nil {
		t.Fatalf("first getAccessToken failed: %v", err)
	}
	token2, err := a.getAccessToken(context.Background())
	if err != nil {
		t.Fatalf("second getAccessToken failed: %v", err)
	}
	if token1 != token2 || token1 != "A21AAFakeToken" {
		t.Errorf("token1=%s token2=%s, want both to equal A21AAFakeToken", token1, token2)
	}
	if fake.tokenCalls != 1 {
		t.Errorf("tokenCalls = %d, want 1 (second call should hit the cache)", fake.tokenCalls)
	}
}

func TestGetAccessToken_RefreshesAfterExpiry(t *testing.T) {
	fake := &fakeTokenDoer{expiresIn: 100, accessToken: "A21AAFakeToken"}
	current := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	a := New(Options{
		Credentials: Credentials{ClientID: "id", ClientSecret: "secret", APIBaseURL: "https://api-m.sandbox.paypal.com"},
		HTTPClient:  fake,
		Now:         func() time.Time { return current },
	})

	if _, err := a.getAccessToken(context.Background()); err != nil {
		t.Fatalf("first getAccessToken failed: %v", err)
	}
	// Advance past expiresIn (100s) minus the 60s safety margin — i.e.
	// past the 40s mark the cache actually honors.
	current = current.Add(41 * time.Second)
	if _, err := a.getAccessToken(context.Background()); err != nil {
		t.Fatalf("second getAccessToken failed: %v", err)
	}
	if fake.tokenCalls != 2 {
		t.Errorf("tokenCalls = %d, want 2 (token should have been refreshed after expiry)", fake.tokenCalls)
	}
}

// --- Capabilities / PublicConfig / PSP ---

func TestPSP_ReturnsPaypal(t *testing.T) {
	a := New(Options{})
	if a.PSP() != "paypal" {
		t.Errorf("PSP() = %s, want paypal", a.PSP())
	}
}

func TestPublicConfig_CarriesClientIDAsPublishableKey(t *testing.T) {
	a := New(Options{Credentials: Credentials{ClientID: "client_abc"}})
	cfg := a.PublicConfig()
	if cfg.PSP != "paypal" {
		t.Errorf("PSP = %s, want paypal", cfg.PSP)
	}
	if cfg.PublishableKey != "client_abc" {
		t.Errorf("PublishableKey = %s, want client_abc", cfg.PublishableKey)
	}
	if cfg.MerchantIdentifier != nil {
		t.Errorf("MerchantIdentifier = %v, want nil", cfg.MerchantIdentifier)
	}
}

// --- VerifyWebhook: missing headers / missing webhook_id fail closed ---

func TestVerifyWebhook_MissingHeadersFailsClosed(t *testing.T) {
	a := New(Options{Credentials: Credentials{WebhookID: "WH-123"}})
	_, err := a.VerifyWebhook([]byte(`{}`), map[string][]string{})
	if err == nil {
		t.Fatal("VerifyWebhook with no PAYPAL-* headers returned no error, want *adapters.InvalidSignatureError")
	}
	if _, ok := err.(*adapters.InvalidSignatureError); !ok {
		t.Errorf("error type = %T, want *adapters.InvalidSignatureError", err)
	}
}

func TestVerifyWebhook_MissingWebhookIDFailsClosed(t *testing.T) {
	a := New(Options{Credentials: Credentials{}}) // no WebhookID configured
	headers := map[string][]string{
		"paypal-auth-algo":         {"SHA256withRSA"},
		"paypal-cert-url":          {"https://api.paypal.com/cert"},
		"paypal-transmission-id":   {"abc"},
		"paypal-transmission-sig":  {"sig"},
		"paypal-transmission-time": {"2026-07-07T12:00:00Z"},
	}
	_, err := a.VerifyWebhook([]byte(`{}`), headers)
	if err == nil {
		t.Fatal("VerifyWebhook with no webhook_id configured returned no error, want *adapters.InvalidSignatureError")
	}
}

// --- Capabilities ---

func TestCapabilities_AdvertisesPaypalMethodOnly(t *testing.T) {
	a := New(Options{})
	caps := a.Capabilities()
	if len(caps.Methods) != 1 || caps.Methods[0] != "paypal" {
		t.Errorf("Methods = %v, want [paypal]", caps.Methods)
	}
	if caps.ThreeDs {
		t.Error("ThreeDs = true, want false (PayPal's redirect-approval flow is not a 3DS challenge)")
	}
}

// --- Void / Refund (order-id -> authorization/capture-id resolution) ---

// sequencedDoer is a fake HTTPDoer that serves canned responses in
// call order — the first call is always assumed to be the OAuth2
// token exchange (mirroring fakeTokenDoer's canned token response, so
// getAccessToken succeeds transparently), and every call after that
// pops the next entry off responses in order. Used to test Void/Refund,
// both of which now issue two sequential requests (GET order, then
// POST void/refund) beyond the token fetch — no other test in this
// file needed more than one non-token request, so fakeTokenDoer alone
// was insufficient here.
type sequencedDoer struct {
	responses []sequencedResponse
	calls     []*http.Request
	next      int
}

type sequencedResponse struct {
	status int
	body   string
}

func (f *sequencedDoer) Do(req *http.Request) (*http.Response, error) {
	f.calls = append(f.calls, req)
	if req.URL.Path == "/v1/oauth2/token" {
		encoded, _ := json.Marshal(tokenResponse{AccessToken: "A21AAFakeToken", TokenType: "Bearer", ExpiresIn: 32400})
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewReader(encoded)), Header: make(http.Header)}, nil
	}
	if f.next >= len(f.responses) {
		return nil, fmt.Errorf("sequencedDoer: no more canned responses queued (call #%d, %s %s)", len(f.calls), req.Method, req.URL.Path)
	}
	resp := f.responses[f.next]
	f.next++
	return &http.Response{StatusCode: resp.status, Body: io.NopCloser(strings.NewReader(resp.body)), Header: make(http.Header)}, nil
}

func newTestAdapterWithDoer(doer HTTPDoer) *Adapter {
	return New(Options{
		Credentials: Credentials{ClientID: "id", ClientSecret: "secret", APIBaseURL: "https://api-m.sandbox.paypal.com"},
		HTTPClient:  doer,
	})
}

func TestVoid_ResolvesOrderIDToAuthorizationIDBeforeVoiding(t *testing.T) {
	orderBody := `{
		"id": "5O190127TN364715T",
		"status": "APPROVED",
		"purchase_units": [{
			"payments": {
				"authorizations": [{"id": "9AB12345CD678901E", "status": "CREATED"}]
			}
		}]
	}`
	doer := &sequencedDoer{responses: []sequencedResponse{
		{status: http.StatusOK, body: orderBody},
		{status: http.StatusNoContent, body: ""},
	}}
	a := newTestAdapterWithDoer(doer)

	result, err := a.Void(context.Background(), "5O190127TN364715T", "idem-void-1")
	if err != nil {
		t.Fatalf("Void returned error: %v", err)
	}
	if result.Status != adapters.AttemptStatusVoided {
		t.Errorf("Status = %s, want voided", result.Status)
	}
	// PspAttemptRef on the result should still be the ORDER id, not the
	// authorization id — Void resolves the id shape internally but does
	// not change what this codebase persists as the attempt's reference
	// (see Void's doc comment in paypal.go).
	if result.PspAttemptRef != "5O190127TN364715T" {
		t.Errorf("PspAttemptRef = %s, want the order id unchanged", result.PspAttemptRef)
	}

	// Second non-token call (index 1 overall: token, then GET order, then
	// POST void) must have hit the AUTHORIZATION id's void path, never
	// the order id.
	if len(doer.calls) != 3 {
		t.Fatalf("expected 3 HTTP calls (token, GET order, POST void), got %d", len(doer.calls))
	}
	getOrderReq := doer.calls[1]
	if getOrderReq.Method != http.MethodGet || getOrderReq.URL.Path != "/v2/checkout/orders/5O190127TN364715T" {
		t.Errorf("second call = %s %s, want GET /v2/checkout/orders/5O190127TN364715T", getOrderReq.Method, getOrderReq.URL.Path)
	}
	voidReq := doer.calls[2]
	wantPath := "/v2/payments/authorizations/9AB12345CD678901E/void"
	if voidReq.Method != http.MethodPost || voidReq.URL.Path != wantPath {
		t.Errorf("third call = %s %s, want POST %s (the AUTHORIZATION id, not the order id)", voidReq.Method, voidReq.URL.Path, wantPath)
	}
}

func TestVoid_NoAuthorizationOnOrderReturnsTechnicalError(t *testing.T) {
	// An order that has been captured directly (no separate authorize
	// step) has no purchase_units[].payments.authorizations entry at
	// all — Void must not guess an id in this case.
	orderBody := `{
		"id": "5O190127TN364715T",
		"status": "COMPLETED",
		"purchase_units": [{
			"payments": {
				"captures": [{"id": "3C679366HH908993F", "status": "COMPLETED"}]
			}
		}]
	}`
	doer := &sequencedDoer{responses: []sequencedResponse{
		{status: http.StatusOK, body: orderBody},
	}}
	a := newTestAdapterWithDoer(doer)

	_, err := a.Void(context.Background(), "5O190127TN364715T", "idem-void-2")
	if err == nil {
		t.Fatal("Void with no authorization on the order returned no error, want a TechnicalError")
	}
	if _, ok := err.(*TechnicalError); !ok {
		t.Errorf("err = %T, want *TechnicalError", err)
	}
}

func TestRefund_ResolvesOrderIDToCaptureIDBeforeRefunding(t *testing.T) {
	orderBody := `{
		"id": "5O190127TN364715T",
		"status": "COMPLETED",
		"purchase_units": [{
			"payments": {
				"captures": [{"id": "3C679366HH908993F", "status": "COMPLETED", "amount": {"currency_code": "USD", "value": "100.00"}}]
			}
		}]
	}`
	refundBody := `{"id": "1JU08902RG9998716", "status": "COMPLETED", "amount": {"currency_code": "USD", "value": "50.00"}}`
	doer := &sequencedDoer{responses: []sequencedResponse{
		{status: http.StatusOK, body: orderBody},
		{status: http.StatusCreated, body: refundBody},
	}}
	a := newTestAdapterWithDoer(doer)

	amount, err := domain.MakeMoney(5000, "USD")
	if err != nil {
		t.Fatalf("MakeMoney failed: %v", err)
	}
	result, err := a.Refund(context.Background(), "5O190127TN364715T", amount, "idem-refund-1")
	if err != nil {
		t.Fatalf("Refund returned error: %v", err)
	}
	if result.Status != adapters.RefundStatusSucceeded {
		t.Errorf("Status = %s, want succeeded", result.Status)
	}
	if result.PspRefundRef != "1JU08902RG9998716" {
		t.Errorf("PspRefundRef = %s, want 1JU08902RG9998716", result.PspRefundRef)
	}

	if len(doer.calls) != 3 {
		t.Fatalf("expected 3 HTTP calls (token, GET order, POST refund), got %d", len(doer.calls))
	}
	getOrderReq := doer.calls[1]
	if getOrderReq.Method != http.MethodGet || getOrderReq.URL.Path != "/v2/checkout/orders/5O190127TN364715T" {
		t.Errorf("second call = %s %s, want GET /v2/checkout/orders/5O190127TN364715T", getOrderReq.Method, getOrderReq.URL.Path)
	}
	refundReq := doer.calls[2]
	wantPath := "/v2/payments/captures/3C679366HH908993F/refund"
	if refundReq.Method != http.MethodPost || refundReq.URL.Path != wantPath {
		t.Errorf("third call = %s %s, want POST %s (the CAPTURE id, not the order id)", refundReq.Method, refundReq.URL.Path, wantPath)
	}
}

func TestRefund_NoCaptureOnOrderReturnsTechnicalError(t *testing.T) {
	// An order that was only approved, never captured, has no
	// purchase_units[].payments.captures entry at all — Refund must not
	// guess an id in this case.
	orderBody := `{
		"id": "5O190127TN364715T",
		"status": "APPROVED",
		"purchase_units": [{
			"payments": {
				"authorizations": [{"id": "9AB12345CD678901E", "status": "CREATED"}]
			}
		}]
	}`
	doer := &sequencedDoer{responses: []sequencedResponse{
		{status: http.StatusOK, body: orderBody},
	}}
	a := newTestAdapterWithDoer(doer)

	amount, err := domain.MakeMoney(5000, "USD")
	if err != nil {
		t.Fatalf("MakeMoney failed: %v", err)
	}
	_, err = a.Refund(context.Background(), "5O190127TN364715T", amount, "idem-refund-2")
	if err == nil {
		t.Fatal("Refund with no capture on the order returned no error, want a TechnicalError")
	}
	if _, ok := err.(*TechnicalError); !ok {
		t.Errorf("err = %T, want *TechnicalError", err)
	}
}
