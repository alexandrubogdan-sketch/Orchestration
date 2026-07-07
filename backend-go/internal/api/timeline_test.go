package api

import (
	"testing"
	"time"
)

// This file ports test/unit/timeline.test.ts case-for-case.
// serializeTimeline is a pure function (no I/O), so every case from the
// TS suite carries over directly against hand-built []PaymentEventRow
// input, no fakes needed.

func eventRow(eventType string, declineCode *string, occurredAt string) PaymentEventRow {
	ts, err := time.Parse(time.RFC3339, occurredAt)
	if err != nil {
		panic(err)
	}
	return PaymentEventRow{EventType: eventType, DeclineCode: declineCode, OccurredAt: ts}
}

func TestSerializeTimeline_MapsCanonicalEventTypesToStableNames(t *testing.T) {
	rows := []PaymentEventRow{
		eventRow("authorization_started", nil, "2026-01-01T00:00:00Z"),
		eventRow("authorized", nil, "2026-01-01T00:00:01Z"),
		eventRow("capture_started", nil, "2026-01-01T00:00:02Z"),
		eventRow("captured", nil, "2026-01-01T00:00:03Z"),
	}
	got := serializeTimeline(rows)
	want := []string{"started", "authorized", "pending", "captured"}
	if len(got) != len(want) {
		t.Fatalf("got %d entries, want %d", len(got), len(want))
	}
	for i, w := range want {
		if got[i].Event != w {
			t.Errorf("entry %d: got event %q, want %q", i, got[i].Event, w)
		}
	}
}

func TestSerializeTimeline_IncludesDeclineCodeOnDeclinedEntry(t *testing.T) {
	code := "insufficient_funds"
	rows := []PaymentEventRow{eventRow("declined", &code, "2026-01-01T00:00:00Z")}
	got := serializeTimeline(rows)
	if len(got) != 1 {
		t.Fatalf("got %d entries, want 1", len(got))
	}
	entry := got[0]
	if entry.Event != "declined" {
		t.Errorf("Event = %q, want declined", entry.Event)
	}
	if entry.OccurredAt != "2026-01-01T00:00:00.000Z" {
		t.Errorf("OccurredAt = %q, want 2026-01-01T00:00:00.000Z", entry.OccurredAt)
	}
	if entry.DeclineCode == nil || *entry.DeclineCode != "insufficient_funds" {
		t.Errorf("DeclineCode = %v, want insufficient_funds", entry.DeclineCode)
	}
}

func TestSerializeTimeline_DisputeWonLostSurfaceAsDisputeClosedWithOutcome(t *testing.T) {
	won := serializeTimeline([]PaymentEventRow{eventRow("dispute_won", nil, "2026-01-01T00:00:00Z")})
	if len(won) != 1 || won[0].Event != "dispute_closed" {
		t.Fatalf("won entry = %+v, want event=dispute_closed", won)
	}
	if won[0].Outcome == nil || *won[0].Outcome != "won" {
		t.Errorf("won outcome = %v, want won", won[0].Outcome)
	}

	lost := serializeTimeline([]PaymentEventRow{eventRow("dispute_lost", nil, "2026-01-01T00:00:00Z")})
	if len(lost) != 1 || lost[0].Event != "dispute_closed" {
		t.Fatalf("lost entry = %+v, want event=dispute_closed", lost)
	}
	if lost[0].Outcome == nil || *lost[0].Outcome != "lost" {
		t.Errorf("lost outcome = %v, want lost", lost[0].Outcome)
	}
}

func TestSerializeTimeline_ExcludesOperationalOnlyEventTypes(t *testing.T) {
	rows := []PaymentEventRow{
		eventRow("late_event", nil, "2026-01-01T00:00:00Z"),
		eventRow("invariant_violation", nil, "2026-01-01T00:00:01Z"),
		eventRow("captured", nil, "2026-01-01T00:00:02Z"),
	}
	got := serializeTimeline(rows)
	if len(got) != 1 {
		t.Fatalf("got %d entries, want 1 (late_event/invariant_violation excluded)", len(got))
	}
	if got[0].Event != "captured" {
		t.Errorf("got event %q, want captured", got[0].Event)
	}
}

func TestSerializeTimeline_PreservesInputOrder(t *testing.T) {
	rows := []PaymentEventRow{
		eventRow("refund_started", nil, "2026-01-01T00:00:00Z"),
		eventRow("refunded", nil, "2026-01-01T00:00:01Z"),
	}
	got := serializeTimeline(rows)
	want := []string{"refund_pending", "refunded"}
	if len(got) != len(want) {
		t.Fatalf("got %d entries, want %d", len(got), len(want))
	}
	for i, w := range want {
		if got[i].Event != w {
			t.Errorf("entry %d: got event %q, want %q", i, got[i].Event, w)
		}
	}
}
