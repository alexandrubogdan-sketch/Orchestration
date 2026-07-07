// Package mock provides a deterministic fake PSP (T2.2). Scriptable
// outcomes by magic amount — every integration test in this codebase
// that needs "a PSP" without a network dependency uses this adapter,
// not a mocking library, per SPEC.md's framing of adapters/mock as a
// first-class implementation of PspAdapter, not a test double.
//
// Magic amounts (minor units), per SPEC.md T2.2:
//   - 4000 -> declined, insufficient_funds (soft — retryable)
//   - 4001 -> declined, stolen_card (hard — never retryable; added in
//     Milestone 8 so subscription/dunning tests can deterministically
//     exercise "hard decline cancels outright" without a live PSP)
//   - 5000 -> requires_action (3DS challenge)
//   - 9000 -> "timeout-after-success": the PSP call returns an error
//     (simulating a dropped/lost response) but the attempt is recorded
//     as succeeded on the "PSP side" — retrying with the SAME
//     idempotencyKey must return that already-successful attempt, not
//     create a second one. This is exactly the scenario T2.6's
//     failure-injection test exercises.
//   - anything else -> authorized (or captured, if captureMethod is
//     "automatic")
package mock

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/alphapayments/payment-orchestrator/internal/adapters"
	"github.com/alphapayments/payment-orchestrator/internal/domain"
)

// randomID returns a random hex string, standing in for the TS
// adapter's randomUUID() — this package doesn't need real UUID format,
// just a unique-enough opaque string for a fake PSP reference.
func randomID() string {
	buf := make([]byte, 16)
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}

// storedAttempt is the mock PSP's in-memory record of one attempt.
type storedAttempt struct {
	pspAttemptRef        string
	status               adapters.CanonicalAttemptStatus
	amount               domain.Money
	paymentID            string
	context              adapters.AttemptContext
	decline              *domain.NormalizedDecline
	networkTransactionID *string
	// settledAt: Milestone 6 — when this attempt most recently settled
	// (captured/refunded), for ListSettlements.
	settledAt *string
	// settledAmount: the amount actually settled (may differ from
	// amount for a partial refund).
	settledAmount *domain.Money
}

// 29/1000 (= 2.9%) expressed as integer basis points rather than a
// float literal, mirroring the TS source's own comment about banning
// <integer> * <float literal> in money paths — even this fully
// synthetic mock fee goes through integer-only arithmetic.
const mockFeeBasisPoints = 290
const mockFeeFixedMinorUnits = 30

// mockFee computes a flat 2.9% + 30 cents fee — deterministic, not
// meant to model any real PSP's actual pricing.
func mockFee(amount domain.Money) domain.Money {
	// Matches TS's Math.round((amount.minorUnits * MOCK_FEE_BASIS_POINTS) / 10_000)
	// using only integer arithmetic — see roundDiv.
	feeMinorUnits := roundDiv(amount.MinorUnits()*mockFeeBasisPoints, 10_000) + mockFeeFixedMinorUnits
	if feeMinorUnits > amount.MinorUnits() {
		feeMinorUnits = amount.MinorUnits()
	}
	m, err := domain.MakeMoney(feeMinorUnits, amount.Currency())
	if err != nil {
		// mockFee is only ever called with an already-valid Money value
		// (a settled attempt's amount), so feeMinorUnits is always
		// within [0, amount.MinorUnits()] and the currency is already
		// valid — this branch is unreachable in practice.
		panic(fmt.Sprintf("mock: mockFee produced an invalid Money: %v", err))
	}
	return m
}

// roundDiv performs Math.round(numerator / denominator) using only
// integer arithmetic (numerator, denominator both non-negative here).
func roundDiv(numerator, denominator int64) int64 {
	return (numerator + denominator/2) / denominator
}

// WebhookEnvelope is the mock PSP's webhook payload shape.
type WebhookEnvelope struct {
	ProviderEventID string                    `json:"providerEventId"`
	Type            string                    `json:"type"`
	PspAttemptRef   string                    `json:"pspAttemptRef"`
	PaymentID       string                    `json:"paymentId"`
	Decline         *domain.NormalizedDecline `json:"decline,omitempty"`
}

