// Package paypal is the PayPal PspAdapter implementation. This is the
// ONLY package (its files: paypal.go, statusmapping.go, events.go,
// credentials.go) allowed to build PayPal-specific request/response
// shapes or reference a PayPal-specific status string (Non-negotiable
// #7), matching the same boundary rule stripe/** and solidgate/**
// enforce for their own SDKs/shapes.
//
// Built as a hand-rolled REST client (net/http only) against PayPal's
// real Orders API v2, exactly like solidgate/solidgate.go — there is
// no official PayPal Go SDK imported here, and go.mod's existing
// dependency set has no HTTP client library beyond net/http (checked
// directly before writing this package: solidgate/solidgate.go is the
// only other adapter making raw HTTP calls, and it too uses only
// net/http + encoding/json).
//
// FLAGGED, REPEATEDLY, BECAUSE IT MATTERS (same standing caveat as
// solidgate/solidgate.go's docblock): this adapter is written against
// PayPal's PUBLISHED Orders API v2 / OAuth2 / Webhooks documentation
// (endpoint paths, request/response field names and nesting, the
// OAuth2 client-credentials flow, and the decline-reason enum are
// confirmed against real docs, not guessed) but has NEVER been run
// against a live PayPal sandbox account, because none is reachable
// from this build environment. Specific gaps are called out inline via
// FLAGGED comments and summarized in MIGRATION_NOTES.md's PayPal
// section's least-confident-about list.
//
// *** STRUCTURAL DIFFERENCE FROM STRIPE/SOLIDGATE, CALLED OUT UP
// FRONT ***: PayPal's real checkout flow requires the BUYER to
// complete a browser redirect (the order's "approve" link) before an
// order can be captured — there is no server-to-server equivalent of
// Stripe's Confirm:true/OffSession:true one-call authorize-and-capture
// for a fresh CIT payment. CreatePayment here therefore creates the
// order and returns a requires_action-shaped AttemptResult carrying
// the approve link (see toAttemptResultFromOrder below) — the closest
// analogue this codebase's canonical shape has to "customer action
// still required," exactly the same shape Stripe's own
// requires_action/ClientSecret case uses for a 3DS challenge (see
// stripe.go's toAttemptResult, the `if status ==
// adapters.AttemptStatusRequiresAction` branch this function mirrors).
// A genuine MIT/off-session recharge of a previously-vaulted PayPal
// payment method (billing agreements / vault v3) is a DIFFERENT
// PayPal API surface this task's scope did not cover — see
// MIGRATION_NOTES.md.
package paypal

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/alphapayments/payment-orchestrator/internal/adapters"
	"github.com/alphapayments/payment-orchestrator/internal/domain"
)

// TechnicalError is a technical (non-decline) PSP failure — network
// errors, rate limits, 5xx responses, OAuth token failures. Mirrors
// stripe.TechnicalError/solidgate.TechnicalError exactly in shape and
// intent: distinct from a decline (a normal business outcome this
// adapter surfaces as AttemptResult.Decline, never a returned error).
type TechnicalError struct {
	PSP     string
	Message string
	Cause   error
}

func (e *TechnicalError) Error() string { return e.Message }
func (e *TechnicalError) Unwrap() error { return e.Cause }

// HTTPDoer is the minimal interface this adapter needs from an HTTP
// client — satisfied by *http.Client, and injectable for tests.
// Mirrors solidgate.HTTPDoer exactly.
type HTTPDoer interface {
	Do(req *http.Request) (*http.Response, error)
}

// Options configures a new Adapter. Mirrors stripe.Options/
// solidgate.Options's shape.
type Options struct {
	Credentials Credentials
	// DeclineMap is loaded once from decline_code_map at boot.
	DeclineMap map[string]domain.NormalizedDecline
	// HTTPClient is injectable for tests; defaults to a *http.Client
	// with a 20s timeout, matching solidgate.Options.HTTPClient's
	// default exactly.
	HTTPClient HTTPDoer
	// Now is injectable for tests to control token-expiry behavior
	// deterministically; defaults to time.Now.
	Now func() time.Time
}

// tokenState holds the cached OAuth2 access token and its computed
// expiry instant.
type tokenState struct {
	accessToken string
	expiresAt   time.Time
}

// Adapter is the PayPal PspAdapter implementation.
//
// tokenMu/token implement this adapter's OAuth2 access-token cache —
// the FIRST adapter in this codebase needing token caching (Stripe
// uses a static secret key sent directly on every request; Solidgate
// HMAC-signs each request with its own static key pair — neither ever
// needs to exchange credentials for a separate, expiring bearer
// token). There is therefore no exact precedent in this codebase to
// copy for this specific concern; the pattern below (double-checked
// locking: an RLock'd fast-path read, then a Lock'd re-check-then-
// refresh on miss/expiry) is standard Go concurrency practice for a
// read-mostly cached value that's expensive to recompute and must
// stay correct under concurrent callers, which matters here
// specifically because registry.Registry caches one Adapter instance
// per psp_account id and reuses it across concurrent requests (see
// registry.go's Resolve/cache) — multiple goroutines can call
// getAccessToken at once, and must not each independently fire a
// redundant /v1/oauth2/token request, nor read a half-written token.
type Adapter struct {
	credentials Credentials
	declineMap  map[string]domain.NormalizedDecline
	httpClient  HTTPDoer
	now         func() time.Time

	tokenMu sync.RWMutex
	token   *tokenState
}

// New constructs a PayPal Adapter.
func New(opts Options) *Adapter {
	httpClient := opts.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 20 * time.Second}
	}
	declineMap := opts.DeclineMap
	if declineMap == nil {
		declineMap = map[string]domain.NormalizedDecline{}
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	return &Adapter{
		credentials: opts.Credentials,
		declineMap:  declineMap,
		httpClient:  httpClient,
		now:         now,
	}
}

// PSP returns "paypal".
func (a *Adapter) PSP() string { return "paypal" }

