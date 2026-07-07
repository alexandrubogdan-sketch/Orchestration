package ledger

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// This file has NO live Postgres available in this sandbox — same
// standing constraint as every prior phase (see MIGRATION_NOTES.md).
// fakeDB below satisfies this package's Querier interface (QueryRow +
// Exec) entirely in memory, mirroring internal/statemachine/db_test.go's
// fakeTx pattern exactly: a hand-rolled fake distinguishing SQL shapes
// by substring match on the literal query text, not a mocking library.
//
// fakeDB models exactly the four tables this package's non-test code
// touches: payment_attempts (read-only here), transactions (read +
// append), payout_batches (read + upsert), recon_exceptions
// (append-only from this fake's point of view). It has no foreign-key
// enforcement, no transactional semantics, and no concurrency —
// deliberately, since every real call site in this package is already
// single-threaded per invocation and the point of this fake is to
// verify ReconcileSettlements'/RunNightlyInvariants'/writers.go's own
// control flow, not to re-implement Postgres.

type fakeAttempt struct {
	id            string
	paymentID     string
	pspAttemptRef string
}

type fakeTransaction struct {
	id              string
	paymentID       string
	attemptID       string
	txType          string
	amountMinor     int64
	currency        string
	pspAccountID    string
	feeMinor        int64
	payoutBatchID   *string
}

type fakePayoutBatch struct {
	id            string
	pspAccountID  string
	pspPayoutRef  string
	status        string
	amountMinor   int64
	currency      string
	arrivalDate   *string
}

type fakeReconException struct {
	paymentID     *string
	transactionID *string
	pspAccountID  string
	excType       string
	expectedMinor *int64
	actualMinor   *int64
	currency      *string
	detailsJSON   []byte
}

type fakeDB struct {
	attemptsByRef map[string]*fakeAttempt
	transactions  []*fakeTransaction
	payoutBatches []*fakePayoutBatch
	exceptions    []*fakeReconException

	nextID int
}

func newFakeDB() *fakeDB {
	return &fakeDB{attemptsByRef: make(map[string]*fakeAttempt)}
}

func (f *fakeDB) genID(prefix string) string {
	f.nextID++
	return fmt.Sprintf("%s-%d", prefix, f.nextID)
}

func (f *fakeDB) seedAttempt(paymentID, attemptID, pspAttemptRef string) {
	f.attemptsByRef[pspAttemptRef] = &fakeAttempt{id: attemptID, paymentID: paymentID, pspAttemptRef: pspAttemptRef}
}

func (f *fakeDB) seedTransaction(tx *fakeTransaction) {
	f.transactions = append(f.transactions, tx)
}

func (f *fakeDB) findTransaction(attemptID, txType string) *fakeTransaction {
	for _, tx := range f.transactions {
		if tx.attemptID == attemptID && tx.txType == txType {
			return tx
		}
	}
	return nil
}

func (f *fakeDB) findPayoutBatch(pspAccountID, pspPayoutRef string) *fakePayoutBatch {
	for _, pb := range f.payoutBatches {
		if pb.pspAccountID == pspAccountID && pb.pspPayoutRef == pspPayoutRef {
			return pb
		}
	}
	return nil
}

// fakeRowScanner adapts a fixed scan function to pgx.Row, mirroring
// internal/statemachine/db_test.go's identical helper.
type fakeRowScanner struct {
	scan func(dest ...any) error
}

func (f fakeRowScanner) Scan(dest ...any) error { return f.scan(dest...) }

func notFoundRow() pgx.Row {
	return fakeRowScanner{scan: func(dest ...any) error { return pgx.ErrNoRows }}
}

