// Package outbox provides the transactional-outbox producer — the Go
// port of src/ledger/outbox.ts's insertOutboxEvent (T1.6). This is the
// producer side ONLY: it inserts one 'pending' row into the outbox
// table, always using the SAME transaction/connection handle the
// caller's own domain write (a state transition, a ledger entry, ...)
// is already using, so either both commit together or neither does.
// There is no standalone "insert an outbox event" path that isn't
// inside someone else's transaction — that would defeat the whole
// point of the pattern, exactly per the TS source's own doc comment.
//
// The relay/consumer side (src/workflow/tasks/outboxRelay.ts's polling
// dispatcher that flips 'pending' rows to 'dispatched'/'failed') is
// explicitly OUT OF SCOPE for this phase — see MIGRATION_NOTES.md's
// Phase 5 section. Nothing in this package reads outbox rows back out;
// it only ever inserts them.
package outbox

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

// Execer is the minimal capability InsertEvent needs from a
// transaction/connection handle — satisfied structurally by both
// *pgxpool.Pool and pgx.Tx (and, in tests, by any hand-rolled fake with
// a matching Exec method), mirroring this port's existing preference
// for small package-local interfaces over one shared DB abstraction
// (see internal/routing/rules.go's Querier, internal/api/pgstore.go).
// The signature matches pgx v5's own Exec signature exactly
// (pgxpool.Pool and pgx.Tx both implement this method as-is — no
// adapter type needed at any real call site).
type Execer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Event mirrors the TS OutboxEventInput shape exactly.
type Event struct {
	AggregateType string
	AggregateID   string
	EventType     string
	Payload       any
}

// InsertEvent inserts one 'pending' outbox row — the Go analogue of
// insertOutboxEvent(trx, event). Callers MUST pass a tx/pool handle
// that is part of the same database transaction as the domain write
// this event describes; see this package's doc comment for why. The
// generated id is a UUIDv7 (google/uuid's NewV7), mirroring the TS
// source's own `uuidv7()` call and this port's standing convention that
// every primary key in this schema is an app-generated UUIDv7, not
// DB-generated (see MIGRATION_NOTES.md's Phase 1 note).
func InsertEvent(ctx context.Context, db Execer, event Event) (string, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return "", fmt.Errorf("outbox: generate id: %w", err)
	}
	payloadJSON, err := json.Marshal(event.Payload)
	if err != nil {
		return "", fmt.Errorf("outbox: marshal payload: %w", err)
	}
	_, err = db.Exec(ctx,
		`INSERT INTO outbox (id, aggregate_type, aggregate_id, event_type, payload, status)
		 VALUES ($1, $2, $3, $4, $5, 'pending')`,
		id.String(), event.AggregateType, event.AggregateID, event.EventType, payloadJSON,
	)
	if err != nil {
		return "", fmt.Errorf("outbox: insert event: %w", err)
	}
	return id.String(), nil
}
