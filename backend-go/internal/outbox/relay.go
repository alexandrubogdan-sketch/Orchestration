// This file is the Go port of the DB-access half of
// src/workflow/tasks/outboxRelay.ts (T1.6's relay/consumer side) — the
// part explicitly marked out of scope in Phase 5 (see this package's
// outbox.go top doc comment and MIGRATION_NOTES.md's Phase 5/6 "Not yet
// ported" lists). Phase 7 is the first phase with an actual Hatchet
// worker to drive this from (internal/worker/tasks.go's
// registerOutboxRelay), so the batch-drain/mark-dispatched/mark-failed
// SQL lives here rather than being inlined into internal/worker, per
// this port's standing convention that DB-shaped logic belongs in the
// package that owns the table (internal/outbox owns `outbox`, exactly
// as internal/webhooks owns `webhook_inbox` and internal/ledger owns
// `transactions`/`payout_batches`/`recon_exceptions`).
package outbox

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// MaxRelayAttempts mirrors MAX_RELAY_ATTEMPTS exactly.
const MaxRelayAttempts = 5

// DefaultRelayBatchSize mirrors DEFAULT_RELAY_BATCH_SIZE exactly.
const DefaultRelayBatchSize = 100

// StuckClaimStaleness is how long a row may sit in 'claimed' before
// ReconcileStuckClaims treats it as abandoned (the relay process that
// claimed it crashed, was killed, or was rescheduled before dispatching
// it) and reverts it to 'pending' for the next tick to pick back up.
// Comfortably longer than one outbox.relay tick (every minute, per
// internal/worker/cron.go's CronExpressions) so an in-flight batch that
// simply hasn't finished dispatching yet is never mistaken for stuck.
const StuckClaimStaleness = 5 * time.Minute

// Row mirrors the columns the relay reads off one outbox row — the Go
// analogue of outboxRelay.ts's per-row loop variable shape.
type Row struct {
	ID            string
	AggregateType string
	AggregateID   string
	EventType     string
	Payload       []byte
	Attempts      int
}

