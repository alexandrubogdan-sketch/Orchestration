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

	"github.com/jackc/pgx/v5/pgxpool"
)

// MaxRelayAttempts mirrors MAX_RELAY_ATTEMPTS exactly.
const MaxRelayAttempts = 5

// DefaultRelayBatchSize mirrors DEFAULT_RELAY_BATCH_SIZE exactly.
const DefaultRelayBatchSize = 100

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
// `deps.db.transaction().execute(async (trx) => {...})` block exactly:
// inside a single transaction, SELECT ... FOR UPDATE SKIP LOCKED a
// batch of 'pending' rows ordered by created_at, then immediately mark
// that same batch 'dispatched' within the SAME transaction — matching
// the TS source's own "claim the batch, then dispatch each row outside
// the transaction" two-phase shape exactly (dispatch happens AFTER this
// function returns, in the caller, per-row, via
// deps.engine.dispatch(...) in the TS source and client.RunNoWait(...)
// in this Go port's registerOutboxRelay). FOR UPDATE SKIP LOCKED means
// multiple relay workers can run concurrently, each grabbing a disjoint
// batch instead of blocking on (or double-processing) the same rows.
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
		if _, err := tx.Exec(ctx, `UPDATE outbox SET status = 'dispatched' WHERE id = ANY($1)`, ids); err != nil {
			return nil, fmt.Errorf("outbox: mark batch dispatched: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("outbox: commit drain-batch tx: %w", err)
	}

	return batch, nil
}

// MarkDispatched mirrors outboxRelay.ts's per-row success branch:
// `.updateTable('outbox').set({dispatched_at: new Date()}).where('id','=',row.id)`.
// The row's status was already set to 'dispatched' by DrainBatch's own
// claiming transaction; this call only stamps dispatched_at once the
// caller's actual dispatch call (client.RunNoWait) has succeeded.
func MarkDispatched(ctx context.Context, pool *pgxpool.Pool, id string) error {
	_, err := pool.Exec(ctx, `UPDATE outbox SET dispatched_at = now() WHERE id = $1`, id)
	if err != nil {
		return fmt.Errorf("outbox: mark %s dispatched_at: %w", id, err)
	}
	return nil
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
