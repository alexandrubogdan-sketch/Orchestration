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
	"crypto/hmac"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
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

// request issues one Solidgate API call. idempotencyKey is optional
// (pass "" for read-only calls like /status): when non-empty it is sent
// as X-Idempotency-Key, a best-effort, defense-in-depth measure only —
// Solidgate's published API reference (api-docs.solidgate.com/api/
// get-started, checked 2026-07-10) documents just two required
// headers, `merchant` and `signature`, and no idempotency-key mechanism
// of its own. Unlike Stripe (which has a first-class, documented
// Idempotency-Key contract honored server-side via
// params.SetIdempotencyKey), this Go port cannot honestly claim
// Solidgate will dedupe retried /settle, /void, or /refund calls on
// this header's account. The header is sent anyway (harmless if
// Solidgate ignores an unrecognized header) so the caller-supplied
// idempotencyKey parameter required by adapters.PspAdapter
// (Non-negotiable #4) is genuinely forwarded rather than silently
// discarded, but the actual, load-bearing idempotency guarantee for
// this PSP remains this codebase's own internal/api WithIdempotencyKey
// middleware + Postgres idempotency_keys table, which prevents a
// retried caller request from ever reaching this method a second time
// for the same logical operation in the first place.
func (a *Adapter) request(ctx context.Context, path string, body map[string]any, idempotencyKey string) (*ChargeResponse, error) {
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
	if idempotencyKey != "" {
		req.Header.Set("X-Idempotency-Key", idempotencyKey)
	}

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

	response, err := a.request(ctx, "/charge", body, input.IdempotencyKey)
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
func (a *Adapter) Capture(ctx context.Context, pspAttemptRef string, amount *domain.Money, idempotencyKey string) (adapters.AttemptResult, error) {
	body := map[string]any{"order_id": pspAttemptRef}
	if amount != nil {
		body["amount"] = amount.MinorUnits()
	}
	response, err := a.request(ctx, "/settle", body, idempotencyKey)
	if err != nil {
		return adapters.AttemptResult{}, err
	}
	return a.toAttemptResult(*response), nil
}

// Void implements adapters.PspAdapter.
func (a *Adapter) Void(ctx context.Context, pspAttemptRef string, idempotencyKey string) (adapters.AttemptResult, error) {
	response, err := a.request(ctx, "/void", map[string]any{"order_id": pspAttemptRef}, idempotencyKey)
	if err != nil {
		return adapters.AttemptResult{}, err
	}
	return a.toAttemptResult(*response), nil
}

// Refund implements adapters.PspAdapter.
func (a *Adapter) Refund(ctx context.Context, pspAttemptRef string, amount domain.Money, idempotencyKey string) (adapters.RefundResult, error) {
	response, err := a.request(ctx, "/refund", map[string]any{
		"order_id": pspAttemptRef,
		"amount":   amount.MinorUnits(),
	}, idempotencyKey)
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
	// No idempotencyKey: GetPayment is a read, not one of the mutating
	// calls Non-negotiable #4 requires an idempotency key for (see
	// adapters.PspAdapter's doc comment) — matches the interface, which
	// likewise gives GetPayment no idempotencyKey parameter.
	response, err := a.request(ctx, "/status", map[string]any{"order_id": pspAttemptRef}, "")
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
	merchant := adapters.FirstHeader(headers, "merchant")
	signature := adapters.FirstHeader(headers, "signature")
	if merchant == "" || signature == "" {
		return adapters.VerifiedEvent{}, adapters.NewInvalidSignatureError("solidgate", "missing merchant/signature headers")
	}
	// hmac.Equal rather than `!=`: the merchant header is not itself
	// secret (it's the caller's own public key echoed back), but using
	// the same constant-time helper consistently for every credential-
	// adjacent comparison in this method avoids leaving a bare `!=` next
	// to the signature check below for a future editor to copy-paste
	// into a context where it would matter.
	if !hmac.Equal([]byte(merchant), []byte(a.webhookCredentials.WebhookPublicKey)) {
		return adapters.VerifiedEvent{}, adapters.NewInvalidSignatureError("solidgate", "merchant header does not match configured webhook public key")
	}

	// Fixed 2026-07-10 (backend review): `expected != signature` is a
	// non-constant-time comparison — Go's `!=` on strings short-circuits
	// at the first differing byte, so response latency leaks how many
	// leading bytes of a forged signature happen to match, letting an
	// attacker recover the correct signature (and forge webhook events)
	// via a timing side-channel over enough attempts. hmac.Equal is
	// exactly the standard-library primitive for this: its runtime
	// depends only on the (public) byte length of its two arguments, not
	// on where — or whether — they differ.
	bodyString := string(rawBody)
	expected := ComputeSignature(a.webhookCredentials.WebhookPublicKey, a.webhookCredentials.WebhookSecretKey, &bodyString)
	if !hmac.Equal([]byte(expected), []byte(signature)) {
		return adapters.VerifiedEvent{}, adapters.NewInvalidSignatureError("solidgate", "signature mismatch")
	}

	var parsed ChargeResponse
	if err := json.Unmarshal(rawBody, &parsed); err != nil {
		return adapters.VerifiedEvent{}, adapters.NewInvalidSignatureError("solidgate", "invalid JSON body: "+err.Error())
	}

	providerEventID := adapters.FirstHeader(headers, "solidgate-event-id")
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

// firstHeader used to live here as its own copy — DEDUPLICATION fix
// (backend review, 2026-07-10): identical byte-for-byte to the copy
// every other PSP adapter package (stripe, paypal, mock) also carried.
// Hoisted into the shared internal/adapters package (already imported
// by every adapter) as adapters.FirstHeader — see that function's doc
// comment for the full history, including the original 2026-07-07
// case-insensitivity bug fix this preserves. Every call site above now
// calls adapters.FirstHeader directly.
