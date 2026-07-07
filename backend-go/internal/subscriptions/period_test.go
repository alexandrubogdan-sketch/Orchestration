package subscriptions

import (
	"testing"
	"time"
)

func mustUTC(year int, month time.Month, day, hour, min, sec int) time.Time {
	return time.Date(year, month, day, hour, min, sec, 0, time.UTC)
}

// TestAddInterval_Day/Week are the straightforward cases — no clamping
// involved, just a plain calendar-day/week shift.
func TestAddInterval_Day(t *testing.T) {
	got := AddInterval(mustUTC(2026, time.July, 7, 10, 0, 0), IntervalDay, 1)
	want := mustUTC(2026, time.July, 8, 10, 0, 0)
	if !got.Equal(want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestAddInterval_Week(t *testing.T) {
	got := AddInterval(mustUTC(2026, time.July, 7, 10, 0, 0), IntervalWeek, 2)
	want := mustUTC(2026, time.July, 21, 10, 0, 0)
	if !got.Equal(want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

// TestAddInterval_Month_NoClampingNeeded is the common case: a
// same-day-of-month shift with no month-length overflow.
func TestAddInterval_Month_NoClampingNeeded(t *testing.T) {
	got := AddInterval(mustUTC(2026, time.March, 15, 0, 0, 0), IntervalMonth, 1)
	want := mustUTC(2026, time.April, 15, 0, 0, 0)
	if !got.Equal(want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

// TestAddInterval_Month_Jan31ToFeb_ClampsToFeb28 is THE canonical
// month-end clamping case this whole file's doc comment calls out —
// Jan 31 + 1 month must land on Feb 28 (2026 is not a leap year), NOT
// roll over into March 3rd the way naive Date.setMonth/AddDate-without-
// clamping arithmetic would.
func TestAddInterval_Month_Jan31ToFeb_ClampsToFeb28(t *testing.T) {
	got := AddInterval(mustUTC(2026, time.January, 31, 9, 30, 0), IntervalMonth, 1)
	want := mustUTC(2026, time.February, 28, 9, 30, 0)
	if !got.Equal(want) {
		t.Errorf("Jan 31 + 1 month = %v, want %v (clamped to Feb 28, NOT rolled into March)", got, want)
	}
}

// TestAddInterval_Month_Jan31ToFeb_LeapYear_ClampsToFeb29 is the same
// case in a leap year — 2028 has a Feb 29, so the clamp target moves.
func TestAddInterval_Month_Jan31ToFeb_LeapYear_ClampsToFeb29(t *testing.T) {
	got := AddInterval(mustUTC(2028, time.January, 31, 0, 0, 0), IntervalMonth, 1)
	want := mustUTC(2028, time.February, 29, 0, 0, 0)
	if !got.Equal(want) {
		t.Errorf("Jan 31 2028 (leap year) + 1 month = %v, want %v", got, want)
	}
}

// TestAddInterval_Month_Mar31ToApr_ClampsToApr30 covers a 31-to-30-day
// month transition outside of February, guarding against a clamp
// implementation that only special-cases February.
func TestAddInterval_Month_Mar31ToApr_ClampsToApr30(t *testing.T) {
	got := AddInterval(mustUTC(2026, time.March, 31, 0, 0, 0), IntervalMonth, 1)
	want := mustUTC(2026, time.April, 30, 0, 0, 0)
	if !got.Equal(want) {
		t.Errorf("Mar 31 + 1 month = %v, want %v", got, want)
	}
}

// TestAddInterval_Month_MultipleMonthsAcrossYearBoundary exercises the
// months-normalization path (month index rolling past December into
// the next year) combined with a same-day, no-clamp shift.
func TestAddInterval_Month_MultipleMonthsAcrossYearBoundary(t *testing.T) {
	got := AddInterval(mustUTC(2026, time.November, 15, 0, 0, 0), IntervalMonth, 3)
	want := mustUTC(2027, time.February, 15, 0, 0, 0)
	if !got.Equal(want) {
		t.Errorf("Nov 15 2026 + 3 months = %v, want %v", got, want)
	}
}

// TestAddInterval_Year_ClampsFeb29InNonLeapTarget covers the Year unit
// (implemented as addMonthsClamped(t, count*12)) landing a Feb 29
// anchor on a non-leap target year.
func TestAddInterval_Year_ClampsFeb29InNonLeapTarget(t *testing.T) {
	got := AddInterval(mustUTC(2028, time.February, 29, 0, 0, 0), IntervalYear, 1)
	want := mustUTC(2029, time.February, 28, 0, 0, 0)
	if !got.Equal(want) {
		t.Errorf("Feb 29 2028 + 1 year = %v, want %v (clamped to Feb 28, 2029 is not a leap year)", got, want)
	}
}

// TestAddInterval_Year_NoClampingNeeded is the common case.
func TestAddInterval_Year_NoClampingNeeded(t *testing.T) {
	got := AddInterval(mustUTC(2026, time.July, 7, 0, 0, 0), IntervalYear, 1)
	want := mustUTC(2027, time.July, 7, 0, 0, 0)
	if !got.Equal(want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

// TestAddInterval_PreservesUTCTimeOfDay guards against a clamping
// implementation that accidentally zeroes out the hour/minute/second
// components while reconstructing the clamped date.
func TestAddInterval_PreservesUTCTimeOfDay(t *testing.T) {
	got := AddInterval(mustUTC(2026, time.January, 31, 14, 27, 53), IntervalMonth, 1)
	if got.Hour() != 14 || got.Minute() != 27 || got.Second() != 53 {
		t.Errorf("time-of-day not preserved: got %02d:%02d:%02d, want 14:27:53", got.Hour(), got.Minute(), got.Second())
	}
}

// TestAddInterval_NonUTCInputIsNormalizedToUTC guards the "all
// arithmetic in UTC regardless of input timezone" doc-commented
// guarantee — a non-UTC input's wall-clock UTC-equivalent value must
// drive the result, not the input's original zone offset silently
// leaking through.
func TestAddInterval_NonUTCInputIsNormalizedToUTC(t *testing.T) {
	loc := time.FixedZone("UTC+5", 5*60*60)
	input := time.Date(2026, time.January, 31, 14, 0, 0, 0, loc) // = 09:00 UTC
	got := AddInterval(input, IntervalDay, 1)
	want := mustUTC(2026, time.February, 1, 9, 0, 0)
	if !got.Equal(want) {
		t.Errorf("got %v, want %v (UTC-normalized)", got, want)
	}
	if got.Location() != time.UTC {
		t.Errorf("result location = %v, want time.UTC", got.Location())
	}
}
