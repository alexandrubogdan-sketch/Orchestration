package subscriptions

import "testing"

// TestSubscriptionNotFoundError_Message pins the exact error message
// shape (used verbatim in logs/alerts) to guard against an accidental
// wording change going unnoticed.
func TestSubscriptionNotFoundError_Message(t *testing.T) {
	err := &SubscriptionNotFoundError{SubscriptionID: "sub_123"}
	want := "Subscription sub_123 not found"
	if err.Error() != want {
		t.Errorf("Error() = %q, want %q", err.Error(), want)
	}
}

// TestIntervalUnit_Constants guards the exact string values the
// interval_unit CHECK constraint
// (db/migrations/1735777000000_subscriptions.up.sql) allows — a typo in
// any one of these four would compile fine but silently violate that
// CHECK constraint at INSERT/UPDATE time against a live Postgres.
func TestIntervalUnit_Constants(t *testing.T) {
	cases := map[IntervalUnit]string{
		IntervalDay:   "day",
		IntervalWeek:  "week",
		IntervalMonth: "month",
		IntervalYear:  "year",
	}
	for unit, want := range cases {
		if string(unit) != want {
			t.Errorf("IntervalUnit constant = %q, want %q", string(unit), want)
		}
	}
}
