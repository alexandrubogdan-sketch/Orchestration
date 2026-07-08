// Package solidgate is the second PSP adapter (T8.5) — a hand-rolled
// REST client (net/http), since there is no official Solidgate Go SDK.
// This is the ONLY package allowed to build Solidgate-specific request/
// response shapes (Non-negotiable #7).
//
// FLAGGED, REPEATEDLY, BECAUSE IT MATTERS (carried over unchanged from
// the TS reference implementation): this adapter is written against
// Solidgate's PUBLISHED API documentation (endpoint path, request/
// response field names, the signature algorithm, and the order/
// transaction status enums are all confirmed against real docs there,
// not guessed) but has NEVER been run against a live Solidgate sandbox
// account, because none is reachable from this build environment
// either. Specific gaps called out inline via FLAGGED comments
// (decline-code field name, exact refund/void/status endpoint paths,
// base URL) must be verified against a real account before this ships
// to production.
package solidgate

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/alphapayments/payment-orchestrator/internal/adapters"
	"github.com/alphapayments/payment-orchestrator/internal/domain"
)

// TechnicalError is a technical (non-decline) PSP failure.
type TechnicalError struct {
	Message string
	Cause   error
}

func (e *TechnicalError) Error() string { return e.Message }
func (e *TechnicalError) Unwrap() error { return e.Cause }

// HTTPDoer is the minimal interface this adapter needs from an HTTP
// client — satisfied by *http.Client, and injectable for tests.
type HTTPDoer interface {
	Do(req *http.Request) (*http.Response, error)
}

// Options configures a new Adapter.
type Options struct {
	Credentials Credentials
	// WebhookCredentials is optional — a process with API credentials
	// but no webhook keys configured can still make outbound Solidgate
	// calls; it just can't verify inbound Solidgate webhooks yet.
	WebhookCredentials *WebhookCredentials
	DeclineMap         map[string]domain.NormalizedDecline
	// HTTPClient is injectable for tests; defaults to a *http.Client
	// with a 20s timeout.
	HTTPClient HTTPDoer
}

// Adapter is the Solidgate PspAdapter implementation.
type Adapter struct {
	credentials        Credentials
	webhookCredentials *WebhookCredentials
	declineMap         map[string]domain.NormalizedDecline
	httpClient         HTTPDoer
}

// New constructs a Solidgate Adapter.
func New(opts Options) *Adapter {
	httpClient := opts.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 20 * time.Second}
	}
	declineMap := opts.DeclineMap
	if declineMap == nil {
		declineMap = map[string]domain.NormalizedDecline{}
	}
	return &Adapter{
		credentials:        opts.Credentials,
		webhookCredentials: opts.WebhookCredentials,
		declineMap:         declineMap,
		httpClient:         httpClient,
	}
}

// PSP returns "solidgate".
func (a *Adapter) PSP() string { return "solidgate" }

// PublicConfig implements adapters.PspAdapter. Solidgate's client-side
// widgets (Solidgate.js / the hosted card form) take the merchant's
// public key both as the widget's "merchant" identifier AND as its
// "key" parameter — the same value serves both roles, per Solidgate's
// published widget-initialization docs — so MerchantIdentifier is
// populated here (pointing at the same PublicKey value) rather than
// left nil the way Stripe's PublicConfig leaves it, since Stripe's
// client-side JS genuinely only needs the one value. FLAGGED (same
// caveat as the rest of this package's doc comments): this has not been
// verified against a live Solidgate sandbox account/widget integration
// — verify the actual widget init call's expected field names before
// this ships.
func (a *Adapter) PublicConfig() adapters.PublicConfig {
	merchantIdentifier := a.credentials.PublicKey
	return adapters.PublicConfig{
		PSP:                "solidgate",
		PublishableKey:     a.credentials.PublicKey,
		MerchantIdentifier: &merchantIdentifier,
	}
}