// PublicConfig implements adapters.PspAdapter. PayPal's client-side JS
// SDK (the "PayPal Buttons"/Smart Payment Buttons script) needs only
// the Client ID to initialize — there is no second public identifier
// analogous to Solidgate's MerchantIdentifier, so this is left nil,
// exactly matching Stripe's PublicConfig rationale (see
// stripe.go's PublicConfig doc comment).
func (a *Adapter) PublicConfig() adapters.PublicConfig {
	return adapters.PublicConfig{
		PSP:            "paypal",
		PublishableKey: a.credentials.ClientID,
	}
}

// tokenResponse mirrors PayPal's OAuth2 token endpoint's response body
// (developer.paypal.com/api/rest/authentication/, POST
// /v1/oauth2/token): {"scope": "...", "access_token": "...",
// "token_type": "Bearer", "app_id": "...", "expires_in": 32400,
// "nonce": "..."}.
type tokenResponse struct {
	Scope       string `json:"scope,omitempty"`
	AccessToken string `json:"access_token"`
	TokenType   string `json:"token_type,omitempty"`
	AppID       string `json:"app_id,omitempty"`
	ExpiresIn   int64  `json:"expires_in"`
	Nonce       string `json:"nonce,omitempty"`
}

// tokenRefreshSafetyMargin is subtracted from expires_in before
// caching, so a token is proactively refreshed slightly before PayPal
// actually expires it — avoiding a request that races the token's
// real expiry and gets an auth failure back.
const tokenRefreshSafetyMargin = 60 * time.Second

// getAccessToken returns a cached, non-expired OAuth2 access token,
// refreshing it if needed. Double-checked locking: the fast path takes
// only a read lock and returns immediately if a cached token is still
// valid (the common case, once warmed up); only a cache miss/expiry
// takes the write lock, and re-checks validity once inside it (in case
// another goroutine already refreshed it while this one was waiting
// for the write lock) before actually making the outbound token
// request — so concurrent callers never issue more than one redundant
// /v1/oauth2/token call for the same expiry window.
func (a *Adapter) getAccessToken(ctx context.Context) (string, error) {
	a.tokenMu.RLock()
	if a.token != nil && a.now().Before(a.token.expiresAt) {
		token := a.token.accessToken
		a.tokenMu.RUnlock()
		return token, nil
	}
	a.tokenMu.RUnlock()

	a.tokenMu.Lock()
	defer a.tokenMu.Unlock()
	// Re-check: another goroutine may have already refreshed the token
	// while this one was waiting for the write lock.
	if a.token != nil && a.now().Before(a.token.expiresAt) {
		return a.token.accessToken, nil
	}

	form := url.Values{}
	form.Set("grant_type", "client_credentials")

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.credentials.APIBaseURL+"/v1/oauth2/token", strings.NewReader(form.Encode()))
	if err != nil {
		return "", &TechnicalError{PSP: "paypal", Message: "paypal: failed to build oauth2 token request", Cause: err}
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.SetBasicAuth(a.credentials.ClientID, a.credentials.ClientSecret)

	resp, err := a.httpClient.Do(req)
	if err != nil {
		return "", &TechnicalError{PSP: "paypal", Message: "paypal: oauth2 token request failed", Cause: err}
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", &TechnicalError{PSP: "paypal", Message: "paypal: oauth2 token response body unreadable", Cause: err}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", &TechnicalError{PSP: "paypal", Message: fmt.Sprintf("paypal: oauth2 token request returned HTTP %d: %s", resp.StatusCode, string(body))}
	}

	var parsed tokenResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "", &TechnicalError{PSP: "paypal", Message: "paypal: oauth2 token response was not valid JSON", Cause: err}
	}
	if parsed.AccessToken == "" {
		return "", &TechnicalError{PSP: "paypal", Message: "paypal: oauth2 token response had no access_token"}
	}

	expiresIn := time.Duration(parsed.ExpiresIn) * time.Second
	expiresAt := a.now().Add(expiresIn - tokenRefreshSafetyMargin)
	a.token = &tokenState{accessToken: parsed.AccessToken, expiresAt: expiresAt}
	return a.token.accessToken, nil
}

// amountToPayPalValue converts a domain.Money into PayPal's
// {"currency_code", "value"} decimal-string amount shape (see
// statusmapping.go's Amount doc comment for why PayPal takes a decimal
// string rather than integer minor units, unlike Stripe/Solidgate).
//
// BUG FIX (backend review, 2026-07-10): zero-decimal currency handling.
// This function used to unconditionally assume every currency uses
// exactly 2 minor-unit decimal places — true for USD/EUR/GBP (the only
// three currencies Capabilities() below advertises today, so this was
// never reachable with a wrong answer in production), but PayPal's
// documented amount.value format follows the same zero-decimal
// distinction Stripe/Solidgate's own request shapes do (see
// domain.ZeroDecimalCurrencies' doc comment: "minor units ARE the whole
// unit for these currencies — JPY 100 means ¥100, not ¥1.00"): a
// zero-decimal currency's PayPal value is the bare integer ("100"), not
// "1.00". domain.MakeMoney already accepts JPY/KRW/etc (they're in
// domain.KnownCurrencies), so this was a landmine waiting for
// Capabilities() to be extended, not a purely theoretical gap — fixed
// now, before that extension, rather than after.
func amountToPayPalValue(amount domain.Money) string {
	minorUnits := amount.MinorUnits()
	if domain.IsZeroDecimalCurrency(amount.Currency()) {
		return fmt.Sprintf("%d", minorUnits)
	}
	whole := minorUnits / 100
	fraction := minorUnits % 100
	if fraction < 0 {
		fraction = -fraction
	}
	return fmt.Sprintf("%d.%02d", whole, fraction)
}

