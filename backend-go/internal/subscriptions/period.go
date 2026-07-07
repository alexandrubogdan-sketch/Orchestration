// Package subscriptions is the Go port of Milestone 8's subscription
// billing/dunning/account-updater logic: src/subscriptions/*.ts and
// src/paymentMethods/applyAccountUpdate.ts. No Hatchet-equivalent
// worker existed in this Go port until Phase 7 (internal/worker) — see
// that package's doc comment for how these plain functions get
// scheduled. Every function here is a plain, synchronously-callable Go
// function with no framework dependency baked in, matching this port's
// standing convention (internal/webhooks, internal/ledger).
package subscriptions

import "time"

// IntervalUnit mirrors SubscriptionIntervalUnit exactly (the
// interval_unit CHECK constraint on the subscriptions table:
// 'day'|'week'|'month'|'year').
type IntervalUnit string

const (
	IntervalDay   IntervalUnit = "day"
	IntervalWeek  IntervalUnit = "week"
	IntervalMonth IntervalUnit = "month"
	IntervalYear  IntervalUnit = "year"
)

// AddInterval mirrors src/subscriptions/period.ts's addInterval exactly,
// including the month-end clamping addMonthsClamped performs (naive
// month addition on e.g. Jan 31 would otherwise roll into March 3rd
// rather than landing on "the last day of February" — clamped below).
// All arithmetic is performed in UTC, matching the TS source's exclusive
// use of the UTC* Date methods (setUTCDate/setUTCMonth/etc.) — never the
// local-timezone variants — so this function's result does not depend
// on the host process's TZ environment variable, exactly as the TS
// source's own choice does not depend on Node's local timezone either.
func AddInterval(t time.Time, unit IntervalUnit, count int) time.Time {
	t = t.UTC()
	switch unit {
	case IntervalDay:
		return t.AddDate(0, 0, count)
	case IntervalWeek:
		return t.AddDate(0, 0, count*7)
	case IntervalMonth:
		return addMonthsClamped(t, count)
	case IntervalYear:
		return addMonthsClamped(t, count*12)
	default:
		// Unknown unit: the TS source's switch has no default case and
		// TypeScript's exhaustiveness checking guarantees every real
		// SubscriptionIntervalUnit value is handled — Go has no
		// equivalent compile-time exhaustiveness check over a plain
		// string-based type, so an unknown value here returns t
		// unchanged (a safe, inert default) rather than panicking. This
		// should be unreachable given the DB's own CHECK constraint on
		// interval_unit.
		return t
	}
}

// addMonthsClamped mirrors addMonthsClamped exactly: set the day to 1
// first (avoiding month-length overflow while the month itself is
// adjusted), add the months, then clamp the original day-of-month to
// the target month's actual last day (Date.UTC(y, m+1, 0) in the TS
// source is "day 0 of month m+1", i.e. the last day of month m — Go's
// time.Date normalizes an equivalent out-of-range day the same way,
// used identically below).
func addMonthsClamped(t time.Time, months int) time.Time {
	originalDay := t.Day()

	// Step 1: pin to day 1 of the current month (in UTC) before adjusting
	// the month, mirroring result.setUTCDate(1) in the TS source.
	firstOfMonth := time.Date(t.Year(), t.Month(), 1, t.Hour(), t.Minute(), t.Second(), t.Nanosecond(), time.UTC)

	// Step 2: advance by `months` — time.Date normalizes an out-of-range
	// month (e.g. month 13) into the correct following year, exactly
	// mirroring setUTCMonth's own normalization behavior.
	targetMonthStart := firstOfMonth.AddDate(0, months, 0)

	// Step 3: the last day of targetMonthStart's month — "day 0 of the
	// NEXT month" in both the TS source (Date.UTC(y, m+1, 0)) and here
	// (time.Date(y, m+1, 0, ...), which Go normalizes to the last day of
	// month m).
	daysInTargetMonth := time.Date(
		targetMonthStart.Year(), targetMonthStart.Month()+1, 0,
		0, 0, 0, 0, time.UTC,
	).Day()

	clampedDay := originalDay
	if clampedDay > daysInTargetMonth {
		clampedDay = daysInTargetMonth
	}

	return time.Date(
		targetMonthStart.Year(), targetMonthStart.Month(), clampedDay,
		t.Hour(), t.Minute(), t.Second(), t.Nanosecond(), time.UTC,
	)
}
