package ledger

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/alphapayments/payment-orchestrator/internal/adapters"
)

// ReconExceptionType mirrors the TS ReconExceptionType union exactly —
// and, not coincidentally, the exact 4-value CHECK constraint on
// recon_exceptions.type in
// db/migrations/1735776900000_recon-exceptions.up.sql.
type ReconExceptionType string

const (
	ReconExceptionMissingTransaction  ReconExceptionType = "missing_transaction"
	ReconExceptionAmountMismatch      ReconExceptionType = "amount_mismatch"
	ReconExceptionUnmatchedSettlement ReconExceptionType = "unmatched_settlement"
	ReconExceptionDuplicateSettlement ReconExceptionType = "duplicate_settlement"
)

// ReconcileSummary mirrors the TS ReconcileSummary interface exactly.
type ReconcileSummary struct {
	Matched    int
	Linked     int
	Exceptions int
}

// writeExceptionInput mirrors the TS WriteExceptionInput interface.
// Expected/Actual are *int64 (nil == SQL NULL, matching the TS
// `undefined | null -> null` collapsing writeException itself does) —
// never a float64, per this package's standing money-safety rule; these
// are raw minor-units integers, not domain.Money, because a
// recon_exceptions row can legitimately have only one side populated
// (e.g. unmatched_settlement has no "expected" side at all — there is
// no transactions row to compare against), so a domain.Money pair (which
// would require constructing a value even for the absent side) is the
// wrong shape here.
type writeExceptionInput struct {
	PSPAccountID    string
	PaymentID       *string
	TransactionID   *string
	Type            ReconExceptionType
	ExpectedMinor   *int64
	ActualMinor     *int64
	Currency        *string
	Details         any
}