// payPalValueToMinorUnits converts a PayPal decimal-string amount
// value back into integer minor units, the inverse of
// amountToPayPalValue, for constructing a domain.Money from a PayPal
// response (e.g. Refund's Amount). currency decides which of
// amountToPayPalValue's two encodings value is in — see that function's
// BUG FIX doc comment for the zero-decimal case this now mirrors on the
// way back in.
func payPalValueToMinorUnits(value string, currency string) (int64, error) {
	if domain.IsZeroDecimalCurrency(currency) {
		whole, err := strconv.ParseInt(value, 10, 64)
		if err != nil {
			return 0, err
		}
		return whole, nil
	}

	parts := strings.SplitN(value, ".", 2)
	wholePart := parts[0]
	fractionPart := "00"
	if len(parts) == 2 {
		fractionPart = parts[1]
	}
	for len(fractionPart) < 2 {
		fractionPart += "0"
	}
	fractionPart = fractionPart[:2]

	whole, err := strconv.ParseInt(wholePart, 10, 64)
	if err != nil {
		return 0, err
	}
	fraction, err := strconv.ParseInt(fractionPart, 10, 64)
	if err != nil {
		return 0, err
	}
	if whole < 0 {
		return whole*100 - fraction, nil
	}
	return whole*100 + fraction, nil
}

// doJSON performs an authenticated JSON request against PayPal's API
// — the shared plumbing every CreatePayment/Capture/Void/Refund/
// GetPayment call below builds on, mirroring solidgate.Adapter.request's
// role in that package. idempotencyKey, when non-empty, is forwarded
// as PayPal's own idempotency header (PayPal-Request-Id) — PayPal's
// documented analogue of the Idempotency-Key header stripe-go's
// params.SetIdempotencyKey sends on every mutating Stripe call (see
// stripe.go's CreatePayment/Capture/Void/Refund, all of which call
// SetIdempotencyKey) — so this adapter forwards idempotency
// consistently with how the other two adapters already do
// (Non-negotiable #4).
func (a *Adapter) doJSON(ctx context.Context, method string, path string, body any, idempotencyKey string) ([]byte, int, error) {
	token, err := a.getAccessToken(ctx)
	if err != nil {
		return nil, 0, err
	}

	var bodyReader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, 0, &TechnicalError{PSP: "paypal", Message: fmt.Sprintf("paypal: failed to encode request body for %s", path), Cause: err}
		}
		bodyReader = bytes.NewReader(encoded)
	}

	req, err := http.NewRequestWithContext(ctx, method, a.credentials.APIBaseURL+path, bodyReader)
	if err != nil {
		return nil, 0, &TechnicalError{PSP: "paypal", Message: fmt.Sprintf("paypal: failed to build request for %s", path), Cause: err}
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	if idempotencyKey != "" {
		req.Header.Set("PayPal-Request-Id", idempotencyKey)
	}

	resp, err := a.httpClient.Do(req)
	if err != nil {
		return nil, 0, &TechnicalError{PSP: "paypal", Message: fmt.Sprintf("paypal %s request failed", path), Cause: err}
	}
	defer resp.Body.Close()

	respBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, 0, &TechnicalError{PSP: "paypal", Message: fmt.Sprintf("paypal %s returned an unreadable response body", path), Cause: err}
	}
	return respBytes, resp.StatusCode, nil
}

// CreatePayment implements adapters.PspAdapter.
//
// See this package's doc comment for why PayPal's flow fundamentally
// cannot authorize-and-capture in one server-to-server call the way
// Stripe/Solidgate do: this call only ever creates the order
// (POST /v2/checkout/orders, intent=CAPTURE) and returns a
// requires_action-shaped AttemptResult carrying the buyer's approval
// redirect URL. input.PaymentMethodRef is not sent to PayPal at all —
// Orders API v2's create-order call takes no payment-instrument
// parameter; the payment method is selected by the BUYER during the
// approval redirect itself, a structural difference from Stripe's
// PaymentMethod-driven confirm this codebase's CreatePaymentInput
// shape was not originally designed around (see MIGRATION_NOTES.md).
func (a *Adapter) CreatePayment(ctx context.Context, input adapters.CreatePaymentInput) (adapters.AttemptResult, error) {
	body := map[string]any{
		"intent": "CAPTURE",
		"purchase_units": []map[string]any{
			{
				"amount": map[string]any{
					"currency_code": input.Amount.Currency(),
					"value":         amountToPayPalValue(input.Amount),
				},
				"custom_id": input.PaymentID,
			},
		},
	}

	respBytes, status, err := a.doJSON(ctx, http.MethodPost, "/v2/checkout/orders", body, input.IdempotencyKey)
	if err != nil {
		return adapters.AttemptResult{}, err
	}
	if status < 200 || status >= 300 {
		return adapters.AttemptResult{}, &TechnicalError{PSP: "paypal", Message: fmt.Sprintf("paypal createPayment failed: HTTP %d: %s", status, string(respBytes))}
	}

	var order Order
	if err := json.Unmarshal(respBytes, &order); err != nil {
		return adapters.AttemptResult{}, &TechnicalError{PSP: "paypal", Message: "paypal createPayment: response was not valid JSON", Cause: err}
	}
	return a.toAttemptResultFromOrder(&order), nil
}

