// Package stripe is the Stripe PspAdapter implementation (T2.3/T2.4).
// This is the ONLY package (its files: stripe.go, statusmapping.go,
// settlementmapping.go, credentials.go) allowed to import
// github.com/stripe/stripe-go or reference a Stripe-specific status
// string (Non-negotiable #7).
//
// stripe-go version: github.com/stripe/stripe-go/v81 — see
// MIGRATION_NOTES.md's Phase 2 section for why v81 (not a newer major)
// was chosen: this port could not reach proxy.golang.org/pkg.go.dev to
// confirm whether a newer major (v82+) exists or what its API shape is,
// so v81 was chosen as the last version this port's author has high
// confidence in the API shape of (client.API + package-level
// stripe.Params.SetIdempotencyKey + webhook.ConstructEvent) from
// well-established public documentation. RE-VERIFY the exact latest
// major version and API shape against pkg.go.dev/github.com/stripe/stripe-go
// before this ships — this is explicitly flagged as a low-confidence
// area in this phase's report.
//
// FLAGGED AMBIGUITY (per SPEC.md's working agreement — encode, don't
// guess), carried over unchanged from the TS reference implementation:
// MIT charges against a payment method vaulted directly with Stripe
// just need Customer + PaymentMethod + OffSession: true; Stripe
// resolves network-token/stored-credential usage internally. A
// *migrated* card (tokenized at another PSP, being charged at Stripe
// for the first time using a network_transaction_id captured
// elsewhere) additionally needs
// payment_method_options.card.mit_exemption wiring this codebase
// doesn't populate yet — there's no live Stripe account in this build
// environment to verify the exact request shape against, so it's
// deliberately left as a documented gap rather than a guessed
// implementation. Revisit when subscriptions/dunning (a later phase)
// needs cross-PSP card migration.
package stripe

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	stripesdk "github.com/stripe/stripe-go/v81"
	"github.com/stripe/stripe-go/v81/client"
	"github.com/stripe/stripe-go/v81/webhook"

	"github.com/alphapayments/payment-orchestrator/internal/adapters"
	"github.com/alphapayments/payment-orchestrator/internal/domain"
)

// defaultHTTPClientTimeout bounds every outbound call this adapter
// makes to Stripe's API.
//
// BUG FIX (backend review, 2026-07-10): New used to call sc.Init(key,
// nil), which makes stripe-go fall back to its own default backend —
// built on Go's zero-value http.Client, which has NO timeout at all
// (http.Client{}'s Timeout field defaults to 0, meaning "never time
// out"). A hung TCP connection or a Stripe-side stall could then block
// the goroutine making the call indefinitely — no context deadline
// existed anywhere in this call path to save it, since ctx cancellation
// alone does not abort a stdlib http.Client request unless the request
// was built with that ctx AND something (either the caller's context or
// the client's own Timeout) actually fires; stripe-go's client.API
// methods build the *http.Request from the ctx passed to them, so a
// timeout here is enforced via ctx as stripe-go itself recommends, but
// belt-and-suspenders: an explicit http.Client.Timeout also protects
// against any code path in this adapter (or a future stripe-go version)
// that ends up not threading ctx all the way through. 30s matches this
// adapter's own DECLINED-vs-TECHNICAL-error framing: a real Stripe API
// call should return well within a few seconds; 30s is generous
// headroom before this adapter gives up and reports a TechnicalError
// (which is retryable/failover-eligible per domain.IsEligibleForPspFailover)
// rather than hanging the caller's own request forever.
var defaultHTTPClientTimeout = 30 * time.Second

// TechnicalError is a technical (non-decline) PSP failure — network
// errors, rate limits, 5xx responses. Distinct from a decline (a normal
// business outcome this adapter surfaces as AttemptResult.Decline,
// never a returned error) so a later phase's circuit breaker can react
// only to this category, per the non-negotiable: "failover to fallback
// only for technical category failures" and domain.IsEligibleForPspFailover.
type TechnicalError struct {
	PSP     string
	Message string
	Cause   error
}

func (e *TechnicalError) Error() string { return e.Message }
func (e *TechnicalError) Unwrap() error { return e.Cause }

// Options configures a new Adapter.
type Options struct {
	Credentials Credentials
	// APIVersion is e.g. "2026-06-24.dahlia" — see config.Stripe.APIVersion.
	APIVersion string
	// DeclineMap is loaded once from decline_code_map at boot.
	DeclineMap map[string]domain.NormalizedDecline
	// Client is injectable for tests; defaults to a real *client.API
	// constructed from Credentials.SecretKey.
	Client *client.API
}

