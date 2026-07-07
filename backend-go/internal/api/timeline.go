package api

import "github.com/alphapayments/payment-orchestrator/internal/domain"

// This file is a 1:1 port of src/api/timeline.ts +
// src/domain/timelineEvents.ts's stable-name vocabulary. The TS source
// splits these across two files specifically so
// src/domain/stateMachineDb.ts (T8.4, a later phase) can depend on the
// vocabulary without an inverted domain -> api import; this Go port
// keeps both pieces in this one file for now since no
// internal/domain/timelineevents.go equivalent exists yet and nothing
// in this phase's domain package needs it — a later phase (webhook
// pipeline / outbound webhooks, T8.4's Go port) should move
// stableNameByEventType into internal/domain if/when
// internal/domain needs to depend on it too, exactly mirroring why the
// TS source put it there.
//
// Phase 5 update: internal/statemachine/db.go (the DB-effectful state
// machine shell, the Go port of src/domain/stateMachineDb.ts) now also
// needs this exact vocabulary, for the exact same reason the TS source
// gives (deciding whether a transitioned event is outbox/outbound-
// webhook-eligible). internal/statemachine cannot import this package
// directly without an import cycle (internal/api will, in turn, call
// into internal/statemachine once PaymentsStore.ApplyCanonicalEvents —
// living in this package, see pgpaymentsstore.go — calls
// statemachine.Transition). Rather than move stableNameByEventType into
// internal/domain (which the TS source deliberately did NOT do either),
// this file exports StableName below as a small lookup function that
// cmd/api/main.go passes into internal/statemachine's exported
// constructors at wiring time — breaking the cycle the same way the TS
// module boundary does (stateMachineDb.ts imports timelineEvents.ts,
// never the reverse).

// TimelineEventName mirrors the TS TimelineEventName union type's
// exact vocabulary (TIMELINE_EVENT_NAMES).
type TimelineEventName string

const (
	TimelineStarted                TimelineEventName = "started"
	TimelineAuthenticationRequired TimelineEventName = "authentication_required"
	TimelineAuthorized             TimelineEventName = "authorized"
	TimelinePending                TimelineEventName = "pending"
	TimelineCaptured               TimelineEventName = "captured"
	TimelineDeclined               TimelineEventName = "declined"
	TimelineVoided                 TimelineEventName = "voided"
	TimelineRefundPending          TimelineEventName = "refund_pending"
	TimelineRefunded               TimelineEventName = "refunded"
	TimelineSettled                TimelineEventName = "settled"
	TimelineDisputeOpened          TimelineEventName = "dispute_opened"
	TimelineDisputeClosed          TimelineEventName = "dispute_closed"
)

// stableNameByEventType mirrors STABLE_NAME_BY_EVENT_TYPE exactly —
// note event_type keys not present here (late_event,
// invariant_violation) are deliberately excluded, matching the TS
// source's own documented exclusion: they're operational signals, not
// a state a product's timeline should surface.
var stableNameByEventType = map[string]TimelineEventName{
	"authorization_started":   TimelineStarted,
	"authentication_required":  TimelineAuthenticationRequired,
	"authentication_completed": TimelinePending,
	"authorized":               TimelineAuthorized,
	"capture_started":          TimelinePending,
	"captured":                 TimelineCaptured,
	"declined":                 TimelineDeclined,
	"authorization_failed":     TimelineDeclined,
	"voided":                   TimelineVoided,
	"refund_started":           TimelineRefundPending,
	"refunded":                 TimelineRefunded,
	"settled":                  TimelineSettled,
	"dispute_opened":           TimelineDisputeOpened,
	"dispute_won":              TimelineDisputeClosed,
	"dispute_lost":             TimelineDisputeClosed,
}

// StableName looks up the stable, product-facing timeline name for a
// canonical event type — exported specifically so
// internal/statemachine/db.go (Phase 5) can be handed this function as
// its injected StableNameLookup at wiring time (cmd/api/main.go),
// without internal/statemachine importing this package directly (see
// this file's top doc comment for why that would create an import
// cycle). Returns ("", false) for late_event/invariant_violation and
// any other event_type absent from the map, exactly matching
// stableNameByEventType's own partial-map semantics.
func StableName(eventType domain.CanonicalEventType) (string, bool) {
	name, ok := stableNameByEventType[string(eventType)]
	return string(name), ok
}

// serializeTimeline mirrors src/api/timeline.ts's serializeTimeline
// exactly: skips any event_type with no stable-name mapping, formats
// occurredAt as RFC3339 (TS: `new Date(...).toISOString()`), includes
// declineCode only when present, and sets outcome to "won"/"lost" for
// dispute_won/dispute_lost specifically (both map to the same
// "dispute_closed" event name — outcome is what disambiguates them).
func serializeTimeline(rows []PaymentEventRow) []TimelineEntryDTO {
	entries := make([]TimelineEntryDTO, 0, len(rows))
	for _, row := range rows {
		event, ok := stableNameByEventType[row.EventType]
		if !ok {
			continue
		}

		entry := TimelineEntryDTO{
			Event:      string(event),
			OccurredAt: row.OccurredAt.UTC().Format("2006-01-02T15:04:05.000Z07:00"),
		}
		if row.DeclineCode != nil && *row.DeclineCode != "" {
			entry.DeclineCode = row.DeclineCode
		}
		if row.EventType == "dispute_won" {
			outcome := "won"
			entry.Outcome = &outcome
		}
		if row.EventType == "dispute_lost" {
			outcome := "lost"
			entry.Outcome = &outcome
		}
		entries = append(entries, entry)
	}
	return entries
}