// Capture implements adapters.PspAdapter. pspAttemptRef is the PayPal
// order id (see CreatePayment/toAttemptResultFromOrder — this
// adapter's AttemptResult.PspAttemptRef always carries the order id,
// never a capture or authorization id, mirroring how Stripe's
// PspAttemptRef always carries the PaymentIntent id, never a Charge
// id). POST /v2/checkout/orders/{id}/capture with an empty body
// captures the full order amount; amount is accepted for interface-
// signature parity with Stripe/Solidgate's own Capture but PayPal's
// order-capture endpoint takes no partial-amount parameter (partial
// capture of an ORDER is not part of PayPal's documented Orders API v2
// capture-order operation; only a partial capture of a prior
// AUTHORIZATION supports an amount — see captureAuthorization below,
// which this method does not call, since pspAttemptRef here is always
// an order id, never an authorization id, in every call site this
// codebase has today).
func (a *Adapter) Capture(ctx context.Context, pspAttemptRef string, amount *domain.Money, idempotencyKey string) (adapters.AttemptResult, error) {
	_ = amount // see doc comment: PayPal's order-capture endpoint takes no amount parameter.
	// BUG FIX (backend review, 2026-07-10): url.PathEscape guards against
	// path injection if pspAttemptRef ever contains a "/", "?", or other
	// URL-structural character — see doJSON's doc comment for why this
	// path is concatenated onto APIBaseURL with no re-parsing/escaping
	// of its own to catch this later.
	path := fmt.Sprintf("/v2/checkout/orders/%s/capture", url.PathEscape(pspAttemptRef))
	respBytes, status, err := a.doJSON(ctx, http.MethodPost, path, map[string]any{}, idempotencyKey)
	if err != nil {
		return adapters.AttemptResult{}, err
	}
	if status < 200 || status >= 300 {
		return adapters.AttemptResult{}, &TechnicalError{PSP: "paypal", Message: fmt.Sprintf("paypal capture failed: HTTP %d: %s", status, string(respBytes))}
	}

	var order Order
	if err := json.Unmarshal(respBytes, &order); err != nil {
		return adapters.AttemptResult{}, &TechnicalError{PSP: "paypal", Message: "paypal capture: response was not valid JSON", Cause: err}
	}
	return a.toAttemptResultFromOrder(&order), nil
}

// CaptureAuthorization captures a prior authorization
// (POST /v2/payments/authorizations/{authorization_id}/capture),
// optionally partial (amount non-nil) and optionally marking it the
// final capture against that authorization. This is a PayPal-specific
// capability beyond adapters.PspAdapter's Capture signature (which
// only accepts a pspAttemptRef, not an authorization id + final-capture
// flag) — exposed as an additional exported method, exactly the same
// pattern solidgate.Adapter uses nowhere itself but stripe.Adapter's
// package demonstrates is acceptable for this codebase (an adapter's
// exported surface may exceed the PspAdapter interface; only the
// interface itself is the non-negotiable contract). Not part of this
// task's required interface implementation — provided because the
// task brief explicitly describes this endpoint as a capability this
// adapter should support.
func (a *Adapter) CaptureAuthorization(ctx context.Context, authorizationID string, amount *domain.Money, finalCapture bool, idempotencyKey string) (adapters.AttemptResult, error) {
	body := map[string]any{"final_capture": finalCapture}
	if amount != nil {
		body["amount"] = map[string]any{
			"currency_code": amount.Currency(),
			"value":         amountToPayPalValue(*amount),
		}
	}
	path := fmt.Sprintf("/v2/payments/authorizations/%s/capture", url.PathEscape(authorizationID))
	respBytes, status, err := a.doJSON(ctx, http.MethodPost, path, body, idempotencyKey)
	if err != nil {
		return adapters.AttemptResult{}, err
	}
	if status < 200 || status >= 300 {
		return adapters.AttemptResult{}, &TechnicalError{PSP: "paypal", Message: fmt.Sprintf("paypal captureAuthorization failed: HTTP %d: %s", status, string(respBytes))}
	}
	var capture Capture
	if err := json.Unmarshal(respBytes, &capture); err != nil {
		return adapters.AttemptResult{}, &TechnicalError{PSP: "paypal", Message: "paypal captureAuthorization: response was not valid JSON", Cause: err}
	}
	return a.toAttemptResultFromCapture(authorizationID, &capture), nil
}

// resolveOrder fetches an order (GET /v2/checkout/orders/{id}) and
// returns it — the shared lookup Void/Refund below use to resolve an
// order id into the authorization/capture id PayPal's void/refund
// endpoints actually require. See Void/Refund's doc comments for why
// this call exists: this adapter's AttemptResult.PspAttemptRef always
// carries the PayPal ORDER id (Capture's doc comment), never an
// authorization or capture id, and no caller in this codebase ever
// persists anything else — internal/api/payments.go reads
// payment_attempts.psp_attempt_ref straight off the DB row and passes
// it through verbatim to Capture/Void/Refund, and grepping every
// UPDATE against that column across the repo turns up none: it is set
// once, at RecordAttempt time (internal/api/pgpaymentsstore.go), and
// never changed again. Resolving the id shape here, immediately before
// the mutating call that actually needs it, is the "get order details
// first" pattern PayPal's own docs describe for exactly this situation
// (developer.paypal.com/docs/api/orders/v2/#orders_get — the response's
// purchase_units[].payments.captures[]/.authorizations[] carry the ids
// void/refund need) — a documented, non-guessed resolution step, not a
// silently patched id-shape assumption.
func (a *Adapter) resolveOrder(ctx context.Context, orderID string) (*Order, error) {
	path := fmt.Sprintf("/v2/checkout/orders/%s", url.PathEscape(orderID))
	respBytes, status, err := a.doJSON(ctx, http.MethodGet, path, nil, "")
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, &TechnicalError{PSP: "paypal", Message: fmt.Sprintf("paypal void/refund: resolving order %s failed: HTTP %d: %s", orderID, status, string(respBytes))}
	}
	var order Order
	if err := json.Unmarshal(respBytes, &order); err != nil {
		return nil, &TechnicalError{PSP: "paypal", Message: fmt.Sprintf("paypal void/refund: order %s response was not valid JSON", orderID), Cause: err}
	}
	return &order, nil
}