// declineJSON/decline (un)marshalling: NormalizedDecline's Description
// field is a *string and Category/RetryClass are typed strings, all of
// which marshal fine via encoding/json's default struct tags... but
// NormalizedDecline as defined in internal/domain has no json tags at
// all (it was never meant to cross a wire boundary in Phase 1). Rather
// than add json tags to the domain package (a cross-package layering
// change out of scope for this phase), this package defines its own
// wire-shape mirror and converts explicitly. See toWireDecline/
// fromWireDecline below.
type wireDecline struct {
	PSP            string  `json:"psp"`
	RawCode        string  `json:"rawCode"`
	NormalizedCode string  `json:"normalizedCode"`
	Category       string  `json:"category"`
	RetryClass     string  `json:"retryClass"`
	Description    *string `json:"description,omitempty"`
}

func toWireDecline(d *domain.NormalizedDecline) *wireDecline {
	if d == nil {
		return nil
	}
	return &wireDecline{
		PSP:            d.PSP,
		RawCode:        d.RawCode,
		NormalizedCode: d.NormalizedCode,
		Category:       string(d.Category),
		RetryClass:     string(d.RetryClass),
		Description:    d.Description,
	}
}

func fromWireDecline(w *wireDecline) *domain.NormalizedDecline {
	if w == nil {
		return nil
	}
	return &domain.NormalizedDecline{
		PSP:            w.PSP,
		RawCode:        w.RawCode,
		NormalizedCode: w.NormalizedCode,
		Category:       domain.DeclineCategory(w.Category),
		RetryClass:     domain.DeclineRetryClass(w.RetryClass),
		Description:    w.Description,
	}
}

// wireEnvelope is the actual JSON wire shape sent/received by
// VerifyWebhook — WebhookEnvelope above is the internal representation
// used by DrainWebhooks() (test helper); wireEnvelope substitutes
// wireDecline for domain.NormalizedDecline so json.Marshal/Unmarshal
// work without needing json tags on the domain package.
type wireEnvelope struct {
	ProviderEventID string       `json:"providerEventId"`
	Type            string       `json:"type"`
	PspAttemptRef   string       `json:"pspAttemptRef"`
	PaymentID       string       `json:"paymentId"`
	Decline         *wireDecline `json:"decline,omitempty"`
}

func (e WebhookEnvelope) toWire() wireEnvelope {
	return wireEnvelope{
		ProviderEventID: e.ProviderEventID,
		Type:            e.Type,
		PspAttemptRef:   e.PspAttemptRef,
		PaymentID:       e.PaymentID,
		Decline:         toWireDecline(e.Decline),
	}
}

func (w wireEnvelope) toEnvelope() WebhookEnvelope {
	return WebhookEnvelope{
		ProviderEventID: w.ProviderEventID,
		Type:            w.Type,
		PspAttemptRef:   w.PspAttemptRef,
		PaymentID:       w.PaymentID,
		Decline:         fromWireDecline(w.Decline),
	}
}

const (
	webhookTypeAuthorized = "payment.authorized"
	webhookTypeDeclined   = "payment.declined"
	webhookTypeCaptured   = "payment.captured"
	webhookTypeRefunded   = "payment.refunded"
)

var mockDeclineMap = map[string]domain.NormalizedDecline{
	"insufficient_funds": {
		PSP:            "mock",
		RawCode:        "insufficient_funds",
		NormalizedCode: "insufficient_funds",
		Category:       domain.DeclineCategorySoft,
		RetryClass:     domain.RetryClassSameInstrumentLater,
	},
	// Milestone 8: a HARD decline magic amount, distinct from 4000's
	// soft one — needed so tests of "hard declines cancel a
	// subscription outright instead of dunning" (T8.1/T8.2) have a
	// deterministic way to produce one without a live PSP.
	"stolen_card": {
		PSP:            "mock",
		RawCode:        "stolen_card",
		NormalizedCode: "stolen_card",
		Category:       domain.DeclineCategoryHard,
		RetryClass:     domain.RetryClassNever,
	},
}