// writeException is the Go port of reconciliation.ts's writeException.
func writeException(ctx context.Context, db Querier, input writeExceptionInput) error {
	detailsJSON, err := json.Marshal(input.Details)
	if err != nil {
		return fmt.Errorf("ledger: marshal recon_exceptions details: %w", err)
	}
	id, err := uuid.NewV7()
	if err != nil {
		return fmt.Errorf("ledger: generate recon_exceptions id: %w", err)
	}
	_, err = db.Exec(ctx,
		`INSERT INTO recon_exceptions
		   (id, payment_id, transaction_id, psp_account_id, type, expected_amount_minor_units, actual_amount_minor_units, currency, details)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		id.String(), input.PaymentID, input.TransactionID, input.PSPAccountID, string(input.Type),
		input.ExpectedMinor, input.ActualMinor, input.Currency, detailsJSON,
	)
	if err != nil {
		return fmt.Errorf("ledger: insert recon_exceptions row: %w", err)
	}
	return nil
}

// settlementDetails is the JSON shape written into recon_exceptions.details
// for every exception this file raises — mirrors the TS `{ settlement }`
// object literal exactly (a plain wrapper around the settlement line
// that caused the exception, for an operator to inspect later). Field
// names are camelCase to match the TS source's own JSON shape byte for
// byte, since a dashboard/report reading this jsonb column should not
// have to special-case which backend (TS or Go) wrote a given row.
type settlementDetails struct {
	Settlement settlementJSON `json:"settlement"`
}

// settlementJSON mirrors adapters.SettlementRecord's fields exactly (in
// the same camelCase shape the TS SettlementRecord interface already
// used on the wire/in logs), since adapters.SettlementRecord itself has
// no JSON tags (Phase 2 never needed to serialize it — see this port's
// standing convention of not retrofitting JSON tags onto a type for one
// caller's convenience, matching internal/adapters/mock/mock.go's own
// wireDecline/wireEnvelope precedent of a local mirror struct instead).
type settlementJSON struct {
	PspAttemptRef string  `json:"pspAttemptRef"`
	Type          string  `json:"type"`
	AmountMinor   int64   `json:"amountMinorUnits"`
	Currency      string  `json:"currency"`
	FeeMinor      *int64  `json:"feeAmountMinorUnits,omitempty"`
	PspPayoutRef  *string `json:"pspPayoutRef,omitempty"`
	OccurredAt    string  `json:"occurredAt"`
}

func toSettlementJSON(s adapters.SettlementRecord) settlementJSON {
	out := settlementJSON{
		PspAttemptRef: s.PspAttemptRef,
		Type:          string(s.Type),
		AmountMinor:   s.Amount.MinorUnits(),
		Currency:      s.Amount.Currency(),
		PspPayoutRef:  s.PspPayoutRef,
		OccurredAt:    s.OccurredAt,
	}
	if s.FeeAmount != nil {
		fee := s.FeeAmount.MinorUnits()
		out.FeeMinor = &fee
	}
	return out
}

// ReconcileSettlements is the Go port of reconciliation.ts's
// reconcileSettlements (T6.2/T6.3/ADR-0008): matches every capture/
// refund settlement line against payment_attempts/transactions, writes
// a recon_exceptions row for anything that doesn't line up, and links
// matched captures to their payout batch by inserting a NEW,
// second `type = 'payout'` transactions row (never an UPDATE — see this
// function's own per-branch comments and ADR-0008 point 3: transactions
// has had an append-only trigger since Milestone 1).
//
// MATCHING ALGORITHM — read this before changing any branch below; this
// is financial-reconciliation logic where the exact order of checks and
// the exact equality semantics are the spec, not an implementation
// detail:
//
//  1. Only type == capture or type == refund lines are matched at all.
//     Fee/payout-type lines aren't compared 1:1 against a transactions
//     row (ADR-0008 point 5 — there's no single corresponding row).
//  2. Dedupe key is the literal string `{pspAttemptRef}:{type}:{occurredAt}`
//     (three fields joined with ':', exactly matching the TS template
//     literal — not a hash, not normalized, not parsed as a timestamp).
//     A duplicate key within THIS SAME CALL's settlements slice (not
//     against any prior call, and not against the database) raises
//     duplicate_settlement and skips all further processing of that
//     line — the first occurrence of a duplicate key is still matched/
//     linked normally; only the SECOND (and any later) occurrence
//     raises the exception. This mirrors "process a batch once"; a
//     genuinely re-ingested overlapping window across TWO separate
//     calls is instead naturally idempotent via each write's own
//     ON CONFLICT / equality-check behavior (see settlement.go's own
//     doc comment on the fixed-look-back-window design), not via this
//     in-memory set.
//  3. No matching payment_attempts row (by psp_attempt_ref) ->
//     unmatched_settlement.
//  4. A payment_attempts row exists, but no matching transactions row
//     (same attempt_id AND same type) -> missing_transaction.
//  5. Both exist: exact integer equality between
//     transactions.amount_minor_units and settlement.Amount.MinorUnits()
//     — no tolerance, no rounding, no epsilon. A one-minor-unit
//     difference is a real mismatch, not noise, per the TS source's own
//     `!==` (exact) comparison; introducing a tolerance here without an
//     explicit spec requirement would be silently REDUCING precision, not
//     preserving it — see this package's self-critical list in
//     MIGRATION_NOTES.md for why this was not second-guessed.
//  6. On a clean match, summary.Matched increments. If, additionally,
//     the settlement line is type == capture AND carries a
//     PspPayoutRef, a payout-linkage transactions row is written (net
//     of fee) and summary.Linked increments — capture-with-no-payout-ref
//     lines are matched but not linked (payout not yet known).
func ReconcileSettlements(ctx context.Context, db Querier, pspAccountID string, settlements []adapters.SettlementRecord) (ReconcileSummary, error) {
	summary := ReconcileSummary{}
	seen := make(map[string]struct{}, len(settlements))

	for _, settlement := range settlements {
		if settlement.Type != adapters.SettlementTypeCapture && settlement.Type != adapters.SettlementTypeRefund {
			continue
		}

		dedupeKey := settlement.PspAttemptRef + ":" + string(settlement.Type) + ":" + settlement.OccurredAt
		if _, ok := seen[dedupeKey]; ok {
			actual := settlement.Amount.MinorUnits()
			currency := settlement.Amount.Currency()
			if err := writeException(ctx, db, writeExceptionInput{
				PSPAccountID: pspAccountID,
				Type:         ReconExceptionDuplicateSettlement,
				Currency:     &currency,
				ActualMinor:  &actual,
				Details:      settlementDetails{Settlement: toSettlementJSON(settlement)},
			}); err != nil {
				return summary, err
			}
			summary.Exceptions++
			continue
		}
		seen[dedupeKey] = struct{}{}

		var attemptID, paymentID string
		err := db.QueryRow(ctx,
			`SELECT id, payment_id FROM payment_attempts WHERE psp_attempt_ref = $1`,
			settlement.PspAttemptRef,
		).Scan(&attemptID, &paymentID)
		if err != nil {
			if !errors.Is(err, pgx.ErrNoRows) {
				return summary, fmt.Errorf("ledger: select payment_attempts for settlement match: %w", err)
			}
			actual := settlement.Amount.MinorUnits()
			currency := settlement.Amount.Currency()
			if werr := writeException(ctx, db, writeExceptionInput{
				PSPAccountID: pspAccountID,
				Type:         ReconExceptionUnmatchedSettlement,
				Currency:     &currency,
				ActualMinor:  &actual,
				Details:      settlementDetails{Settlement: toSettlementJSON(settlement)},
			}); werr != nil {
				return summary, werr
			}
			summary.Exceptions++
			continue
		}

		var transactionID string
		var expectedMinor int64
		err = db.QueryRow(ctx,
			`SELECT id, amount_minor_units FROM transactions WHERE attempt_id = $1 AND type = $2`,
			attemptID, string(settlement.Type),
		).Scan(&transactionID, &expectedMinor)
		if err != nil {
			if !errors.Is(err, pgx.ErrNoRows) {
				return summary, fmt.Errorf("ledger: select transactions for settlement match: %w", err)
			}
			actual := settlement.Amount.MinorUnits()
			currency := settlement.Amount.Currency()
			if werr := writeException(ctx, db, writeExceptionInput{
				PSPAccountID: pspAccountID,
				PaymentID:    &paymentID,
				Type:         ReconExceptionMissingTransaction,
				Currency:     &currency,
				ActualMinor:  &actual,
				Details:      settlementDetails{Settlement: toSettlementJSON(settlement)},
			}); werr != nil {
				return summary, werr
			}
			summary.Exceptions++
			continue
		}

		actual := settlement.Amount.MinorUnits()
		if expectedMinor != actual {
			currency := settlement.Amount.Currency()
			expected := expectedMinor
			if werr := writeException(ctx, db, writeExceptionInput{
				PSPAccountID:  pspAccountID,
				PaymentID:     &paymentID,
				TransactionID: &transactionID,
				Type:          ReconExceptionAmountMismatch,
				Currency:      &currency,
				ExpectedMinor: &expected,
				ActualMinor:   &actual,
				Details:       settlementDetails{Settlement: toSettlementJSON(settlement)},
			}); werr != nil {
				return summary, werr
			}
			summary.Exceptions++
			continue
		}

		summary.Matched++

		if settlement.Type == adapters.SettlementTypeCapture && settlement.PspPayoutRef != nil {
			payoutBatchID, err := resolvePayoutBatchID(ctx, db, pspAccountID, *settlement.PspPayoutRef, settlement.Amount.Currency())
			if err != nil {
				return summary, err
			}

			var feeMinor int64
			if settlement.FeeAmount != nil {
				feeMinor = settlement.FeeAmount.MinorUnits()
			}
			netMinor := settlement.Amount.MinorUnits() - feeMinor
			// net.of.fee is written as a raw computed int64, not run back
			// through domain.MakeMoney/Subtract — a settlement line whose
			// fee exceeds its gross amount (netMinor < 0) would fail
			// domain.MakeMoney's non-negative invariant AND the
			// transactions.amount_minor_units >= 0 CHECK constraint the
			// same way; letting the INSERT itself surface that as a clear
			// SQL error (rather than swallowing it earlier behind a
			// domain.Money construction failure with a different message)
			// mirrors the TS source exactly, which performs this same raw
			// subtraction with no upstream validation either. See this
			// package's self-critical list in MIGRATION_NOTES.md.
			if err := insertPayoutTransaction(ctx, db, paymentID, attemptID, pspAccountID, netMinor, settlement.Amount.Currency(), feeMinor, payoutBatchID); err != nil {
				return summary, err
			}
			summary.Linked++
		}
	}

	return summary, nil
}

// insertPayoutTransaction writes the second, append-only
// `type = 'payout'` transactions row ADR-0008 point 3 requires — a NEW
// fact ("this capture's proceeds, net of fee, were paid out in batch
// X"), never a correction/UPDATE of the original capture row.
func insertPayoutTransaction(ctx context.Context, db Querier, paymentID, attemptID, pspAccountID string, netMinorUnits int64, currency string, feeMinorUnits int64, payoutBatchID string) error {
	id, err := uuid.NewV7()
	if err != nil {
		return fmt.Errorf("ledger: generate payout transactions id: %w", err)
	}
	_, err = db.Exec(ctx,
		`INSERT INTO transactions (id, payment_id, attempt_id, type, amount_minor_units, currency, psp_account_id, fee_minor_units, payout_batch_id)
		 VALUES ($1, $2, $3, 'payout', $4, $5, $6, $7, $8)`,
		id.String(), paymentID, attemptID, netMinorUnits, currency, pspAccountID, feeMinorUnits, payoutBatchID,
	)
	if err != nil {
		return fmt.Errorf("ledger: insert payout transactions row: %w", err)
	}
	return nil
}