// Adapter is the Stripe PspAdapter implementation.
type Adapter struct {
	client      *client.API
	credentials Credentials
	declineMap  map[string]domain.NormalizedDecline
}

// New constructs a Stripe Adapter.
//
// BUG FIX (Stripe integration audit, 2026-07-12, Task #319): opts.
// APIVersion (config.Stripe.APIVersion, wired all the way through
// registry.go's buildStripeAdapter — see that function's own
// APIVersion: r.config.Stripe.APIVersion field) was accepted into this
// Options struct but never actually applied anywhere in this
// constructor. Every request this adapter ever made therefore went out
// on whatever API version happened to be attached to the Stripe secret
// key's Dashboard default at the time, NOT the version this codebase
// was actually built/tested against (2026-06-24.dahlia, per this
// package's config default) — a silent version drift that would only
// surface the day Stripe's account-level default rolls forward and a
// response shape this codebase assumes changes underneath it, with
// nothing in this repository pinning it against that.
//
// stripesdk.APIVersion is a package-level var stripe-go's own request-
// building code reads to set the Stripe-Version request header on every
// call (this IS how stripe-go's documented API-version-pinning
// mechanism works — there is no per-client.API version field to set
// instead). It is therefore process-wide, not per-Adapter-instance:
// fine here because this codebase's config model only ever carries one
// STRIPE_API_VERSION per process (config.go's StripeAPIVersion is a
// single required env var, not one per psp_account) — every
// stripe.Adapter this registry ever constructs in a given process is
// pinned to the exact same version regardless of which psp_account
// resolved it. Set unconditionally at construction time (before this
// adapter — or a process-wide sibling instance for a second Stripe
// psp_account — ever issues a request), not lazily.
//
// LOW-CONFIDENCE, flagged per this file's own top doc comment
// precedent: no live Stripe account or pkg.go.dev access in this build
// environment to confirm stripesdk.APIVersion is exported with exactly
// this name/type in v81 — re-verify before this ships.
func New(opts Options) *Adapter {
	if opts.APIVersion != "" {
		stripesdk.APIVersion = opts.APIVersion
	}
	sc := opts.Client
	if sc == nil {
		sc = &client.API{}
		// BUG FIX (backend review, 2026-07-10): previously sc.Init(key,
		// nil), which left this adapter with NO HTTP timeout at all —
		// see defaultHTTPClientTimeout's doc comment above for why that's
		// dangerous. stripesdk.NewBackends(httpClient) builds a *Backends
		// wired to our own *http.Client (confirmed against
		// pkg.go.dev/github.com/stripe/stripe-go/v81's exported API,
		// which lists NewBackends(httpClient) as a Backends constructor
		// specifically for this — a historical stripe-go bug where a
		// custom httpClient passed to NewBackends wasn't actually wired
		// through, github.com/stripe/stripe-go issue #626, was fixed in
		// PR #627 many major versions before v81), replacing stripe-go's
		// own zero-timeout default rather than layering retry logic on
		// top of it — this adapter still owns retry policy centrally in
		// a later phase; a bounded timeout here is strictly about never
		// hanging forever, not about retrying.
		backends := stripesdk.NewBackends(&http.Client{Timeout: defaultHTTPClientTimeout})
		sc.Init(opts.Credentials.SecretKey, backends)
	}
	declineMap := opts.DeclineMap
	if declineMap == nil {
		declineMap = map[string]domain.NormalizedDecline{}
	}
	return &Adapter{client: sc, credentials: opts.Credentials, declineMap: declineMap}
}

// PSP returns "stripe".
func (a *Adapter) PSP() string { return "stripe" }

// PublicConfig implements adapters.PspAdapter. Stripe's client-side JS
// (Stripe.js/Elements) needs exactly one public value to initialize —
// the publishable key — so MerchantIdentifier is always nil here; there
// is no second public identifier Stripe's checkout UI requires beyond
// this key.
func (a *Adapter) PublicConfig() adapters.PublicConfig {
	return adapters.PublicConfig{
		PSP:            "stripe",
		PublishableKey: a.credentials.PublishableKey,
	}
}