func (a *Adapter) request(ctx context.Context, path string, body map[string]any) (*ChargeResponse, error) {
	var jsonBytes []byte
	var jsonString *string
	method := http.MethodGet
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, &TechnicalError{Message: fmt.Sprintf("solidgate: failed to encode request body for %s", path), Cause: err}
		}
		jsonBytes = encoded
		s := string(encoded)
		jsonString = &s
		method = http.MethodPost
	}

	headers := BuildAuthHeaders(a.credentials.PublicKey, a.credentials.SecretKey, jsonString)

	url := a.credentials.APIBaseURL + path
	var bodyReader io.Reader
	if jsonBytes != nil {
		bodyReader = bytes.NewReader(jsonBytes)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, bodyReader)
	if err != nil {
		return nil, &TechnicalError{Message: fmt.Sprintf("solidgate %s request failed", path), Cause: err}
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("merchant", headers.Merchant)
	req.Header.Set("signature", headers.Signature)

	resp, err := a.httpClient.Do(req)
	if err != nil {
		return nil, &TechnicalError{Message: fmt.Sprintf("solidgate %s request failed", path), Cause: err}
	}
	defer resp.Body.Close()

	respBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, &TechnicalError{Message: fmt.Sprintf("solidgate %s returned an unreadable response body", path), Cause: err}
	}

	var parsed ChargeResponse
	if err := json.Unmarshal(respBytes, &parsed); err != nil {
		return nil, &TechnicalError{Message: fmt.Sprintf("solidgate %s returned non-JSON response", path), Cause: err}
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &TechnicalError{Message: fmt.Sprintf("solidgate %s returned HTTP %d", path, resp.StatusCode)}
	}
	return &parsed, nil
}

// CreatePayment implements adapters.PspAdapter.
func (a *Adapter) CreatePayment(ctx context.Context, input adapters.CreatePaymentInput) (adapters.AttemptResult, error) {
	if input.CustomerEmail == nil || *input.CustomerEmail == "" {
		// Solidgate's /charge documents customer_email as required —
		// see ADR-0011. Every current caller supplies it; a caller that
		// doesn't is a bug at the call site, not something to paper
		// over with a fake address that would end up on a real receipt.
		return adapters.AttemptResult{}, &TechnicalError{
			Message: "solidgate: CreatePayment requires CustomerEmail (adapters.CreatePaymentInput.CustomerEmail)",
		}
	}

	statementDescriptor := fmt.Sprintf("Payment %s", input.PaymentID)
	if input.StatementDescriptor != nil {
		statementDescriptor = *input.StatementDescriptor
	} else if input.StatementDescriptorSuffix != nil {
		// Solidgate's /charge has a single descriptor field, not
		// Stripe's separate static-prefix/dynamic-suffix pair — see
		// adapters.CreatePaymentInput's doc comment. Falling back to
		// the suffix here means a psp_account's configured suffix
		// still takes effect even when routing lands on a Solidgate
		// account rather than Stripe.
		statementDescriptor = *input.StatementDescriptorSuffix
	}

	paymentType := "1-click"
	if input.Context.CitMit == adapters.CitMitMIT {
		paymentType = "recurring"
	}

	// FLAGGED: request field name for a stored-token charge is inferred
	// as card_token (mirroring the RESPONSE field
	// transaction.card_token.token, which the original research session
	// DID confirm) — the "Token Payment" request variant itself wasn't
	// reached before that session's doc fetch was truncated. Verify
	// against a live sandbox call before production use.
	body := map[string]any{
		"order_id":           input.PaymentID,
		"amount":             input.Amount.MinorUnits(),
		"currency":           input.Amount.Currency(),
		"order_description":  statementDescriptor,
		"customer_email":     *input.CustomerEmail,
		"card_token":         input.PaymentMethodRef,
		"payment_type":       paymentType,
	}
	if input.Context.NetworkTransactionID != nil {
		body["scheme_transaction_id"] = *input.Context.NetworkTransactionID
	}

	response, err := a.request(ctx, "/charge", body)
	if err != nil {
		return adapters.AttemptResult{}, err
	}
	return a.toAttemptResult(*response), nil
}