// TimeoutError is returned by CreatePayment for the 9000-minor-units
// magic amount — see package doc.
type TimeoutError struct {
	IdempotencyKey string
}

func (e *TimeoutError) Error() string {
	return fmt.Sprintf("mock: simulated timeout after success for idempotencyKey=%s", e.IdempotencyKey)
}

// Adapter is the mock PspAdapter implementation.
type Adapter struct {
	signingSecret string

	mu                      sync.Mutex
	attemptsByRef           map[string]*storedAttempt
	attemptsByIdempotencyKey map[string]*storedAttempt
	webhookOutbox           []WebhookEnvelope
	scheduledAccountUpdates []scheduledAccountUpdate
}

type scheduledAccountUpdate struct {
	update      adapters.AccountUpdateRecord
	scheduledAt string
}

// Options configures a new Adapter.
type Options struct {
	SigningSecret string
}

// New constructs a mock Adapter. If opts.SigningSecret is empty, it
// defaults to "mock-webhook-secret" (matching the TS adapter's default).
func New(opts Options) *Adapter {
	signingSecret := opts.SigningSecret
	if signingSecret == "" {
		signingSecret = "mock-webhook-secret"
	}
	return &Adapter{
		signingSecret:            signingSecret,
		attemptsByRef:            make(map[string]*storedAttempt),
		attemptsByIdempotencyKey: make(map[string]*storedAttempt),
	}
}

// PSP returns "mock".
func (a *Adapter) PSP() string { return "mock" }

// PublicConfig implements adapters.PspAdapter — a deterministic fake
// publishable key, matching this package's whole reason for existing
// (T2.2: a first-class fake PSP, not a mocking-library stand-in).
// MerchantIdentifier is left nil; nothing about the mock adapter's
// (nonexistent) client-side widget needs a second identifier.
func (a *Adapter) PublicConfig() adapters.PublicConfig {
	return adapters.PublicConfig{
		PSP:            "mock",
		PublishableKey: "pk_mock_test",
	}
}

// DrainWebhooks is a test/integration helper — simulates the pipeline
// draining pending webhooks.
func (a *Adapter) DrainWebhooks() []WebhookEnvelope {
	a.mu.Lock()
	defer a.mu.Unlock()
	drained := a.webhookOutbox
	a.webhookOutbox = nil
	return drained
}

func (a *Adapter) enqueueWebhook(envelope WebhookEnvelope) {
	envelope.ProviderEventID = randomID()
	a.webhookOutbox = append(a.webhookOutbox, envelope)
}