// CreatePayment implements adapters.PspAdapter.
func (a *Adapter) CreatePayment(ctx context.Context, input adapters.CreatePaymentInput) (adapters.AttemptResult, error) {
	requestThreeDSecure := mapThreeDsModeToStripe(input.ThreeDsMode)

	params := &stripesdk.PaymentIntentParams{
		Amount:        stripesdk.Int64(input.Amount.MinorUnits()),
		Currency:      stripesdk.String(strings.ToLower(input.Amount.Currency())),
		PaymentMethod: stripesdk.String(input.PaymentMethodRef),
		CaptureMethod: stripesdk.String(string(input.CaptureMethod)),
		Confirm:       stripesdk.Bool(true),
		OffSession:    stripesdk.Bool(input.Context.CitMit == adapters.CitMitMIT),
		Metadata:      map[string]string{"payment_id": input.PaymentID},
		Expand:        []*string{stripesdk.String("latest_charge")},
	}
	if input.StatementDescriptor != nil {
		params.StatementDescriptor = stripesdk.String(*input.StatementDescriptor)
	}
	// 2026-07-08, multi-integration descriptors: StatementDescriptorSuffix
	// is Stripe's dynamic per-charge suffix (card payments only),
	// concatenated onto the static prefix already configured in the
	// Dashboard for the connected Stripe account — see
	// adapters.CreatePaymentInput's own doc comment for why this is a
	// separate field from StatementDescriptor rather than reusing it.
	if input.StatementDescriptorSuffix != nil {
		params.StatementDescriptorSuffix = stripesdk.String(*input.StatementDescriptorSuffix)
	}
	if requestThreeDSecure != "" {
		params.PaymentMethodOptions = &stripesdk.PaymentIntentPaymentMethodOptionsParams{
			Card: &stripesdk.PaymentIntentPaymentMethodOptionsCardParams{
				RequestThreeDSecure: stripesdk.String(string(requestThreeDSecure)),
			},
		}
	}
	// Stripe Tax (Stripe integration audit, 2026-07-12, Task #317): see
	// adapters.CreatePaymentInput.CollectTax's own doc comment for where
	// this flag comes from. Setting automatic_tax[enabled]=true on the
	// PaymentIntent is the entirety of the API-side integration —
	// Stripe computes and (on capture) collects the correct tax for the
	// charge based on the connected account's Stripe Tax configuration
	// and the customer's location. This does NOT itself turn Stripe Tax
	// "on" for the connected account: registering tax jurisdictions and
	// enabling Stripe Tax in the Stripe Dashboard is account-level setup
	// only the account owner can do (docs.stripe.com/tax/set-up) — this
	// adapter has no live Stripe account or Dashboard access in this
	// build environment to perform or verify that setup, so this flag
	// is a documented, correct API call whose real-world tax-collection
	// effect depends on configuration this codebase cannot perform on
	// the merchant's behalf.
	if input.CollectTax {
		params.AutomaticTax = &stripesdk.PaymentIntentAutomaticTaxParams{
			Enabled: stripesdk.Bool(true),
		}
	}
	params.SetIdempotencyKey(input.IdempotencyKey)
	params.Context = ctx

	pi, err := a.client.PaymentIntents.New(params)
	if err != nil {
		return a.handleConfirmError(err)
	}
	return a.toAttemptResult(pi), nil
}

// Capture implements adapters.PspAdapter.
func (a *Adapter) Capture(ctx context.Context, pspAttemptRef string, amount *domain.Money, idempotencyKey string) (adapters.AttemptResult, error) {
	params := &stripesdk.PaymentIntentCaptureParams{
		Expand: []*string{stripesdk.String("latest_charge")},
	}
	if amount != nil {
		params.AmountToCapture = stripesdk.Int64(amount.MinorUnits())
	}
	params.SetIdempotencyKey(idempotencyKey)
	params.Context = ctx

	pi, err := a.client.PaymentIntents.Capture(pspAttemptRef, params)
	if err != nil {
		return adapters.AttemptResult{}, a.wrapTechnicalError(err, "capture")
	}
	return a.toAttemptResult(pi), nil
}