// Capture implements adapters.PspAdapter.
//
// FLAGGED: endpoint path inferred from the confirmed /charge and
// /resign//refund//void naming convention (all confirmed to exist via
// their API-reference links in the original research session; /settle's
// exact path was not independently fetched there).
func (a *Adapter) Capture(ctx context.Context, pspAttemptRef string, amount *domain.Money, _ string) (adapters.AttemptResult, error) {
	body := map[string]any{"order_id": pspAttemptRef}
	if amount != nil {
		body["amount"] = amount.MinorUnits()
	}
	response, err := a.request(ctx, "/settle", body)
	if err != nil {
		return adapters.AttemptResult{}, err
	}
	return a.toAttemptResult(*response), nil
}

// Void implements adapters.PspAdapter.
func (a *Adapter) Void(ctx context.Context, pspAttemptRef string, _ string) (adapters.AttemptResult, error) {
	response, err := a.request(ctx, "/void", map[string]any{"order_id": pspAttemptRef})
	if err != nil {
		return adapters.AttemptResult{}, err
	}
	return a.toAttemptResult(*response), nil
}

// Refund implements adapters.PspAdapter.
func (a *Adapter) Refund(ctx context.Context, pspAttemptRef string, amount domain.Money, _ string) (adapters.RefundResult, error) {
	response, err := a.request(ctx, "/refund", map[string]any{
		"order_id": pspAttemptRef,
		"amount":   amount.MinorUnits(),
	})
	if err != nil {
		return adapters.RefundResult{}, err
	}
	status := MapOrderStatus(response.Order.Status)
	refundStatus := adapters.RefundStatusPending
	switch status {
	case adapters.AttemptStatusRefunded:
		refundStatus = adapters.RefundStatusSucceeded
	case adapters.AttemptStatusFailed:
		refundStatus = adapters.RefundStatusFailed
	}
	pspRefundRef := response.Order.OrderID
	if response.Transaction != nil && response.Transaction.ID != "" {
		pspRefundRef = response.Transaction.ID
	}
	return adapters.RefundResult{
		PspRefundRef: pspRefundRef,
		Status:       refundStatus,
		Amount:       amount,
	}, nil
}

// GetPayment implements adapters.PspAdapter.
//
// FLAGGED: /status path inferred, not independently confirmed.
func (a *Adapter) GetPayment(ctx context.Context, pspAttemptRef string) (adapters.AttemptSnapshot, error) {
	response, err := a.request(ctx, "/status", map[string]any{"order_id": pspAttemptRef})
	if err != nil {
		return adapters.AttemptSnapshot{}, err
	}
	result := a.toAttemptResult(*response)
	return adapters.AttemptSnapshot{
		PspAttemptRef: result.PspAttemptRef,
		Status:        result.Status,
		Decline:       result.Decline,
	}, nil
}