// CreatePayment implements adapters.PspAdapter.
func (a *Adapter) CreatePayment(ctx context.Context, input adapters.CreatePaymentInput) (adapters.AttemptResult, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if existing, ok := a.attemptsByIdempotencyKey[input.IdempotencyKey]; ok {
		// Real PSP idempotency behavior: replaying the same key returns
		// the original result, never a new attempt.
		return toAttemptResult(existing), nil
	}

	pspAttemptRef := "mock_pi_" + randomID()
	minorUnits := input.Amount.MinorUnits()

	switch minorUnits {
	case 4000:
		decline := mockDeclineMap["insufficient_funds"]
		stored := &storedAttempt{
			pspAttemptRef: pspAttemptRef,
			status:        adapters.AttemptStatusDeclined,
			amount:        input.Amount,
			paymentID:     input.PaymentID,
			context:       input.Context,
			decline:       &decline,
		}
		a.store(input.IdempotencyKey, stored)
		a.enqueueWebhook(WebhookEnvelope{
			Type:          webhookTypeDeclined,
			PspAttemptRef: pspAttemptRef,
			PaymentID:     input.PaymentID,
			Decline:       &decline,
		})
		return toAttemptResult(stored), nil

	case 4001:
		decline := mockDeclineMap["stolen_card"]
		stored := &storedAttempt{
			pspAttemptRef: pspAttemptRef,
			status:        adapters.AttemptStatusDeclined,
			amount:        input.Amount,
			paymentID:     input.PaymentID,
			context:       input.Context,
			decline:       &decline,
		}
		a.store(input.IdempotencyKey, stored)
		a.enqueueWebhook(WebhookEnvelope{
			Type:          webhookTypeDeclined,
			PspAttemptRef: pspAttemptRef,
			PaymentID:     input.PaymentID,
			Decline:       &decline,
		})
		return toAttemptResult(stored), nil

	case 5000:
		stored := &storedAttempt{
			pspAttemptRef: pspAttemptRef,
			status:        adapters.AttemptStatusRequiresAction,
			amount:        input.Amount,
			paymentID:     input.PaymentID,
			context:       input.Context,
		}
		a.store(input.IdempotencyKey, stored)
		result := toAttemptResult(stored)
		clientSecret := pspAttemptRef + "_secret_" + randomID()
		result.ClientSecret = &clientSecret
		result.ThreeDs = &adapters.ThreeDsInfo{Required: true}
		return result, nil

	case 9000:
		// Record success "on the PSP side" — and enqueue the webhook a
		// real PSP would still send, since webhooks are delivered over
		// an independent channel from the synchronous API response —
		// before returning an error to simulate that synchronous
		// response getting lost.
		status := adapters.AttemptStatusAuthorized
		if input.CaptureMethod == adapters.CaptureMethodAutomatic {
			status = adapters.AttemptStatusCaptured
		}
		var networkTransactionID *string
		if input.Context.CitMit == adapters.CitMitCIT {
			id := "ntx_" + randomID()
			networkTransactionID = &id
		} else {
			networkTransactionID = input.Context.NetworkTransactionID
		}
		var settledAt *string
		var settledAmount *domain.Money
		if status == adapters.AttemptStatusCaptured {
			now := time.Now().UTC().Format(time.RFC3339Nano)
			settledAt = &now
			amt := input.Amount
			settledAmount = &amt
		}
		stored := &storedAttempt{
			pspAttemptRef:        pspAttemptRef,
			status:               status,
			amount:               input.Amount,
			paymentID:            input.PaymentID,
			context:              input.Context,
			networkTransactionID: networkTransactionID,
			settledAt:            settledAt,
			settledAmount:        settledAmount,
		}
		a.store(input.IdempotencyKey, stored)
		webhookType := webhookTypeAuthorized
		if status == adapters.AttemptStatusCaptured {
			webhookType = webhookTypeCaptured
		}
		a.enqueueWebhook(WebhookEnvelope{
			Type:          webhookType,
			PspAttemptRef: pspAttemptRef,
			PaymentID:     input.PaymentID,
		})
		return adapters.AttemptResult{}, &TimeoutError{IdempotencyKey: input.IdempotencyKey}

	default:
		status := adapters.AttemptStatusAuthorized
		if input.CaptureMethod == adapters.CaptureMethodAutomatic {
			status = adapters.AttemptStatusCaptured
		}
		var networkTransactionID *string
		if input.Context.CitMit == adapters.CitMitCIT {
			id := "ntx_" + randomID()
			networkTransactionID = &id
		} else {
			networkTransactionID = input.Context.NetworkTransactionID
		}
		var settledAt *string
		var settledAmount *domain.Money
		if status == adapters.AttemptStatusCaptured {
			now := time.Now().UTC().Format(time.RFC3339Nano)
			settledAt = &now
			amt := input.Amount
			settledAmount = &amt
		}
		stored := &storedAttempt{
			pspAttemptRef:        pspAttemptRef,
			status:               status,
			amount:               input.Amount,
			paymentID:            input.PaymentID,
			context:              input.Context,
			networkTransactionID: networkTransactionID,
			settledAt:            settledAt,
			settledAmount:        settledAmount,
		}
		a.store(input.IdempotencyKey, stored)
		webhookType := webhookTypeAuthorized
		if status == adapters.AttemptStatusCaptured {
			webhookType = webhookTypeCaptured
		}
		a.enqueueWebhook(WebhookEnvelope{
			Type:          webhookType,
			PspAttemptRef: pspAttemptRef,
			PaymentID:     input.PaymentID,
		})
		return toAttemptResult(stored), nil
	}
}