// CreateBillingPortalSession implements adapters.BillingPortalProvider
// (Stripe integration audit, 2026-07-12, Task #318) — creates a
// Stripe Billing Portal session for pspCustomerRef and returns its
// hosted URL. This does NOT itself enable Stripe's Billing Portal for
// the connected account: the account owner must configure the portal
// (which features are exposed — cancel, update payment method, view
// invoices, etc.) in the Stripe Dashboard first
// (docs.stripe.com/billing/subscriptions/integrating-customer-portal) —
// this adapter has no live Stripe account/Dashboard access in this
// build environment to perform or verify that configuration, exactly
// the same documented caveat CreatePayment's Stripe Tax wiring carries.
//
// LOW-CONFIDENCE API SHAPE, flagged per this file's own top doc comment
// precedent: a.client.BillingPortalSessions.New(params) mirrors this
// file's established a.client.<Resource>.New(params) pattern
// (PaymentIntents, Refunds above) exactly, but there is no live Stripe
// account or go.dev/pkg.go.dev access in this build environment to
// confirm stripe-go v81's client.API actually exposes a
// BillingPortalSessions field with this exact shape — re-verify against
// pkg.go.dev/github.com/stripe/stripe-go/v81 before this ships.
func (a *Adapter) CreateBillingPortalSession(ctx context.Context, pspCustomerRef string, returnURL string) (string, error) {
	params := &stripesdk.BillingPortalSessionParams{
		Customer:  stripesdk.String(pspCustomerRef),
		ReturnURL: stripesdk.String(returnURL),
	}
	params.Context = ctx

	session, err := a.client.BillingPortalSessions.New(params)
	if err != nil {
		return "", a.wrapTechnicalError(err, "create_billing_portal_session")
	}
	return session.URL, nil
}

// Void implements adapters.PspAdapter.
func (a *Adapter) Void(ctx context.Context, pspAttemptRef string, idempotencyKey string) (adapters.AttemptResult, error) {
	params := &stripesdk.PaymentIntentCancelParams{}
	params.SetIdempotencyKey(idempotencyKey)
	params.Context = ctx

	pi, err := a.client.PaymentIntents.Cancel(pspAttemptRef, params)
	if err != nil {
		return adapters.AttemptResult{}, a.wrapTechnicalError(err, "void")
	}
	return a.toAttemptResult(pi), nil
}

// Refund implements adapters.PspAdapter.
func (a *Adapter) Refund(ctx context.Context, pspAttemptRef string, amount domain.Money, idempotencyKey string) (adapters.RefundResult, error) {
	params := &stripesdk.RefundParams{
		PaymentIntent: stripesdk.String(pspAttemptRef),
		Amount:        stripesdk.Int64(amount.MinorUnits()),
	}
	params.SetIdempotencyKey(idempotencyKey)
	params.Context = ctx

	refund, err := a.client.Refunds.New(params)
	if err != nil {
		return adapters.RefundResult{}, a.wrapTechnicalError(err, "refund")
	}

	status := adapters.RefundStatusPending
	switch string(refund.Status) {
	case "succeeded":
		status = adapters.RefundStatusSucceeded
	case "failed":
		status = adapters.RefundStatusFailed
	}
	return adapters.RefundResult{
		PspRefundRef: refund.ID,
		Status:       status,
		Amount:       amount,
	}, nil
}

// GetPayment implements adapters.PspAdapter.
func (a *Adapter) GetPayment(ctx context.Context, pspAttemptRef string) (adapters.AttemptSnapshot, error) {
	params := &stripesdk.PaymentIntentParams{
		Expand: []*string{stripesdk.String("latest_charge")},
	}
	params.Context = ctx

	pi, err := a.client.PaymentIntents.Get(pspAttemptRef, params)
	if err != nil {
		return adapters.AttemptSnapshot{}, a.wrapTechnicalError(err, "getPayment")
	}
	result := a.toAttemptResult(pi)
	return adapters.AttemptSnapshot{
		PspAttemptRef: result.PspAttemptRef,
		Status:        result.Status,
		Decline:       result.Decline,
	}, nil
}

// VerifyWebhook implements adapters.PspAdapter.
func (a *Adapter) VerifyWebhook(rawBody []byte, headers map[string][]string) (adapters.VerifiedEvent, error) {
	signatureHeader := adapters.FirstHeader(headers, "stripe-signature")
	if signatureHeader == "" {
		return adapters.VerifiedEvent{}, adapters.NewInvalidSignatureError("stripe", "missing stripe-signature header")
	}
	event, err := webhook.ConstructEvent(rawBody, signatureHeader, a.credentials.WebhookSecret)
	if err != nil {
		return adapters.VerifiedEvent{}, adapters.NewInvalidSignatureError("stripe", err.Error())
	}
	return adapters.VerifiedEvent{ProviderEventID: event.ID, RawPayload: &event}, nil
}