// Void implements adapters.PspAdapter.
//
// RESOLVED (previously FLAGGED as a documented gap — see
// MIGRATION_NOTES.md's PayPal section for the investigation that
// closed this out): adapters.PspAdapter.Void's contract (types.go)
// takes a single pspAttemptRef, matching Stripe's
// PaymentIntents.Cancel, which voids a PaymentIntent by its own id
// directly. PayPal's void endpoint
// (POST /v2/payments/authorizations/{authorization_id}/void) only
// voids an AUTHORIZATION, addressed by authorization id, not an order
// id — but this adapter's AttemptResult.PspAttemptRef always carries
// the ORDER id (see Capture's doc comment). Tracing every Void call
// site in this codebase (internal/api/payments.go) confirmed
// payment_attempts.psp_attempt_ref is written once at attempt-creation
// time and never updated afterward, so a caller genuinely never has an
// authorization id available to pass in instead — this is not a
// hypothetical gap, and there is no schema-level place to source a
// better id from (no captures/authorizations table, and
// AttemptResult.RawResponseRef is never populated by any adapter
// today). Rather than guess a different id shape or push a schema
// change onto every call site, this method resolves the
// order->authorization id itself: GET
// /v2/checkout/orders/{pspAttemptRef} (resolveOrder above), read
// purchase_units[0].payments.authorizations[0].id
// (extractAuthorization, statusmapping.go), then void THAT id. If the
// order has no authorization on it at all (e.g. it was captured
// directly via intent=CAPTURE without a separate authorize step having
// happened yet, or was never approved by the buyer), there is nothing
// to void — surfaced as a TechnicalError rather than silently no-op'ing,
// since a caller asking to void an attempt that has no authorization to
// cancel is itself a real error worth surfacing, not a state this
// method should paper over.
func (a *Adapter) Void(ctx context.Context, pspAttemptRef string, idempotencyKey string) (adapters.AttemptResult, error) {
	order, err := a.resolveOrder(ctx, pspAttemptRef)
	if err != nil {
		return adapters.AttemptResult{}, err
	}
	authorization := extractAuthorization(order)
	if authorization == nil || authorization.ID == "" {
		return adapters.AttemptResult{}, &TechnicalError{PSP: "paypal", Message: fmt.Sprintf("paypal void: order %s has no authorization to void (purchase_units[0].payments.authorizations is empty)", pspAttemptRef)}
	}

	path := fmt.Sprintf("/v2/payments/authorizations/%s/void", url.PathEscape(authorization.ID))
	respBytes, status, err := a.doJSON(ctx, http.MethodPost, path, nil, idempotencyKey)
	if err != nil {
		return adapters.AttemptResult{}, err
	}
	// PayPal documents 204 No Content on a successful void, with no
	// response body to decode — unlike every other call in this
	// adapter, so this branch is handled before attempting any JSON
	// unmarshal. The returned AttemptResult still carries the ORDER id
	// (pspAttemptRef, not authorization.ID) in PspAttemptRef, so the
	// caller's persisted payment_attempts.psp_attempt_ref is unchanged
	// and stays consistent with every other AttemptResult this adapter
	// returns (CreatePayment/Capture/GetPayment all key off the order id
	// too) — this method resolves the id shape internally, it does not
	// change what the rest of this codebase persists as the attempt's
	// reference.
	if status == http.StatusNoContent {
		return adapters.AttemptResult{PspAttemptRef: pspAttemptRef, Status: adapters.AttemptStatusVoided}, nil
	}
	if status < 200 || status >= 300 {
		return adapters.AttemptResult{}, &TechnicalError{PSP: "paypal", Message: fmt.Sprintf("paypal void failed: HTTP %d: %s", status, string(respBytes))}
	}
	return adapters.AttemptResult{PspAttemptRef: pspAttemptRef, Status: adapters.AttemptStatusVoided}, nil
}

// Refund implements adapters.PspAdapter.
//
// RESOLVED (previously FLAGGED as a documented gap — see
// MIGRATION_NOTES.md's PayPal section for the investigation that
// closed this out): same pspAttemptRef-shape mismatch as Void, for the
// same reason — PayPal's refund endpoint
// (POST /v2/payments/captures/{capture_id}/refund) is addressed by
// CAPTURE id, not order id, but this adapter's AttemptResult.PspAttemptRef
// always carries the order id, and no caller in this codebase ever has
// a capture id to pass in instead (same call-site trace as Void's doc
// comment above). This method resolves it the same way Void does: GET
// /v2/checkout/orders/{pspAttemptRef} (resolveOrder above), read
// purchase_units[0].payments.captures[0].id (extractCapture,
// statusmapping.go — already used by toAttemptResultFromOrder, so this
// is not new parsing logic), then refund THAT id. If the order has no
// capture on it yet, there is nothing to refund — surfaced as a
// TechnicalError rather than guessing or silently no-op'ing.
func (a *Adapter) Refund(ctx context.Context, pspAttemptRef string, amount domain.Money, idempotencyKey string) (adapters.RefundResult, error) {
	order, err := a.resolveOrder(ctx, pspAttemptRef)
	if err != nil {
		return adapters.RefundResult{}, err
	}
	capture := extractCapture(order)
	if capture == nil || capture.ID == "" {
		return adapters.RefundResult{}, &TechnicalError{PSP: "paypal", Message: fmt.Sprintf("paypal refund: order %s has no capture to refund (purchase_units[0].payments.captures is empty)", pspAttemptRef)}
	}

	body := map[string]any{
		"amount": map[string]any{
			"currency_code": amount.Currency(),
			"value":         amountToPayPalValue(amount),
		},
	}
	path := fmt.Sprintf("/v2/payments/captures/%s/refund", url.PathEscape(capture.ID))
	respBytes, status, err := a.doJSON(ctx, http.MethodPost, path, body, idempotencyKey)
	if err != nil {
		return adapters.RefundResult{}, err
	}
	if status < 200 || status >= 300 {
		return adapters.RefundResult{}, &TechnicalError{PSP: "paypal", Message: fmt.Sprintf("paypal refund failed: HTTP %d: %s", status, string(respBytes))}
	}

	var refund Refund
	if err := json.Unmarshal(respBytes, &refund); err != nil {
		return adapters.RefundResult{}, &TechnicalError{PSP: "paypal", Message: "paypal refund: response was not valid JSON", Cause: err}
	}

	refundStatus := adapters.RefundStatusPending
	switch refund.Status {
	case "COMPLETED":
		refundStatus = adapters.RefundStatusSucceeded
	case "FAILED", "CANCELLED":
		refundStatus = adapters.RefundStatusFailed
	}

	resultAmount := amount
	if refund.Amount != nil {
		minorUnits, convErr := payPalValueToMinorUnits(refund.Amount.Value, refund.Amount.CurrencyCode)
		if convErr == nil {
			if converted, moneyErr := domain.MakeMoney(minorUnits, refund.Amount.CurrencyCode); moneyErr == nil {
				resultAmount = converted
			}
		}
	}

	return adapters.RefundResult{
		PspRefundRef: refund.ID,
		Status:       refundStatus,
		Amount:       resultAmount,
	}, nil
}