// DrainBatch mirrors outboxRelay.ts's handler's
// `deps.db.transaction().execute(async (trx) => {...})` block: inside a
// single transaction, SELECT ... FOR UPDATE SKIP LOCKED a batch of
// 'pending' rows ordered by created_at, then immediately mark that same
// batch 'claimed' (see this file's claimed-vs-dispatched doc comment
// below) within the SAME transaction — matching the TS source's own
// "claim the batch, then dispatch each row outside the transaction"
// two-phase shape (dispatch happens AFTER this function returns, in the
// caller, per-row, via deps.engine.dispatch(...) in the TS source and
// client.RunNoWait(...) in this Go port's registerOutboxRelay). FOR
// UPDATE SKIP LOCKED means multiple relay workers can run concurrently,
// each grabbing a disjoint batch instead of blocking on (or
// double-processing) the same rows.
//
// BUG FIX (backend review, 2026-07-10): this used to mark the claimed
// batch 'dispatched' directly — a status this codebase otherwise treats
// as "the actual dispatch call was attempted and this row is done" —
// before the caller had dispatched a single row. A crash between this
// function's commit and the caller's per-row dispatch loop reaching a
// given row left that row permanently marked 'dispatched' despite never
// having been sent, since nothing ever revisits a 'dispatched' row.
// 'claimed' is a distinct, non-terminal status exactly for this window:
// MarkDispatched (below) is now the only place that ever sets status =
// 'dispatched', and ReconcileStuckClaims (below) sweeps up any 'claimed'
// row abandoned by a crashed/killed relay run.
func DrainBatch(ctx context.Context, pool *pgxpool.Pool, batchSize int) ([]Row, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("outbox: begin drain-batch tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // safe no-op after a successful Commit (pgx.ErrTxClosed)

	rows, err := tx.Query(ctx,
		`SELECT id, aggregate_type, aggregate_id, event_type, payload, attempts
		 FROM outbox
		 WHERE status = 'pending'
		 ORDER BY created_at ASC
		 LIMIT $1
		 FOR UPDATE SKIP LOCKED`,
		batchSize,
	)
	if err != nil {
		return nil, fmt.Errorf("outbox: select pending batch: %w", err)
	}
	var batch []Row
	for rows.Next() {
		var r Row
		if err := rows.Scan(&r.ID, &r.AggregateType, &r.AggregateID, &r.EventType, &r.Payload, &r.Attempts); err != nil {
			rows.Close()
			return nil, fmt.Errorf("outbox: scan pending row: %w", err)
		}
		batch = append(batch, r)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, fmt.Errorf("outbox: iterate pending rows: %w", err)
	}
	rows.Close()

	if len(batch) > 0 {
		ids := make([]string, len(batch))
		for i, r := range batch {
			ids[i] = r.ID
		}
		if _, err := tx.Exec(ctx, `UPDATE outbox SET status = 'claimed', claimed_at = now() WHERE id = ANY($1)`, ids); err != nil {
			return nil, fmt.Errorf("outbox: mark batch claimed: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("outbox: commit drain-batch tx: %w", err)
	}

	return batch, nil
}

// MarkDispatched mirrors outboxRelay.ts's per-row success branch:
// `.updateTable('outbox').set({dispatched_at: new Date()}).where('id','=',row.id)`
// — extended by the 2026-07-10 claimed/dispatched fix (see DrainBatch's
// doc comment) to also set status = 'dispatched' itself, since
// DrainBatch's claiming transaction now only ever sets 'claimed', never
// 'dispatched'. This call is the ONE place in this package that
// transitions a row to the terminal 'dispatched' status, and it only
// runs after the caller's actual dispatch call (client.RunNoWait) has
// already succeeded.
func MarkDispatched(ctx context.Context, pool *pgxpool.Pool, id string) error {
	_, err := pool.Exec(ctx, `UPDATE outbox SET status = 'dispatched', dispatched_at = now() WHERE id = $1`, id)
	if err != nil {
		return fmt.Errorf("outbox: mark %s dispatched_at: %w", id, err)
	}
	return nil
}

// ReconcileStuckClaims reverts any row still 'claimed' past
// StuckClaimStaleness back to 'pending', so a relay process that
// crashed (or was killed, rescheduled, or lost its DB connection)
// between DrainBatch's commit and actually dispatching a claimed row
// self-heals on a later tick instead of silently losing that event
// forever. Call this once at the START of every outbox.relay run,
// before DrainBatch — see internal/worker/tasks.go's
// outboxRelayHandler — piggybacking the sweep on the relay's own
// existing every-minute cron tick (internal/worker/cron.go) rather than
// registering a second, dedicated Hatchet task for it, since the two
// are logically one "keep the outbox moving" job and every relay tick
// is a perfectly good opportunity to also check for abandoned claims.
// Returns the number of rows reverted, purely for logging/observability
// — a non-zero count on a healthy system usually means the previous
// relay run's process was killed mid-batch, not a normal occurrence.
func ReconcileStuckClaims(ctx context.Context, pool *pgxpool.Pool, staleFor time.Duration) (int64, error) {
	// staleFor is passed as a plain float64 number of seconds, not a
	// formatted duration string: Go's time.Duration.String() produces
	// Go-flavored output ("5m0s") that is not a documented, reliable
	// Postgres interval literal — multiplying a numeric parameter by
	// interval '1 second' is unambiguous and needs no string parsing on
	// either side.
	tag, err := pool.Exec(ctx,
		`UPDATE outbox
		 SET status = 'pending', claimed_at = NULL
		 WHERE status = 'claimed' AND claimed_at < now() - ($1 * interval '1 second')`,
		staleFor.Seconds(),
	)
	if err != nil {
		return 0, fmt.Errorf("outbox: reconcile stuck claims: %w", err)
	}
	return tag.RowsAffected(), nil
}

// MarkAttemptFailed mirrors outboxRelay.ts's per-row failure branch:
// `.updateTable('outbox').set({status, attempts}).where('id','=',row.id)`
// — status is 'failed' once attempts reaches MaxRelayAttempts,
// otherwise reverted to 'pending' so the next relay run retries it
// (DrainBatch's claiming transaction already flipped it to 'dispatched'
// this run; a failure must revert that so a future run's WHERE
// status = 'pending' finds it again).
func MarkAttemptFailed(ctx context.Context, pool *pgxpool.Pool, id string, status string, attempts int) error {
	_, err := pool.Exec(ctx, `UPDATE outbox SET status = $2, attempts = $3 WHERE id = $1`, id, status, attempts)
	if err != nil {
		return fmt.Errorf("outbox: mark %s attempt failed: %w", id, err)
	}
	return nil
}
