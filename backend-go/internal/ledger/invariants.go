package ledger

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/alphapayments/payment-orchestrator/internal/domain"
)

// NightlyInvariantsInput mirrors the TS NightlyInvariantsInput interface
// — StaleHours is a *int for the same "distinguish unset from explicit
// zero" reason SettlementIngestionInput.SinceHours is (see settlement.go).
type NightlyInvariantsInput struct {
	StaleHours *int
}

// NightlyInvariantsResult mirrors the TS NightlyInvariantsResult
// interface exactly.
type NightlyInvariantsResult struct {
	CurrenciesChecked   int
	StuckPaymentsByState map[string]int
}

// NonTerminalStates mirrors the TS NON_TERMINAL_STATES array exactly —
// every domain.PaymentState EXCEPT the 5 in domain.TerminalStates
// (declined, voided, failed, dispute_won, dispute_lost), computed the
// same way the TS source computes it (PAYMENT_STATES.filter(s =>
// !TERMINAL_STATES.has(s))), not hand-transcribed as a second literal
// list that could silently drift from domain.PaymentStates/
// domain.TerminalStates if either changes later. Exported (unlike the
// TS source's own module-private NON_TERMINAL_STATES) so a test or a
// future dashboard/report can enumerate exactly which states this sweep
// considers "non-terminal" without re-deriving the filter itself.
var NonTerminalStates = computeNonTerminalStates()

func computeNonTerminalStates() []domain.PaymentState {
	var out []domain.PaymentState
	for _, s := range domain.PaymentStates {
		if !domain.IsTerminalState(s) {
			out = append(out, s)
		}
	}
	return out
}

// Metrics is the minimal capability RunNightlyInvariants needs from
// observability — a narrow, package-local interface mirroring
// internal/webhooks.Metrics's own precedent, so this package's tests
// never need the real global Prometheus registry wired in. The real
// implementation (PrometheusMetrics, metrics_prometheus.go) delegates
// to internal/observability's package-level vars, wired at cmd/*/main.go
// call sites by whoever registers this as a scheduled task (Phase 7).
type Metrics interface {
	// SetNetReconciliationDiscrepancy mirrors
	// netReconciliationDiscrepancyMinorUnits.set({currency}, discrepancy).
	SetNetReconciliationDiscrepancy(currency string, discrepancyMinorUnits int64)
	// SetReconOpenExceptions mirrors reconOpenExceptionsTotal.set({type}, count).
	SetReconOpenExceptions(exceptionType string, count int)
	// SetStuckPayments mirrors stuckPaymentsTotal.set({state}, count).
	SetStuckPayments(state string, count int)
}

// currencyTotals mirrors the TS inline `{ captured, refunded, paidOut }`
// accumulator object — every field a plain int64 minor-units sum, never
// a float64, matching this package's standing money-safety rule. These
// are raw SUM(amount_minor_units) aggregates straight off the
// transactions table, not domain.Money — a discrepancy can legitimately
// be reported as negative (see this type's own doc comment on
// RunNightlyInvariants below), which domain.Money's non-negative
// invariant would reject outright; a negative discrepancy here is the
// exact signal this job exists to surface, so it must be representable,
// not constructed away.
type currencyTotals struct {
	CapturedMinor int64
	RefundedMinor int64
	PaidOutMinor  int64
}

// netDiscrepancy computes captured - refunded - paidOut as a plain
// int64 — factored out of RunNightlyInvariants specifically so this
// exact arithmetic (the one piece of "real" financial math in this
// file — everything else is a straight SQL aggregate/count) is
// unit-testable without a live Postgres. Deliberately allowed to go
// negative (see currencyTotals' own doc comment above) — a negative
// result IS the alarm signal this whole check exists to raise, not an
// input error to reject.
func (t currencyTotals) netDiscrepancy() int64 {
	return t.CapturedMinor - t.RefundedMinor - t.PaidOutMinor
}

// zeroedStuckPaymentCounts returns a map with every NonTerminalStates
// entry present, defaulted to 0 — the pure logic behind the TS
// handler's own `for (const state of NON_TERMINAL_STATES)
// stuckPaymentsTotal.set({state},0)` zeroing loop (see
// RunNightlyInvariants' own doc comment on why this matters: a
// Prometheus gauge with no explicit .Set call simply keeps its last
// value forever, so a state that goes from "3 stuck" to "0 stuck"
// between two runs must be explicitly re-zeroed, not just omitted).
// counts overrides the zeroed default for every state it contains;
// factored out as its own pure function so a test can assert the
// zero-then-override merge behavior without touching Postgres or
// Prometheus.
func zeroedStuckPaymentCounts(counts map[string]int) map[string]int {
	out := make(map[string]int, len(NonTerminalStates))
	for _, state := range NonTerminalStates {
		out[string(state)] = 0
	}
	for state, count := range counts {
		out[state] = count
	}
	return out
}