func (f *fakeDB) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	switch {
	case strings.Contains(sql, "FROM payment_attempts WHERE psp_attempt_ref"):
		ref, _ := args[0].(string)
		attempt, ok := f.attemptsByRef[ref]
		if !ok {
			return notFoundRow()
		}
		return fakeRowScanner{scan: func(dest ...any) error {
			*(dest[0].(*string)) = attempt.id
			*(dest[1].(*string)) = attempt.paymentID
			return nil
		}}

	case strings.Contains(sql, "FROM transactions WHERE attempt_id"):
		attemptID, _ := args[0].(string)
		txType, _ := args[1].(string)
		tx := f.findTransaction(attemptID, txType)
		if tx == nil {
			return notFoundRow()
		}
		return fakeRowScanner{scan: func(dest ...any) error {
			*(dest[0].(*string)) = tx.id
			*(dest[1].(*int64)) = tx.amountMinor
			return nil
		}}

	case strings.Contains(sql, "FROM payout_batches WHERE psp_account_id"):
		pspAccountID, _ := args[0].(string)
		pspPayoutRef, _ := args[1].(string)
		pb := f.findPayoutBatch(pspAccountID, pspPayoutRef)
		if pb == nil {
			return notFoundRow()
		}
		return fakeRowScanner{scan: func(dest ...any) error {
			*(dest[0].(*string)) = pb.id
			return nil
		}}

	case strings.Contains(sql, "INSERT INTO payout_batches") && strings.Contains(sql, "RETURNING id"):
		id, _ := args[0].(string)
		pspAccountID, _ := args[1].(string)
		pspPayoutRef, _ := args[2].(string)
		status, _ := args[3].(string)
		amountMinor, _ := args[4].(int64)
		currency, _ := args[5].(string)
		var arrivalDate *string
		if s, ok := args[6].(string); ok {
			arrivalDate = &s
		}
		existing := f.findPayoutBatch(pspAccountID, pspPayoutRef)
		if existing != nil {
			existing.status = status
			existing.amountMinor = amountMinor
			existing.arrivalDate = arrivalDate
			return fakeRowScanner{scan: func(dest ...any) error {
				*(dest[0].(*string)) = existing.id
				return nil
			}}
		}
		pb := &fakePayoutBatch{id: id, pspAccountID: pspAccountID, pspPayoutRef: pspPayoutRef, status: status, amountMinor: amountMinor, currency: currency, arrivalDate: arrivalDate}
		f.payoutBatches = append(f.payoutBatches, pb)
		return fakeRowScanner{scan: func(dest ...any) error {
			*(dest[0].(*string)) = pb.id
			return nil
		}}

	default:
		return fakeRowScanner{scan: func(dest ...any) error {
			return fmt.Errorf("fakeDB: unrecognized QueryRow SQL: %s", sql)
		}}
	}
}

func (f *fakeDB) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	switch {
	case strings.Contains(sql, "INSERT INTO recon_exceptions"):
		exc := &fakeReconException{pspAccountID: args[3].(string), excType: args[4].(string)}
		if v, ok := args[1].(*string); ok {
			exc.paymentID = v
		}
		if v, ok := args[2].(*string); ok {
			exc.transactionID = v
		}
		if v, ok := args[5].(*int64); ok {
			exc.expectedMinor = v
		}
		if v, ok := args[6].(*int64); ok {
			exc.actualMinor = v
		}
		if v, ok := args[7].(*string); ok {
			exc.currency = v
		}
		if v, ok := args[8].([]byte); ok {
			exc.detailsJSON = v
		}
		f.exceptions = append(f.exceptions, exc)
		return pgconn.CommandTag{}, nil

	case strings.Contains(sql, "INSERT INTO transactions") && strings.Contains(sql, "'payout'"):
		// (id, payment_id, attempt_id, [type literal], amount_minor_units, currency, psp_account_id, fee_minor_units, payout_batch_id)
		id, _ := args[0].(string)
		paymentID, _ := args[1].(string)
		attemptID, _ := args[2].(string)
		amountMinor, _ := args[3].(int64)
		currency, _ := args[4].(string)
		pspAccountID, _ := args[5].(string)
		feeMinor, _ := args[6].(int64)
		payoutBatchID, _ := args[7].(string)
		f.seedTransaction(&fakeTransaction{
			id: id, paymentID: paymentID, attemptID: attemptID, txType: "payout",
			amountMinor: amountMinor, currency: currency, pspAccountID: pspAccountID,
			feeMinor: feeMinor, payoutBatchID: &payoutBatchID,
		})
		return pgconn.CommandTag{}, nil

	case strings.Contains(sql, "INSERT INTO payout_batches") && strings.Contains(sql, "DO NOTHING"):
		pspAccountID, _ := args[1].(string)
		pspPayoutRef, _ := args[2].(string)
		currency, _ := args[3].(string)
		if f.findPayoutBatch(pspAccountID, pspPayoutRef) == nil {
			id, _ := args[0].(string)
			f.payoutBatches = append(f.payoutBatches, &fakePayoutBatch{
				id: id, pspAccountID: pspAccountID, pspPayoutRef: pspPayoutRef,
				status: "pending", amountMinor: 0, currency: currency,
			})
		}
		return pgconn.CommandTag{}, nil

	default:
		return pgconn.CommandTag{}, fmt.Errorf("fakeDB: unrecognized Exec SQL: %s", sql)
	}
}