// GetPayment implements adapters.PspAdapter — gap-detection polling
// (Milestone 3, T3.5). GET /v2/checkout/orders/{id} returns the full
// order, including any nested captures/authorizations, so this single
// call is sufficient to reconstruct the same canonical status
// CreatePayment/Capture would have returned, mirroring
// stripe.Adapter.GetPayment's PaymentIntents.Get + Expand pattern.
func (a *Adapter) GetPayment(ctx context.Context, pspAttemptRef string) (adapters.AttemptSnapshot, error) {
	path := fmt.Sprintf("/v2/checkout/orders/%s", url.PathEscape(pspAttemptRef))
	respBytes, status, err := a.doJSON(ctx, http.MethodGet, path, nil, "")
	if err != nil {
		return adapters.AttemptSnapshot{}, err
	}
	if status < 200 || status >= 300 {
		return adapters.AttemptSnapshot{}, &TechnicalError{PSP: "paypal", Message: fmt.Sprintf("paypal getPayment failed: HTTP %d: %s", status, string(respBytes))}
	}

	var order Order
	if err := json.Unmarshal(respBytes, &order); err != nil {
		return adapters.AttemptSnapshot{}, &TechnicalError{PSP: "paypal", Message: "paypal getPayment: response was not valid JSON", Cause: err}
	}
	result := a.toAttemptResultFromOrder(&order)
	return adapters.AttemptSnapshot{
		PspAttemptRef: result.PspAttemptRef,
		Status:        result.Status,
		Decline:       result.Decline,
	}, nil
}

// verifyWebhookSignatureRequest mirrors the body
// POST /v1/notifications/verify-webhook-signature expects
// (developer.paypal.com/api/rest/webhooks/rest/#link-verifywebhooksignature):
// the 5 PAYPAL-* transmission headers, this account's configured
// webhook_id, and the raw parsed JSON body of the incoming webhook
// event.
type verifyWebhookSignatureRequest struct {
	AuthAlgo         string          `json:"auth_algo"`
	CertURL          string          `json:"cert_url"`
	TransmissionID   string          `json:"transmission_id"`
	TransmissionSig  string          `json:"transmission_sig"`
	TransmissionTime string          `json:"transmission_time"`
	WebhookID        string          `json:"webhook_id"`
	WebhookEvent     json.RawMessage `json:"webhook_event"`
}

// verifyWebhookSignatureResponse mirrors
// {"verification_status": "SUCCESS"|"FAILURE"}.
type verifyWebhookSignatureResponse struct {
	VerificationStatus string `json:"verification_status"`
}