// RunNightlyInvariants is the Go port of nightlyInvariants.ts's
// createNightlyInvariantsTask handler (T6.4): two independent,
// metrics-only checks (no automated remediation — see the TS source's
// own doc comment, reproduced in full below) plus the open-
// recon_exceptions gauge refresh this port folds in alongside them,
// exactly as the TS source does in the same handler.
//
// NET RECONCILIATION, per currency: captured - refunded - paidOut,
// summed straight off transactions.amount_minor_units grouped by
// (currency, type). This should be >= 0 at all times (a payout can
// never exceed what was captured net of refunds — money can't be paid
// out before it's captured) and will be STRICTLY POSITIVE whenever
// there's captured money not yet paid out, which is normal (payouts lag
// captures by the PSP's own payout schedule) — this metric is a TREND
// TO WATCH, not a hard zero/nonzero pass/fail gate. A NEGATIVE value
// means more was paid out than was ever captured, which is NEVER
// legitimate and always needs investigation — this is why
// currencyTotals/the discrepancy computation below uses plain int64
// arithmetic capable of going negative, not domain.Money (whose
// constructor would reject a negative value outright, which is the
// WRONG behavior here: this job's entire job is to detect and REPORT a
// negative number, not to fail loudly the moment one is computed).
//
// STUCK-STATE SWEEP: counts payments sitting in a NonTerminalStates
// state, grouped by state, whose updated_at is older than staleHours —
// a broader, slower-cadence safety net than the webhook pipeline's own
// gap-detection cron (internal/webhooks.RunGapDetection), which actively
// re-syncs specific "awaiting a webhook" states every few minutes. This
// job does NOT re-sync anything itself; a payment stuck in `authorized`
// for days is plausibly just an uncaptured pre-auth someone forgot
// about, an ops/product signal, not something to poll-and-fix
// automatically — exactly matching the TS source's own framing.
//
// Every state in NonTerminalStates gets its gauge explicitly zeroed
// before the real counts are set (mirroring the TS source's own
// `for (const state of NON_TERMINAL_STATES) stuckPaymentsTotal.set({state},0)`
// loop) so a state that had a nonzero stuck count on a PRIOR run and
// zero on THIS run is correctly reported as 0, not left showing its
// last nonzero value forever (a Prometheus gauge with no explicit
// .Set call simply keeps whatever value it was last set to).
//
// CRON WIRING: this is a plain, directly callable Go function — see
// this package's top doc comment; nothing here assumes a scheduler.
func RunNightlyInvariants(ctx context.Context, pool *pgxpool.Pool, metrics Metrics, input NightlyInvariantsInput) (NightlyInvariantsResult, error) {
	byCurrency, err := computeNetReconciliationTotals(ctx, pool)
	if err != nil {
		return NightlyInvariantsResult{}, err
	}
	if metrics != nil {
		for currency, totals := range byCurrency {
			metrics.SetNetReconciliationDiscrepancy(currency, totals.netDiscrepancy())
		}
	}

	openExceptions, err := countOpenReconExceptionsByType(ctx, pool)
	if err != nil {
		return NightlyInvariantsResult{}, err
	}
	if metrics != nil {
		for exceptionType, count := range openExceptions {
			metrics.SetReconOpenExceptions(exceptionType, count)
		}
	}

	staleHours := 24
	if input.StaleHours != nil {
		staleHours = *input.StaleHours
	}
	stuckByState, err := countStuckPayments(ctx, pool, staleHours)
	if err != nil {
		return NightlyInvariantsResult{}, err
	}
	if metrics != nil {
		for state, count := range zeroedStuckPaymentCounts(stuckByState) {
			metrics.SetStuckPayments(state, count)
		}
	}

	return NightlyInvariantsResult{
		CurrenciesChecked:    len(byCurrency),
		StuckPaymentsByState: stuckByState,
	}, nil
}