// VerifyWebhook implements adapters.PspAdapter.
func (a *Adapter) VerifyWebhook(rawBody []byte, headers map[string][]string) (adapters.VerifiedEvent, error) {
	if a.webhookCredentials == nil {
		return adapters.VerifiedEvent{}, adapters.NewInvalidSignatureError(
			"solidgate",
			"no webhook credentials configured for this process (SOLIDGATE_WEBHOOK_PUBLIC_KEY/SOLIDGATE_WEBHOOK_SECRET_KEY)",
		)
	}
	merchant := firstHeader(headers, "merchant")
	signature := firstHeader(headers, "signature")
	if merchant == "" || signature == "" {
		return adapters.VerifiedEvent{}, adapters.NewInvalidSignatureError("solidgate", "missing merchant/signature headers")
	}
	if merchant != a.webhookCredentials.WebhookPublicKey {
		return adapters.VerifiedEvent{}, adapters.NewInvalidSignatureError("solidgate", "merchant header does not match configured webhook public key")
	}

	bodyString := string(rawBody)
	expected := ComputeSignature(a.webhookCredentials.WebhookPublicKey, a.webhookCredentials.WebhookSecretKey, &bodyString)
	if expected != signature {
		return adapters.VerifiedEvent{}, adapters.NewInvalidSignatureError("solidgate", "signature mismatch")
	}

	var parsed ChargeResponse
	if err := json.Unmarshal(rawBody, &parsed); err != nil {
		return adapters.VerifiedEvent{}, adapters.NewInvalidSignatureError("solidgate", "invalid JSON body: "+err.Error())
	}

	providerEventID := firstHeader(headers, "solidgate-event-id")
	if providerEventID == "" {
		providerEventID = parsed.Order.OrderID
	}
	return adapters.VerifiedEvent{ProviderEventID: providerEventID, RawPayload: &parsed}, nil
}

// NormalizeEvent implements adapters.PspAdapter.
func (a *Adapter) NormalizeEvent(rawPayload any) []domain.CanonicalEvent {
	body, ok := asChargeResponse(rawPayload)
	if !ok {
		return nil
	}
	return NormalizeEvent(body)
}

// ExtractPaymentID implements adapters.PspAdapter. We always set
// order_id = our own paymentId at charge time (CreatePayment, above),
// so no separate metadata lookup is needed the way Stripe's adapter
// needs one — this is a genuine simplification Solidgate's model
// affords.
func (a *Adapter) ExtractPaymentID(rawPayload any) *string {
	body, ok := asChargeResponse(rawPayload)
	if !ok || body.Order.OrderID == "" {
		return nil
	}
	id := body.Order.OrderID
	return &id
}

// ExtractPspAttemptRef implements adapters.PspAdapter.
func (a *Adapter) ExtractPspAttemptRef(rawPayload any) *string {
	return a.ExtractPaymentID(rawPayload)
}

// NormalizeDecline implements adapters.PspAdapter.
func (a *Adapter) NormalizeDecline(rawCode string) domain.NormalizedDecline {
	return NormalizeDecline(a.declineMap, rawCode)
}

// Capabilities implements adapters.PspAdapter.
func (a *Adapter) Capabilities() adapters.PspCapabilities {
	return adapters.PspCapabilities{
		Methods:               []string{"card"},
		Currencies:            []string{"USD", "EUR", "GBP"},
		ThreeDs:               true,
		SupportsNetworkTokens: true,
	}
}

// ListSettlements implements adapters.PspAdapter.
//
// FLAGGED: Solidgate's Finance/Reporting API
// (docs.solidgate.com/finance, docs.solidgate.com/reporting) almost
// certainly has settlement/payout equivalents, but researching that
// surface was out of scope for the session that produced the TS
// reference implementation (which focused on the card-payments API
// needed for createPayment/capture/void/refund) and remains out of
// scope for this port. Returning an empty slice here is an honest "not
// yet implemented," not a claim that Solidgate lacks this capability —
// unlike Stripe's ListAccountUpdates's empty slice, which IS a
// researched claim that Stripe has no equivalent polling endpoint.
func (a *Adapter) ListSettlements(ctx context.Context, sinceISO string) ([]adapters.SettlementRecord, error) {
	return nil, nil
}

// ListPayouts implements adapters.PspAdapter. See ListSettlements's
// FLAGGED comment — same honest "not yet implemented" status.
func (a *Adapter) ListPayouts(ctx context.Context, sinceISO string) ([]adapters.PayoutRecord, error) {
	return nil, nil
}