// Capture implements adapters.PspAdapter.
func (a *Adapter) Capture(ctx context.Context, pspAttemptRef string, amount *domain.Money, _ string) (adapters.AttemptResult, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	stored, err := a.requireAttempt(pspAttemptRef)
	if err != nil {
		return adapters.AttemptResult{}, err
	}
	stored.status = adapters.AttemptStatusCaptured
	if amount != nil {
		stored.amount = *amount
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	stored.settledAt = &now
	if amount != nil {
		stored.settledAmount = amount
	} else {
		amt := stored.amount
		stored.settledAmount = &amt
	}
	a.enqueueWebhook(WebhookEnvelope{Type: webhookTypeCaptured, PspAttemptRef: pspAttemptRef, PaymentID: stored.paymentID})
	return toAttemptResult(stored), nil
}

// Void implements adapters.PspAdapter.
func (a *Adapter) Void(ctx context.Context, pspAttemptRef string, _ string) (adapters.AttemptResult, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	stored, err := a.requireAttempt(pspAttemptRef)
	if err != nil {
		return adapters.AttemptResult{}, err
	}
	stored.status = adapters.AttemptStatusVoided
	return toAttemptResult(stored), nil
}

// Refund implements adapters.PspAdapter.
func (a *Adapter) Refund(ctx context.Context, pspAttemptRef string, amount domain.Money, _ string) (adapters.RefundResult, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	stored, err := a.requireAttempt(pspAttemptRef)
	if err != nil {
		return adapters.RefundResult{}, err
	}
	stored.status = adapters.AttemptStatusRefunded
	now := time.Now().UTC().Format(time.RFC3339Nano)
	stored.settledAt = &now
	amt := amount
	stored.settledAmount = &amt
	a.enqueueWebhook(WebhookEnvelope{Type: webhookTypeRefunded, PspAttemptRef: pspAttemptRef, PaymentID: stored.paymentID})
	return adapters.RefundResult{
		PspRefundRef: "mock_re_" + randomID(),
		Status:       adapters.RefundStatusSucceeded,
		Amount:       amount,
	}, nil
}

// GetPayment implements adapters.PspAdapter.
func (a *Adapter) GetPayment(ctx context.Context, pspAttemptRef string) (adapters.AttemptSnapshot, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	stored, err := a.requireAttempt(pspAttemptRef)
	if err != nil {
		return adapters.AttemptSnapshot{}, err
	}
	return adapters.AttemptSnapshot{
		PspAttemptRef: stored.pspAttemptRef,
		Status:        stored.status,
		Decline:       stored.decline,
	}, nil
}

// VerifyWebhook implements adapters.PspAdapter.
func (a *Adapter) VerifyWebhook(rawBody []byte, headers map[string][]string) (adapters.VerifiedEvent, error) {
	provided := firstHeader(headers, "x-mock-signature")
	if provided != a.signingSecret {
		return adapters.VerifiedEvent{}, adapters.NewInvalidSignatureError("mock", "x-mock-signature header did not match")
	}
	var wire wireEnvelope
	if err := json.Unmarshal(rawBody, &wire); err != nil {
		return adapters.VerifiedEvent{}, adapters.NewInvalidSignatureError("mock", "invalid JSON body: "+err.Error())
	}
	envelope := wire.toEnvelope()
	return adapters.VerifiedEvent{ProviderEventID: envelope.ProviderEventID, RawPayload: envelope}, nil
}

// NormalizeEvent implements adapters.PspAdapter.
func (a *Adapter) NormalizeEvent(rawPayload any) []domain.CanonicalEvent {
	envelope, ok := asEnvelope(rawPayload)
	if !ok {
		return nil
	}
	switch envelope.Type {
	case webhookTypeAuthorized:
		return []domain.CanonicalEvent{{Type: domain.EventAuthorized}}
	case webhookTypeDeclined:
		var code *string
		if envelope.Decline != nil {
			c := envelope.Decline.NormalizedCode
			code = &c
		}
		return []domain.CanonicalEvent{{Type: domain.EventDeclined, DeclineCode: code}}
	case webhookTypeCaptured:
		return []domain.CanonicalEvent{{Type: domain.EventCaptured}}
	case webhookTypeRefunded:
		return []domain.CanonicalEvent{{Type: domain.EventRefunded}}
	default:
		return nil
	}
}

// ExtractPaymentID implements adapters.PspAdapter.
func (a *Adapter) ExtractPaymentID(rawPayload any) *string {
	envelope, ok := asEnvelope(rawPayload)
	if !ok {
		return nil
	}
	id := envelope.PaymentID
	return &id
}

// ExtractPspAttemptRef implements adapters.PspAdapter.
func (a *Adapter) ExtractPspAttemptRef(rawPayload any) *string {
	envelope, ok := asEnvelope(rawPayload)
	if !ok {
		return nil
	}
	ref := envelope.PspAttemptRef
	return &ref
}

// NormalizeDecline implements adapters.PspAdapter.
func (a *Adapter) NormalizeDecline(rawCode string) domain.NormalizedDecline {
	if d, ok := mockDeclineMap[rawCode]; ok {
		return d
	}
	return domain.UnmappedDecline("mock", rawCode)
}

// Capabilities implements adapters.PspAdapter.
func (a *Adapter) Capabilities() adapters.PspCapabilities {
	return adapters.PspCapabilities{
		Methods:               []string{"card"},
		Currencies:            []string{"USD", "EUR"},
		ThreeDs:               true,
		SupportsNetworkTokens: false,
	}
}

// ListSettlements implements adapters.PspAdapter. Milestone 6, T6.2:
// one settlement line per attempt that has ever settled (captured or
// refunded) at or after sinceISO, with a synthetic fee and a payout ref
// grouped by settlement DATE (so every attempt settled on the same day
// lands in the same synthetic payout — see ListPayouts). Deterministic
// and in-memory, matching this adapter's whole reason for existing
// (T2.2).
func (a *Adapter) ListSettlements(ctx context.Context, sinceISO string) ([]adapters.SettlementRecord, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	since, err := parseTime(sinceISO)
	if err != nil {
		return nil, err
	}

	var records []adapters.SettlementRecord
	for _, attempt := range a.attemptsByRef {
		if attempt.settledAt == nil || attempt.settledAmount == nil {
			continue
		}
		settledAt, err := parseTime(*attempt.settledAt)
		if err != nil {
			continue
		}
		if settledAt.Before(since) {
			continue
		}

		settlementType := adapters.SettlementTypeCapture
		if attempt.status == adapters.AttemptStatusRefunded {
			settlementType = adapters.SettlementTypeRefund
		}
		var feeAmount *domain.Money
		if settlementType == adapters.SettlementTypeCapture {
			fee := mockFee(*attempt.settledAmount)
			feeAmount = &fee
		}
		payoutRef := "mock_payout_" + dateOnly(*attempt.settledAt)
		records = append(records, adapters.SettlementRecord{
			PspAttemptRef: attempt.pspAttemptRef,
			Type:          settlementType,
			Amount:        *attempt.settledAmount,
			FeeAmount:     feeAmount,
			PspPayoutRef:  &payoutRef,
			OccurredAt:    *attempt.settledAt,
		})
	}
	return records, nil
}

// ListPayouts implements adapters.PspAdapter — one synthetic payout per
// distinct settlement date implied by ListSettlements.
func (a *Adapter) ListPayouts(ctx context.Context, sinceISO string) ([]adapters.PayoutRecord, error) {
	settlements, err := a.ListSettlements(ctx, sinceISO)
	if err != nil {
		return nil, err
	}
	type accum struct {
		currency string
		net      int64
	}
	byPayoutRef := make(map[string]*accum)
	order := make([]string, 0)
	for _, record := range settlements {
		if record.PspPayoutRef == nil {
			continue
		}
		ref := *record.PspPayoutRef
		existing, ok := byPayoutRef[ref]
		if !ok {
			existing = &accum{currency: record.Amount.Currency()}
			byPayoutRef[ref] = existing
			order = append(order, ref)
		}
		gross := record.Amount.MinorUnits()
		var fee int64
		if record.FeeAmount != nil {
			fee = record.FeeAmount.MinorUnits()
		}
		if record.Type == adapters.SettlementTypeRefund {
			existing.net -= gross
		} else {
			existing.net += gross - fee
		}
	}
	results := make([]adapters.PayoutRecord, 0, len(order))
	for _, ref := range order {
		acc := byPayoutRef[ref]
		net := acc.net
		if net < 0 {
			net = 0
		}
		amount, err := domain.MakeMoney(net, acc.currency)
		if err != nil {
			return nil, err
		}
		arrivalDate := trimPrefix(ref, "mock_payout_")
		results = append(results, adapters.PayoutRecord{
			PspPayoutRef: ref,
			Status:       adapters.PayoutStatusPaid,
			Amount:       amount,
			ArrivalDate:  &arrivalDate,
		})
	}
	return results, nil
}

// ScheduleAccountUpdate is a test-only helper (T8.3): schedules an
// account-updater notification for ListAccountUpdates to surface on its
// next call at or after scheduledAt. Real PSPs push these
// asynchronously on their own timeline; nothing about CreatePayment et
// al. generates one on its own, unlike settlements. If scheduledAt is
// empty, it defaults to now.
func (a *Adapter) ScheduleAccountUpdate(update adapters.AccountUpdateRecord, scheduledAt string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if scheduledAt == "" {
		scheduledAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	a.scheduledAccountUpdates = append(a.scheduledAccountUpdates, scheduledAccountUpdate{update: update, scheduledAt: scheduledAt})
}

// ListAccountUpdates implements adapters.PspAdapter.
func (a *Adapter) ListAccountUpdates(ctx context.Context, sinceISO string) ([]adapters.AccountUpdateRecord, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	since, err := parseTime(sinceISO)
	if err != nil {
		return nil, err
	}
	var records []adapters.AccountUpdateRecord
	for _, scheduled := range a.scheduledAccountUpdates {
		scheduledAt, err := parseTime(scheduled.scheduledAt)
		if err != nil {
			continue
		}
		if scheduledAt.Before(since) {
			continue
		}
		records = append(records, scheduled.update)
	}
	return records, nil
}

func (a *Adapter) store(idempotencyKey string, attempt *storedAttempt) {
	a.attemptsByRef[attempt.pspAttemptRef] = attempt
	a.attemptsByIdempotencyKey[idempotencyKey] = attempt
}

func (a *Adapter) requireAttempt(pspAttemptRef string) (*storedAttempt, error) {
	stored, ok := a.attemptsByRef[pspAttemptRef]
	if !ok {
		return nil, fmt.Errorf("mock: unknown pspAttemptRef %s", pspAttemptRef)
	}
	return stored, nil
}

func toAttemptResult(stored *storedAttempt) adapters.AttemptResult {
	return adapters.AttemptResult{
		PspAttemptRef:        stored.pspAttemptRef,
		Status:               stored.status,
		Decline:              stored.decline,
		NetworkTransactionID: stored.networkTransactionID,
	}
}

// asEnvelope accepts either a WebhookEnvelope value (the common case,
// when NormalizeEvent/ExtractPaymentID/ExtractPspAttemptRef are called
// directly with the VerifiedEvent.RawPayload this adapter itself
// produced) or a *WebhookEnvelope, mirroring the TS adapter's loose
// `as MockWebhookEnvelope` cast — callers outside this package always
// go through VerifyWebhook first, which already returns a
// WebhookEnvelope value as RawPayload.
func asEnvelope(rawPayload any) (WebhookEnvelope, bool) {
	switch v := rawPayload.(type) {
	case WebhookEnvelope:
		return v, true
	case *WebhookEnvelope:
		if v == nil {
			return WebhookEnvelope{}, false
		}
		return *v, true
	default:
		return WebhookEnvelope{}, false
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

func parseTime(s string) (time.Time, error) {
	return time.Parse(time.RFC3339Nano, s)
}

func dateOnly(iso string) string {
	if len(iso) >= 10 {
		return iso[:10]
	}
	return iso
}

func trimPrefix(s, prefix string) string {
	if len(s) >= len(prefix) && s[:len(prefix)] == prefix {
		return s[len(prefix):]
	}
	return s
}
