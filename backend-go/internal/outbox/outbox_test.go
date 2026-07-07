package outbox

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

// fakeExecer is a minimal in-memory Execer — no live Postgres, mirroring
// this port's standing fake-over-mocking-library preference.
type fakeExecer struct {
	lastSQL  string
	lastArgs []any
	calls    int
}

func (f *fakeExecer) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	f.lastSQL = sql
	f.lastArgs = args
	f.calls++
	return pgconn.CommandTag{}, nil
}

func TestInsertEvent_InsertsPendingRowWithGeneratedID(t *testing.T) {
	exec := &fakeExecer{}
	id, err := InsertEvent(context.Background(), exec, Event{
		AggregateType: "payment",
		AggregateID:   "payment-1",
		EventType:     "outbound-webhook",
		Payload:       map[string]any{"foo": "bar"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if id == "" {
		t.Fatal("expected a non-empty generated id")
	}
	if exec.calls != 1 {
		t.Fatalf("expected exactly one Exec call, got %d", exec.calls)
	}
	if len(exec.lastArgs) != 5 {
		t.Fatalf("expected 5 args (id, aggregate_type, aggregate_id, event_type, payload), got %d", len(exec.lastArgs))
	}
	if exec.lastArgs[0] != id {
		t.Fatalf("expected first arg to be the generated id, got %v", exec.lastArgs[0])
	}
	if exec.lastArgs[1] != "payment" || exec.lastArgs[2] != "payment-1" || exec.lastArgs[3] != "outbound-webhook" {
		t.Fatalf("unexpected positional args: %+v", exec.lastArgs)
	}

	payloadRaw, ok := exec.lastArgs[4].([]byte)
	if !ok {
		t.Fatalf("expected payload arg to be []byte, got %T", exec.lastArgs[4])
	}
	var decoded map[string]any
	if err := json.Unmarshal(payloadRaw, &decoded); err != nil {
		t.Fatalf("failed to unmarshal payload: %v", err)
	}
	if decoded["foo"] != "bar" {
		t.Fatalf("expected payload.foo=bar, got %v", decoded["foo"])
	}
}

func TestInsertEvent_GeneratesDistinctIDsAcrossCalls(t *testing.T) {
	exec := &fakeExecer{}
	id1, err := InsertEvent(context.Background(), exec, Event{AggregateType: "payment", AggregateID: "p1", EventType: "e", Payload: map[string]any{}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	id2, err := InsertEvent(context.Background(), exec, Event{AggregateType: "payment", AggregateID: "p1", EventType: "e", Payload: map[string]any{}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if id1 == id2 {
		t.Fatalf("expected distinct ids across calls, got %s twice", id1)
	}
}
