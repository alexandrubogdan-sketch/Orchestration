package stripe

import (
	"time"

	stripesdk "github.com/stripe/stripe-go/v81"

	"github.com/alphapayments/payment-orchestrator/internal/adapters"
	"github.com/alphapayments/payment-orchestrator/internal/domain"
)

// normalizeStripeBalanceTransaction: Milestone 6, T6.2. Stripe's
// balance transactions are signed (negative for money leaving the
// balance — refunds, fees charged standalone, payouts) and reference
// their source object (a Charge, Refund, or Payout) by id, not by
// PaymentIntent id directly — so mapping back to
// payment_attempts.psp_attempt_ref (a PaymentIntent id) requires the
// source to be expanded (Expand: []string{"data.source"}, wired at the
// call site in stripe.go) so source.PaymentIntent is available without
// a second round-trip per line.
//
// FLAGGED (per SPEC.md's working agreement — encode ambiguity, don't
// guess silently): this mapping is written against Stripe's documented
// balance_transaction/charge/refund object shapes, but there is no live
// Stripe account reachable from this build environment (same as the TS
// reference implementation's limitation) to verify the exact expanded-
// source shape against a real API response. testdata/settlement/
// fixtures are hand-constructed from Stripe's public API reference
// (copied byte-for-byte from the TS reference implementation's
// test/contract/golden/settlement/stripe/*.json), not recorded from a
// live call — treat this function as the first thing to re-verify
// against a real balance transaction export before this adapter goes
// to production.
func normalizeStripeBalanceTransaction(bt *stripesdk.BalanceTransaction) *adapters.SettlementRecord {
	pspAttemptRef := extractPaymentIntentIDFromBalanceTransaction(bt)
	if pspAttemptRef == nil {
		return nil
	}

	settlementType, ok := mapBalanceTransactionType(string(bt.Type))
	if !ok {
		return nil
	}

	currency := upper(string(bt.Currency))
	grossMinorUnits := abs64(bt.Amount)
	feeMinorUnits := abs64(bt.Fee)

	amount, err := domain.MakeMoney(grossMinorUnits, currency)
	if err != nil {
		return nil
	}
	var feeAmount *domain.Money
	if feeMinorUnits > 0 {
		fee, err := domain.MakeMoney(feeMinorUnits, currency)
		if err != nil {
			return nil
		}
		feeAmount = &fee
	}

	return &adapters.SettlementRecord{
		PspAttemptRef: *pspAttemptRef,
		Type:          settlementType,
		Amount:        amount,
		FeeAmount:     feeAmount,
		OccurredAt:    time.Unix(bt.Created, 0).UTC().Format(time.RFC3339),
	}
}

// mapBalanceTransactionType takes t as a plain string (Stripe's
// documented balance_transaction.type values: "charge", "payment",
// "refund", "payment_refund", "stripe_fee", "application_fee",
// "payout", "adjustment", "transfer", "topup", ...) rather than the
// named stripe.BalanceTransactionType type, for the same
// verification-without-network-access reason documented in
// statusmapping.go's mapPaymentIntentStatus.
func mapBalanceTransactionType(t string) (adapters.SettlementType, bool) {
	switch t {
	case "charge", "payment":
		return adapters.SettlementTypeCapture, true
	case "refund", "payment_refund":
		return adapters.SettlementTypeRefund, true
	case "stripe_fee", "application_fee":
		return adapters.SettlementTypeFee, true
	case "payout":
		return adapters.SettlementTypePayout, true
	default:
		// Adjustments, transfers, topups, etc. — not a settlement line
		// this orchestrator's reconciliation engine has a use for yet;
		// deliberately dropped rather than mis-mapped (see docs/design.md's
		// "encode ambiguity, don't guess" convention).
		return "", false
	}
}

// extractPaymentIntentIDFromBalanceTransaction reads
// bt.Source.PaymentIntent, which requires the caller to have expanded
// "data.source" on the list call (see ListSettlements in stripe.go).
// FLAGGED: stripe-go's BalanceTransactionSource is a union type across
// SDK versions (sometimes modeled as a struct with one populated field
// per possible underlying object, sometimes as an interface) — accessed
// here defensively through the exported Charge/Refund fields stripe-go
// v81's BalanceTransactionSource struct is expected to expose. Re-verify
// this accessor against the installed SDK version before trusting it
// against a live balance transaction export with a non-charge/refund
// source (see this file's docblock).
func extractPaymentIntentIDFromBalanceTransaction(bt *stripesdk.BalanceTransaction) *string {
	if bt == nil || bt.Source == nil {
		return nil
	}
	if charge := bt.Source.Charge; charge != nil && charge.PaymentIntent != nil {
		id := charge.PaymentIntent.ID
		return &id
	}
	if refund := bt.Source.Refund; refund != nil && refund.PaymentIntent != nil {
		id := refund.PaymentIntent.ID
		return &id
	}
	return nil
}

// normalizeStripePayout maps a Stripe Payout to a canonical
// adapters.PayoutRecord.
func normalizeStripePayout(payout *stripesdk.Payout) (adapters.PayoutRecord, error) {
	currency := upper(string(payout.Currency))
	amount, err := domain.MakeMoney(payout.Amount, currency)
	if err != nil {
		return adapters.PayoutRecord{}, err
	}
	status := adapters.PayoutStatusPending
	switch string(payout.Status) {
	case "paid":
		status = adapters.PayoutStatusPaid
	case "failed":
		status = adapters.PayoutStatusFailed
	}
	arrivalDate := time.Unix(payout.ArrivalDate, 0).UTC().Format("2006-01-02")
	return adapters.PayoutRecord{
		PspPayoutRef: payout.ID,
		Status:       status,
		Amount:       amount,
		ArrivalDate:  &arrivalDate,
	}, nil
}

func abs64(n int64) int64 {
	if n < 0 {
		return -n
	}
	return n
}

func upper(s string) string {
	out := make([]byte, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'a' && c <= 'z' {
			c -= 'a' - 'A'
		}
		out[i] = c
	}
	return string(out)
}