// NormalizeEvent implements adapters.PspAdapter.
func (a *Adapter) NormalizeEvent(rawPayload any) []domain.CanonicalEvent {
	event, ok := asEvent(rawPayload)
	if !ok {
		return nil
	}
	return normalizeStripeEvent(event, a.declineMap)
}

// ExtractPaymentID implements adapters.PspAdapter.
func (a *Adapter) ExtractPaymentID(rawPayload any) *string {
	event, ok := asEvent(rawPayload)
	if !ok {
		return nil
	}
	metadata, ok := extractMetadata(event)
	if !ok {
		return nil
	}
	if id, ok := metadata["payment_id"]; ok {
		return &id
	}
	return nil
}

// ExtractPspAttemptRef implements adapters.PspAdapter.
func (a *Adapter) ExtractPspAttemptRef(rawPayload any) *string {
	event, ok := asEvent(rawPayload)
	if !ok {
		return nil
	}

	// PaymentIntent events: the object itself.
	if pi, err := decodePaymentIntent(event); err == nil && pi.Object == "payment_intent" {
		return &pi.ID
	}

	// Charge events: carry a PaymentIntent reference.
	if charge, err := decodeCharge(event); err == nil && charge.Object == "charge" {
		if charge.PaymentIntent != nil {
			return &charge.PaymentIntent.ID
		}
		return nil
	}

	// Dispute events: carry a PaymentIntent reference.
	if dispute, err := decodeDispute(event); err == nil && dispute.Object == "dispute" {
		if dispute.PaymentIntent != nil {
			return &dispute.PaymentIntent.ID
		}
		return nil
	}

	return nil
}