// computeNetReconciliationTotals mirrors the TS handler's
// `db.selectFrom('transactions').select(['currency','type']).select(sum('amount_minor_units'))
// .groupBy(['currency','type'])` query plus its subsequent in-memory
// captured/refunded/paidOut accumulation.
//
// PGX NUMERIC-SCAN GOTCHA — read this before changing this query.
// Postgres promotes SUM(bigint) to a numeric wire type (OID 1700), to
// avoid overflowing bigint on a very large ledger. pgx v5's default
// scan plan does NOT support scanning a numeric wire value directly
// into a plain Go int64 destination — that would be a runtime "cannot
// scan" error (pgx v5 is intentionally stricter than database/sql's
// permissive numeric conversions; numeric's codec targets
// pgtype.Numeric/float64/string, not bare int64). This query therefore
// casts explicitly, `SUM(amount_minor_units)::bigint`, so Postgres
// sends an int8 wire value instead — int8 scans into int64 natively.
// This is safe for this codebase's amounts (see domain.Money's own doc
// comment on why minorUnits is declared int64 — every real amount here
// is always well within int64 range) but would silently become the
// wrong fix if this table's amounts could ever legitimately overflow
// bigint; they cannot, by construction, so the cast is the right
// trade-off here, not a shortcut.
func computeNetReconciliationTotals(ctx context.Context, pool *pgxpool.Pool) (map[string]currencyTotals, error) {
	rows, err := pool.Query(ctx,
		`SELECT currency, type, SUM(amount_minor_units)::bigint AS total
		 FROM transactions
		 GROUP BY currency, type`,
	)
	if err != nil {
		return nil, fmt.Errorf("ledger: query transactions totals by currency/type: %w", err)
	}
	defer rows.Close()

	byCurrency := make(map[string]currencyTotals)
	for rows.Next() {
		var currency, txType string
		var total int64
		if err := rows.Scan(&currency, &txType, &total); err != nil {
			return nil, fmt.Errorf("ledger: scan transactions totals row: %w", err)
		}
		entry := byCurrency[currency]
		switch txType {
		case "capture":
			entry.CapturedMinor += total
		case "refund":
			entry.RefundedMinor += total
		case "payout":
			entry.PaidOutMinor += total
		}
		byCurrency[currency] = entry
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ledger: iterate transactions totals rows: %w", err)
	}
	return byCurrency, nil
}

// countOpenReconExceptionsByType mirrors the TS handler's
// `db.selectFrom('recon_exceptions').select('type').select(countAll())
// .where('status','=','open').groupBy('type')` query.
func countOpenReconExceptionsByType(ctx context.Context, pool *pgxpool.Pool) (map[string]int, error) {
	rows, err := pool.Query(ctx,
		`SELECT type, COUNT(*) AS count
		 FROM recon_exceptions
		 WHERE status = 'open'
		 GROUP BY type`,
	)
	if err != nil {
		return nil, fmt.Errorf("ledger: query open recon_exceptions by type: %w", err)
	}
	defer rows.Close()

	byType := make(map[string]int)
	for rows.Next() {
		var exceptionType string
		var count int
		if err := rows.Scan(&exceptionType, &count); err != nil {
			return nil, fmt.Errorf("ledger: scan recon_exceptions count row: %w", err)
		}
		byType[exceptionType] = count
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ledger: iterate recon_exceptions count rows: %w", err)
	}
	return byType, nil
}

// countStuckPayments mirrors the TS handler's
// `db.selectFrom('payments').select('state').select(countAll())
// .where('state','in',NON_TERMINAL_STATES).where('updated_at','<',cutoff)
// .groupBy('state')` query. cutoff is computed the same way the TS
// source computes it: `now() - staleHours hours`, using this process's
// wall clock (time.Now()), not the database's — an acceptable,
// pre-existing TS-source assumption this port carries over unchanged
// (a large clock skew between the app process and Postgres would affect
// both versions identically).
func countStuckPayments(ctx context.Context, pool *pgxpool.Pool, staleHours int) (map[string]int, error) {
	cutoff := time.Now().Add(-time.Duration(staleHours) * time.Hour)

	nonTerminal := make([]string, len(NonTerminalStates))
	for i, s := range NonTerminalStates {
		nonTerminal[i] = string(s)
	}

	rows, err := pool.Query(ctx,
		`SELECT state, COUNT(*) AS count
		 FROM payments
		 WHERE state = ANY($1) AND updated_at < $2
		 GROUP BY state`,
		nonTerminal, cutoff,
	)
	if err != nil {
		return nil, fmt.Errorf("ledger: query stuck payments by state: %w", err)
	}
	defer rows.Close()

	byState := make(map[string]int)
	for rows.Next() {
		var state string
		var count int
		if err := rows.Scan(&state, &count); err != nil {
			return nil, fmt.Errorf("ledger: scan stuck payments count row: %w", err)
		}
		byState[state] = count
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ledger: iterate stuck payments count rows: %w", err)
	}
	return byState, nil
}