// ListAccountUpdates implements adapters.PspAdapter. See
// ListSettlements's FLAGGED comment — same honest "not yet
// implemented" status.
func (a *Adapter) ListAccountUpdates(ctx context.Context, sinceISO string) ([]adapters.AccountUpdateRecord, error) {
	return nil, nil
}

func (a *Adapter) toAttemptResult(response ChargeResponse) adapters.AttemptResult {
	status := MapOrderStatus(response.Order.Status)

	var decline *domain.NormalizedDecline
	if status == adapters.AttemptStatusDeclined {
		rawDeclineCode := ExtractDeclineCode(response)
		if rawDeclineCode != nil {
			d := a.NormalizeDecline(*rawDeclineCode)
			decline = &d
		}
	}

	result := adapters.AttemptResult{
		PspAttemptRef: response.Order.OrderID,
		Status:        status,
		Decline:       decline,
		// ClientSecret intentionally left unset: FLAGGED — Solidgate's
		// 3DS flow uses a verify_url redirect ("Resign 3D Secure
		// involves a resign request and a 3D Secure verify_url
		// redirect"), not a Stripe-style client_secret a frontend SDK
		// confirms client-side. adapters.AttemptResult.ClientSecret is
		// Stripe-shaped, and mapping Solidgate's redirect-URL model onto
		// it isn't a one-line translation — left unset rather than
		// mapped incorrectly. T8.5 scope did not include reconciling
		// this cross-PSP difference at the interface level.
		// NetworkTransactionID intentionally left unset: FLAGGED — not
		// yet extracted; see transaction.scheme_transaction_id in a
		// future pass.
	}
	if status == adapters.AttemptStatusRequiresAction {
		result.ThreeDs = &adapters.ThreeDsInfo{Required: true}
	}
	return result
}

func asChargeResponse(rawPayload any) (*ChargeResponse, bool) {
	switch v := rawPayload.(type) {
	case *ChargeResponse:
		return v, v != nil
	case ChargeResponse:
		return &v, true
	default:
		return nil, false
	}
}

// firstHeader looks up key case-insensitively and returns the first
// value, or "" if absent.
//
// BUG FIX (backend audit, 2026-07-07): this used to be a bare
// `headers[key]` map lookup against a lowercase literal (e.g.
// "stripe-signature", "paypal-auth-algo", "x-mock-signature"). That
// was correct against every existing unit test in this package
// (which all hand-build `map[string][]string{"stripe-signature": ...}`
// with lowercase keys directly) but WRONG against the actual
// production call site: internal/api/webhooks.go passes `r.Header`
// (Go's net/http.Header) straight through internal/webhooks.Ingest
// into this method. net/http's server ALWAYS canonicalizes incoming
// header keys via textproto.CanonicalMIMEHeaderKey before populating
// r.Header — "stripe-signature" becomes "Stripe-Signature",
// "paypal-auth-algo" becomes "Paypal-Auth-Algo", etc. A bare
// case-sensitive map lookup with a lowercase literal therefore NEVER
// matched a real incoming request's headers, meaning every genuine
// webhook from every PSP would silently fail signature verification
// (VerifyWebhook would read "" for every header, fail to verify, and
// return *adapters.InvalidSignatureError) while every unit test still
// passed, because the tests bypass net/http entirely and hand-build
// already-lowercase maps. This is a fail-CLOSED bug (rejects real
// webhooks rather than accepting forged ones -- no security
// regression from this specific defect), but it is a complete
// functional break of the webhook ingestion pipeline against real PSP
// traffic. Fixed by scanning all keys with strings.EqualFold instead
// of an exact map lookup, which is correct regardless of whether the
// caller passes canonicalized net/http headers (real traffic) or
// lowercase literals (every existing test) -- no test needed to
// change.
func firstHeader(headers map[string][]string, key string) string {
	if headers == nil {
		return ""
	}
	for k, values := range headers {
		if strings.EqualFold(k, key) && len(values) > 0 {
			return values[0]
		}
	}
	return ""
}