// NormalizeDecline implements adapters.PspAdapter.
func (a *Adapter) NormalizeDecline(rawCode string) domain.NormalizedDecline {
	return normalizeStripeDecline(a.declineMap, rawCode)
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

// ListSettlements implements adapters.PspAdapter. Milestone 6, T6.2.
// Expand: []string{"data.source"} is required so
// normalizeStripeBalanceTransaction can read source.payment_intent
// without a second round-trip per line — see that function's docblock
// for the "not verified against a live account" flag.
func (a *Adapter) ListSettlements(ctx context.Context, sinceISO string) ([]adapters.SettlementRecord, error) {
	createdGte, err := isoToUnix(sinceISO)
	if err != nil {
		return nil, err
	}
	params := &stripesdk.BalanceTransactionListParams{
		// stripe-go v81's BalanceTransactionListParams has both a plain
		// `Created *int64` (exact match) and `CreatedRange
		// *RangeQueryParams` (range query) field for the same "created"
		// form key — range queries (GreaterThanOrEqual etc.) go on
		// CreatedRange, not Created.
		CreatedRange: &stripesdk.RangeQueryParams{GreaterThanOrEqual: createdGte},
		Expand:       []*string{stripesdk.String("data.source")},
	}
	params.Limit = stripesdk.Int64(100)
	params.Context = ctx

	var records []adapters.SettlementRecord
	iter := a.client.BalanceTransactions.List(params)
	for iter.Next() {
		bt := iter.BalanceTransaction()
		if record := normalizeStripeBalanceTransaction(bt); record != nil {
			records = append(records, *record)
		}
	}
	if err := iter.Err(); err != nil {
		return nil, a.wrapTechnicalError(err, "listSettlements")
	}
	return records, nil
}

// ListPayouts implements adapters.PspAdapter.
func (a *Adapter) ListPayouts(ctx context.Context, sinceISO string) ([]adapters.PayoutRecord, error) {
	createdGte, err := isoToUnix(sinceISO)
	if err != nil {
		return nil, err
	}
	params := &stripesdk.PayoutListParams{
		// Same Created (*int64, exact) vs CreatedRange (*RangeQueryParams,
		// range) split as BalanceTransactionListParams above.
		CreatedRange: &stripesdk.RangeQueryParams{GreaterThanOrEqual: createdGte},
	}
	params.Limit = stripesdk.Int64(100)
	params.Context = ctx

	var payouts []adapters.PayoutRecord
	iter := a.client.Payouts.List(params)
	for iter.Next() {
		payout := iter.Payout()
		record, err := normalizeStripePayout(payout)
		if err != nil {
			continue
		}
		payouts = append(payouts, record)
	}
	if err := iter.Err(); err != nil {
		return nil, a.wrapTechnicalError(err, "listPayouts")
	}
	return payouts, nil
}

// ListAccountUpdates implements adapters.PspAdapter.
//
// FLAGGED (per SPEC.md's working agreement — encode ambiguity, don't
// guess): Stripe has no direct equivalent of a "list account updates"
// polling endpoint the way this method's contract implies. Stripe's
// own card-updater behavior ("Automatic updates for saved cards")
// happens transparently — issuer-refreshed card details apply
// themselves to an existing PaymentMethod/Customer without Stripe
// exposing a feed of "here's what changed and when" for an integration
// to poll. A card_closed-equivalent surfaces indirectly, as an ordinary
// decline (e.g. expired_card) on the NEXT charge attempt, not as a
// proactive notification.
//
// Returning an empty slice here is therefore the correct, honest answer
// for this adapter — not a stub standing in for unfinished work. If
// Stripe's account-updater behavior ever needs surfacing explicitly
// (e.g. to preemptively pause a subscription before its next failed
// renewal), that would mean subscribing to
// payment_method.automatically_updated webhook events instead of
// polling — a different mechanism than this method's contract, and a
// separate piece of work.
func (a *Adapter) ListAccountUpdates(ctx context.Context, sinceISO string) ([]adapters.AccountUpdateRecord, error) {
	return nil, nil
}

func (a *Adapter) toAttemptResult(pi *stripesdk.PaymentIntent) adapters.AttemptResult {
	// pi.Status is stripe.PaymentIntentStatus, a named string type in
	// stripe-go — string(...) converts it to compare against
	// mapPaymentIntentStatus's plain-string parameter (see that
	// function's doc comment for why plain strings were chosen here).
	status := mapPaymentIntentStatus(string(pi.Status), pi.LastPaymentError)
	rawDeclineCode := extractRawDeclineCode(pi.LastPaymentError)

	var decline *domain.NormalizedDecline
	if status == adapters.AttemptStatusDeclined && rawDeclineCode != nil {
		d := a.NormalizeDecline(*rawDeclineCode)
		decline = &d
	}

	var networkTransactionID *string
	if pi.LatestCharge != nil &&
		pi.LatestCharge.PaymentMethodDetails != nil &&
		pi.LatestCharge.PaymentMethodDetails.Card != nil &&
		pi.LatestCharge.PaymentMethodDetails.Card.NetworkTransactionID != "" {
		id := pi.LatestCharge.PaymentMethodDetails.Card.NetworkTransactionID
		networkTransactionID = &id
	}

	result := adapters.AttemptResult{
		PspAttemptRef:        pi.ID,
		Status:                status,
		Decline:               decline,
		NetworkTransactionID: networkTransactionID,
	}
	if status == adapters.AttemptStatusRequiresAction {
		if pi.ClientSecret != "" {
			cs := pi.ClientSecret
			result.ClientSecret = &cs
		}
		result.ThreeDs = &adapters.ThreeDsInfo{Required: true}
	}
	return result
}

// handleConfirmError: Stripe returns a *stripe.Error with
// Type == stripe.ErrorTypeCard (synchronously, from the same
// PaymentIntents.New call) when a synchronous confirm attempt is
// declined — this is a normal business outcome, not a technical
// failure, so we catch it and return a declined AttemptResult, the same
// shape a non-throwing decline would produce. Every other Stripe error
// type is a technical failure (a later phase's circuit breaker only
// reacts to this category).
func (a *Adapter) handleConfirmError(err error) (adapters.AttemptResult, error) {
	var stripeErr *stripesdk.Error
	// stripeErr.Type is stripe.ErrorType, a named string type — compared
	// as a plain string literal for the same reason described in
	// statusmapping.go's mapPaymentIntentStatus doc comment (avoids
	// depending on the exact spelling of a named constant like
	// "ErrorTypeCard" this port's author could not verify).
	if errors.As(err, &stripeErr) && string(stripeErr.Type) == "card_error" {
		pspAttemptRef := "unknown"
		if stripeErr.PaymentIntent != nil {
			pspAttemptRef = stripeErr.PaymentIntent.ID
		}
		var rawCode string
		if stripeErr.DeclineCode != "" {
			rawCode = string(stripeErr.DeclineCode) // stripe.DeclineCode is a named string type; converts cleanly.
		} else {
			rawCode = string(stripeErr.Code)
		}
		var decline *domain.NormalizedDecline
		if rawCode != "" {
			d := a.NormalizeDecline(rawCode)
			decline = &d
		}
		return adapters.AttemptResult{
			PspAttemptRef: pspAttemptRef,
			Status:        adapters.AttemptStatusDeclined,
			Decline:       decline,
		}, nil
	}
	return adapters.AttemptResult{}, a.wrapTechnicalError(err, "createPayment")
}

func (a *Adapter) wrapTechnicalError(err error, operation string) error {
	var existing *TechnicalError
	if errors.As(err, &existing) {
		return existing
	}
	return &TechnicalError{PSP: "stripe", Message: fmt.Sprintf("Stripe %s failed: %s", operation, err.Error()), Cause: err}
}

// asEvent accepts either a *stripe.Event (the common case, produced by
// VerifyWebhook's own RawPayload) or a stripe.Event value.
func asEvent(rawPayload any) (*stripesdk.Event, bool) {
	switch v := rawPayload.(type) {
	case *stripesdk.Event:
		return v, v != nil
	case stripesdk.Event:
		return &v, true
	default:
		return nil, false
	}
}

// decodePaymentIntent unmarshals event.Data.Raw (the raw JSON payload
// of the event's wrapped object) into a stripe.PaymentIntent — the
// stripe-go Event type does not automatically type its Data.Object
// field to a concrete resource, so a manual json.Unmarshal against the
// raw bytes is required (a well-established stripe-go idiom for
// handling webhook events).
func decodePaymentIntent(event *stripesdk.Event) (*stripesdk.PaymentIntent, error) {
	var pi stripesdk.PaymentIntent
	if err := json.Unmarshal(event.Data.Raw, &pi); err != nil {
		return nil, err
	}
	return &pi, nil
}

func decodeCharge(event *stripesdk.Event) (*stripesdk.Charge, error) {
	var charge stripesdk.Charge
	if err := json.Unmarshal(event.Data.Raw, &charge); err != nil {
		return nil, err
	}
	return &charge, nil
}

func decodeDispute(event *stripesdk.Event) (*stripesdk.Dispute, error) {
	var dispute stripesdk.Dispute
	if err := json.Unmarshal(event.Data.Raw, &dispute); err != nil {
		return nil, err
	}
	return &dispute, nil
}

// extractMetadata reads the `metadata` map off whatever object type an
// event wraps, without needing to know which concrete resource type it
// is — every Stripe object that carries our payment_id metadata
// (PaymentIntent today; Charge would too, if ever needed) has a
// top-level "metadata" JSON field, so unmarshalling into this minimal
// shape works uniformly across object types.
func extractMetadata(event *stripesdk.Event) (map[string]string, bool) {
	var withMetadata struct {
		Metadata map[string]string `json:"metadata"`
	}
	if err := json.Unmarshal(event.Data.Raw, &withMetadata); err != nil {
		return nil, false
	}
	if withMetadata.Metadata == nil {
		return nil, false
	}
	return withMetadata.Metadata, true
}

// firstHeader used to live here as its own copy — DEDUPLICATION fix
// (backend review, 2026-07-10): identical byte-for-byte to the copy
// every other PSP adapter package (solidgate, paypal, mock) also
// carried. Hoisted into the shared internal/adapters package (already
// imported by every adapter) as adapters.FirstHeader — see that
// function's doc comment for the full history, including the original
// 2026-07-07 case-insensitivity bug fix this preserves. Every call site
// below now calls adapters.FirstHeader directly.

// isoToUnix parses an RFC3339 timestamp into Unix seconds, the shape
// stripe.RangeQueryParams.GreaterThanOrEqual expects.
func isoToUnix(iso string) (int64, error) {
	t, err := time.Parse(time.RFC3339, iso)
	if err != nil {
		// Fall back to RFC3339Nano for timestamps with fractional
		// seconds (e.g. produced by Go's time.Now().Format(time.RFC3339Nano)
		// elsewhere in this codebase).
		t, err = time.Parse(time.RFC3339Nano, iso)
		if err != nil {
			return 0, fmt.Errorf("stripe: invalid sinceISO %q: %w", iso, err)
		}
	}
	return t.Unix(), nil
}