// VerifyWebhook implements adapters.PspAdapter.
//
// *** STRUCTURALLY DIFFERENT FROM STRIPE/SOLIDGATE — CALLED OUT
// EXPLICITLY, PER THIS TASK'S INSTRUCTIONS ***: Stripe's
// webhook.ConstructEvent (stripe.go's VerifyWebhook) and Solidgate's
// ComputeSignature (solidgate.go's VerifyWebhook) both verify a
// webhook's signature with a LOCAL HMAC computation — no network call,
// bounded latency, and a signature mismatch simply means "this request
// wasn't really from the PSP." PayPal's verification model is
// fundamentally different: PayPal has NO documented local signature-
// verification algorithm for the certificate-based scheme its webhooks
// actually use (RSA-SHA256 over a certificate PayPal itself rotates,
// fetched from cert_url) — the ONLY documented way to verify a PayPal
// webhook is this OUTBOUND call to
// POST /v1/notifications/verify-webhook-signature, which means webhook
// verification for this adapter requires a LIVE NETWORK CALL (using
// the cached OAuth2 access token from getAccessToken) on every single
// inbound webhook.
//
// This has real failure-mode implications the other two adapters do
// not have: (1) LATENCY — every webhook now waits on a round trip to
// PayPal before this codebase's webhook pipeline can even enqueue the
// event, where Stripe/Solidgate's verification is effectively free;
// (2) AVAILABILITY COUPLING — if PayPal's verify-webhook-signature
// endpoint is slow, rate-limited, or down, this adapter cannot
// distinguish "the signature was actually invalid" from "we couldn't
// ask PayPal," and this implementation deliberately treats BOTH as
// verification failure (returns *adapters.InvalidSignatureError, never
// silently accepts an unverified event) — per this task's explicit
// instruction not to silently accept on a verify-call failure, this is
// a conservative/fail-closed choice, not an oversight; a future
// operator running this in production should watch for this failure
// mode inflating webhook_inbox's rejected-signature count during a
// PayPal outage and NOT interpret that as an actual signature-forgery
// spike; (3) an extra OAuth token fetch may be triggered from this
// code path too (getAccessToken's cache), coupling webhook
// verification's latency to token-refresh latency on a cold cache.
func (a *Adapter) VerifyWebhook(rawBody []byte, headers map[string][]string) (adapters.VerifiedEvent, error) {
	authAlgo := adapters.FirstHeader(headers, "paypal-auth-algo")
	certURL := adapters.FirstHeader(headers, "paypal-cert-url")
	transmissionID := adapters.FirstHeader(headers, "paypal-transmission-id")
	transmissionSig := adapters.FirstHeader(headers, "paypal-transmission-sig")
	transmissionTime := adapters.FirstHeader(headers, "paypal-transmission-time")
	if authAlgo == "" || certURL == "" || transmissionID == "" || transmissionSig == "" || transmissionTime == "" {
		return adapters.VerifiedEvent{}, adapters.NewInvalidSignatureError("paypal", "missing one or more PAYPAL-* transmission headers")
	}
	if a.credentials.WebhookID == "" {
		return adapters.VerifiedEvent{}, adapters.NewInvalidSignatureError("paypal", "no webhook_id configured for this psp_account (PAYPAL_WEBHOOK_ID)")
	}

	verifyBody := verifyWebhookSignatureRequest{
		AuthAlgo:         authAlgo,
		CertURL:          certURL,
		TransmissionID:   transmissionID,
		TransmissionSig:  transmissionSig,
		TransmissionTime: transmissionTime,
		WebhookID:        a.credentials.WebhookID,
		WebhookEvent:      json.RawMessage(rawBody),
	}

	// ctx.Background() is deliberate here: adapters.PspAdapter's
	// VerifyWebhook signature (types.go) takes no context.Context
	// parameter, unlike every other method on this interface — a
	// pre-existing constraint of the interface this adapter must
	// implement exactly as declared, not something introduced here.
	respBytes, status, err := a.doJSON(context.Background(), http.MethodPost, "/v1/notifications/verify-webhook-signature", verifyBody, "")
	if err != nil {
		// Per this method's own doc comment: a failed verify CALL
		// (network error, PayPal outage, OAuth failure) is treated as a
		// verification FAILURE, never silently accepted as valid.
		return adapters.VerifiedEvent{}, adapters.NewInvalidSignatureError("paypal", "verify-webhook-signature call failed: "+err.Error())
	}
	if status < 200 || status >= 300 {
		return adapters.VerifiedEvent{}, adapters.NewInvalidSignatureError("paypal", fmt.Sprintf("verify-webhook-signature returned HTTP %d: %s", status, string(respBytes)))
	}

	var parsed verifyWebhookSignatureResponse
	if err := json.Unmarshal(respBytes, &parsed); err != nil {
		return adapters.VerifiedEvent{}, adapters.NewInvalidSignatureError("paypal", "verify-webhook-signature response was not valid JSON: "+err.Error())
	}
	if parsed.VerificationStatus != "SUCCESS" {
		return adapters.VerifiedEvent{}, adapters.NewInvalidSignatureError("paypal", "verification_status was not SUCCESS: "+parsed.VerificationStatus)
	}

	var event WebhookEvent
	if err := json.Unmarshal(rawBody, &event); err != nil {
		return adapters.VerifiedEvent{}, adapters.NewInvalidSignatureError("paypal", "webhook body was not valid JSON: "+err.Error())
	}
	return adapters.VerifiedEvent{ProviderEventID: event.ID, RawPayload: &event}, nil
}

// NormalizeEvent implements adapters.PspAdapter.
func (a *Adapter) NormalizeEvent(rawPayload any) []domain.CanonicalEvent {
	event, ok := asWebhookEvent(rawPayload)
	if !ok {
		return nil
	}
	return NormalizeEvent(event, a.declineMap)
}

// ExtractPaymentID implements adapters.PspAdapter. Every
// CreatePayment call stamps input.PaymentID into
// purchase_units[0].custom_id (see CreatePayment above), so this
// looks for custom_id on whichever resource shape the event wraps —
// mirroring how stripe.Adapter.ExtractPaymentID reads
// PaymentIntent.Metadata["payment_id"] via extractMetadata.
func (a *Adapter) ExtractPaymentID(rawPayload any) *string {
	event, ok := asWebhookEvent(rawPayload)
	if !ok {
		return nil
	}
	switch event.EventType {
	case "CHECKOUT.ORDER.APPROVED":
		order, err := decodeOrderResource(event)
		if err != nil || len(order.PurchaseUnits) == 0 || order.PurchaseUnits[0].CustomID == "" {
			return nil
		}
		id := order.PurchaseUnits[0].CustomID
		return &id
	case "PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.REFUNDED":
		capture, err := decodeCaptureResource(event)
		if err != nil || capture.CustomID == "" {
			return nil
		}
		id := capture.CustomID
		return &id
	default:
		return nil
	}
}

// ExtractPspAttemptRef implements adapters.PspAdapter. For an order
// event, the resource IS the order (its own id is the psp attempt
// ref). For a capture event, the capture resource does not carry the
// order id as a bare field — only a HATEOAS "up" link back to it (see
// orderIDFromCaptureLinks in events.go) — mirroring exactly why
// stripe.Adapter.ExtractPspAttemptRef needs a separate Charge-carries-
// PaymentIntent-reference branch distinct from its PaymentIntent-IS-
// the-ref branch.
func (a *Adapter) ExtractPspAttemptRef(rawPayload any) *string {
	event, ok := asWebhookEvent(rawPayload)
	if !ok {
		return nil
	}
	switch event.EventType {
	case "CHECKOUT.ORDER.APPROVED":
		order, err := decodeOrderResource(event)
		if err != nil || order.ID == "" {
			return nil
		}
		id := order.ID
		return &id
	case "PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.REFUNDED":
		capture, err := decodeCaptureResource(event)
		if err != nil {
			return nil
		}
		return orderIDFromCaptureLinks(capture.Links)
	default:
		return nil
	}
}

// NormalizeDecline implements adapters.PspAdapter.
func (a *Adapter) NormalizeDecline(rawCode string) domain.NormalizedDecline {
	return NormalizeDecline(a.declineMap, rawCode)
}

// Capabilities implements adapters.PspAdapter.
func (a *Adapter) Capabilities() adapters.PspCapabilities {
	return adapters.PspCapabilities{
		Methods:               []string{"paypal"},
		Currencies:            []string{"USD", "EUR", "GBP"},
		ThreeDs:               false,
		SupportsNetworkTokens: false,
	}
}

// ListSettlements implements adapters.PspAdapter.
//
// FLAGGED, same honest "not yet implemented" status as
// solidgate.Adapter.ListSettlements's own FLAGGED comment (which this
// mirrors, not stripe.Adapter.ListSettlements's "researched and
// implemented" status): PayPal's Transaction Search / Reporting APIs
// (developer.paypal.com/docs/reports/) almost certainly have
// settlement/payout equivalents, but researching that surface was out
// of scope for the session that produced this adapter, which focused
// on the Orders API v2 surface needed for
// CreatePayment/Capture/Void/Refund/GetPayment/webhooks. Returning an
// empty slice here is an honest "not yet implemented," not a claim
// that PayPal lacks this capability.
func (a *Adapter) ListSettlements(ctx context.Context, sinceISO string) ([]adapters.SettlementRecord, error) {
	return nil, nil
}

// ListPayouts implements adapters.PspAdapter. See ListSettlements's
// FLAGGED comment — same honest "not yet implemented" status.
func (a *Adapter) ListPayouts(ctx context.Context, sinceISO string) ([]adapters.PayoutRecord, error) {
	return nil, nil
}

// ListAccountUpdates implements adapters.PspAdapter. PayPal has no
// stored-card-network account-updater concept the way card-network
// PSPs do — a buyer's PayPal account is not a card PAN a network can
// silently reissue — so, like stripe.Adapter.ListAccountUpdates's own
// researched (not stubbed) empty-slice answer, this is a considered
// "genuinely no equivalent," not a deferred implementation.
func (a *Adapter) ListAccountUpdates(ctx context.Context, sinceISO string) ([]adapters.AccountUpdateRecord, error) {
	return nil, nil
}

// toAttemptResultFromOrder builds a canonical AttemptResult from a
// PayPal Order — the CreatePayment/Capture(order-level)/GetPayment
// shared conversion, mirroring stripe.Adapter.toAttemptResult's role.
func (a *Adapter) toAttemptResultFromOrder(order *Order) adapters.AttemptResult {
	status := mapOrderStatus(order.Status)

	result := adapters.AttemptResult{
		PspAttemptRef: order.ID,
		Status:        status,
	}

	if status == adapters.AttemptStatusDeclined {
		if capture := extractCapture(order); capture != nil {
			if rawCode := ExtractDeclineCode(capture); rawCode != nil {
				d := a.NormalizeDecline(*rawCode)
				result.Decline = &d
			}
		}
	}

	// If a capture already exists on this order (e.g. GetPayment
	// polling an order that has since been captured), prefer the
	// capture's own status over the order's — mirroring how Stripe's
	// PaymentIntent.Status already reflects a capture, but PayPal's
	// order.status can lag behind (remaining "APPROVED" even briefly
	// after a capture call returns, per PayPal's documented eventual-
	// consistency behavior between the capture response and a
	// subsequent order GET).
	if capture := extractCapture(order); capture != nil {
		captureStatus := mapCaptureStatus(capture.Status)
		if captureStatus == adapters.AttemptStatusCaptured || captureStatus == adapters.AttemptStatusDeclined || captureStatus == adapters.AttemptStatusRefunded {
			result.Status = captureStatus
			if captureStatus == adapters.AttemptStatusDeclined {
				if rawCode := ExtractDeclineCode(capture); rawCode != nil {
					d := a.NormalizeDecline(*rawCode)
					result.Decline = &d
				}
			}
		}
	}

	if result.Status == adapters.AttemptStatusRequiresAction || result.Status == adapters.AttemptStatusAuthorized {
		if href := approveLink(order); href != nil {
			// ClientSecret is documented (types.go's AttemptResult) as
			// "the one PSP value allowed to reach the client directly."
			// PayPal has no client_secret concept — the approve link
			// itself is the browser-safe value a checkout UI needs to
			// complete the buyer's approval redirect, so it is carried
			// in this same field rather than left unset, matching how
			// this codebase's canonical shape has exactly one slot for
			// "the thing the browser needs to finish this CIT flow."
			result.ClientSecret = href
			result.ThreeDs = &adapters.ThreeDsInfo{Required: false}
		}
	}

	return result
}

// toAttemptResultFromCapture builds a canonical AttemptResult from a
// standalone Capture response (CaptureAuthorization's return shape,
// which is a bare capture object, not a full order).
func (a *Adapter) toAttemptResultFromCapture(pspAttemptRef string, capture *Capture) adapters.AttemptResult {
	status := mapCaptureStatus(capture.Status)
	result := adapters.AttemptResult{
		PspAttemptRef: pspAttemptRef,
		Status:        status,
	}
	if status == adapters.AttemptStatusDeclined {
		if rawCode := ExtractDeclineCode(capture); rawCode != nil {
			d := a.NormalizeDecline(*rawCode)
			result.Decline = &d
		}
	}
	return result
}

func asWebhookEvent(rawPayload any) (*WebhookEvent, bool) {
	switch v := rawPayload.(type) {
	case *WebhookEvent:
		return v, v != nil
	case WebhookEvent:
		return &v, true
	default:
		return nil, false
	}
}

// firstHeader used to live here as its own copy — DEDUPLICATION fix
// (backend review, 2026-07-10): identical byte-for-byte to the copy
// every other PSP adapter package (stripe, solidgate, mock) also
// carried. Hoisted into the shared internal/adapters package (already
// imported by every adapter) as adapters.FirstHeader — see that
// function's doc comment for the full history, including the original
// 2026-07-07 case-insensitivity bug fix this preserves. Every call site
// above now calls adapters.FirstHeader directly.
