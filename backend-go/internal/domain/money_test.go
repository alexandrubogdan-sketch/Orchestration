package domain

import (
	"math"
	"math/rand"
	"testing"
)

func TestMakeMoney_AcceptsValidAmount(t *testing.T) {
	m, err := MakeMoney(1999, "USD")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if m.MinorUnits() != 1999 {
		t.Errorf("MinorUnits() = %d, want 1999", m.MinorUnits())
	}
	if m.Currency() != "USD" {
		t.Errorf("Currency() = %s, want USD", m.Currency())
	}
}

func TestMakeMoney_NormalizesCurrencyToUppercase(t *testing.T) {
	m, err := MakeMoney(100, "usd")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if m.Currency() != "USD" {
		t.Errorf("Currency() = %s, want USD", m.Currency())
	}
}

func TestMakeMoney_RejectsNegativeAmounts(t *testing.T) {
	if _, err := MakeMoney(-100, "USD"); err == nil {
		t.Error("expected error for negative amount")
	} else if _, ok := err.(*InvalidMoneyError); !ok {
		t.Errorf("expected *InvalidMoneyError, got %T", err)
	}
}

func TestMakeMoney_RejectsUnrecognizedCurrencyCodes(t *testing.T) {
	for _, currency := range []string{"ZZZ", "US", "DOLLARS"} {
		if _, err := MakeMoney(100, currency); err == nil {
			t.Errorf("expected error for currency %q", currency)
		}
	}
}

// Go's int64 cannot hold a value beyond int64's own range by
// construction, so there is no equivalent of the TS
// "beyond Number.MAX_SAFE_INTEGER" test to port — that entire failure
// mode does not exist for an int64 parameter. See the Money doc comment
// in money.go.

func TestFromDecimalString_ConvertsToMinorUnits(t *testing.T) {
	cases := []struct {
		decimal  string
		currency string
		want     int64
	}{
		{"19.99", "USD", 1999},
		{"5", "USD", 500},
		{"0.01", "USD", 1},
	}
	for _, tc := range cases {
		m, err := FromDecimalString(tc.decimal, tc.currency)
		if err != nil {
			t.Fatalf("FromDecimalString(%q, %q) error: %v", tc.decimal, tc.currency, err)
		}
		if m.MinorUnits() != tc.want {
			t.Errorf("FromDecimalString(%q, %q).MinorUnits() = %d, want %d", tc.decimal, tc.currency, m.MinorUnits(), tc.want)
		}
	}
}

func TestFromDecimalString_ZeroDecimalCurrency(t *testing.T) {
	m, err := FromDecimalString("500", "JPY")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if m.MinorUnits() != 500 {
		t.Errorf("MinorUnits() = %d, want 500", m.MinorUnits())
	}
	if !IsZeroDecimalCurrency("JPY") {
		t.Error("expected JPY to be zero-decimal")
	}
}

func TestFromDecimalString_RejectsFractionalZeroDecimalCurrency(t *testing.T) {
	if _, err := FromDecimalString("500.50", "JPY"); err == nil {
		t.Error("expected error for fractional JPY amount")
	}
}

func TestFromDecimalString_RejectsMalformedStrings(t *testing.T) {
	for _, bad := range []string{"nineteen ninety nine", "19.99.99"} {
		if _, err := FromDecimalString(bad, "USD"); err == nil {
			t.Errorf("expected error for malformed decimal %q", bad)
		}
	}
}

func TestAdd_SumsSameCurrencyAmounts(t *testing.T) {
	a, _ := MakeMoney(500, "USD")
	b, _ := MakeMoney(250, "USD")
	result, err := Add(a, b)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.MinorUnits() != 750 {
		t.Errorf("Add() = %d, want 750", result.MinorUnits())
	}
}

func TestAdd_RejectsMismatchedCurrencies(t *testing.T) {
	a, _ := MakeMoney(500, "USD")
	b, _ := MakeMoney(250, "EUR")
	if _, err := Add(a, b); err == nil {
		t.Error("expected currency-mismatch error")
	}
}

func TestSubtract_ComputesDifference(t *testing.T) {
	a, _ := MakeMoney(500, "USD")
	b, _ := MakeMoney(200, "USD")
	result, err := Subtract(a, b)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.MinorUnits() != 300 {
		t.Errorf("Subtract() = %d, want 300", result.MinorUnits())
	}
}

func TestSubtract_ThrowsRatherThanNegative(t *testing.T) {
	a, _ := MakeMoney(100, "USD")
	b, _ := MakeMoney(200, "USD")
	if _, err := Subtract(a, b); err == nil {
		t.Error("expected error rather than negative Money")
	}
}

func TestMultiplyByInt_ScalesByFactor(t *testing.T) {
	a, _ := MakeMoney(300, "USD")
	result, err := MultiplyByInt(a, 3)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.MinorUnits() != 900 {
		t.Errorf("MultiplyByInt() = %d, want 900", result.MinorUnits())
	}
}

// MultiplyByInt's factor parameter is int64 in Go, so "rejects a
// fractional factor" (the TS test) has no possible input to port —
// the type system rejects it at compile time instead of at runtime.

func TestComparisonsAndEquality(t *testing.T) {
	a, _ := MakeMoney(500, "USD")
	b, _ := MakeMoney(100, "USD")
	c, _ := MakeMoney(500, "USD")
	zero, _ := MakeMoney(0, "USD")

	if gt, err := IsGreaterThan(a, b); err != nil || !gt {
		t.Errorf("IsGreaterThan(500, 100) = %v, %v; want true, nil", gt, err)
	}
	if lt, err := IsLessThan(b, a); err != nil || !lt {
		t.Errorf("IsLessThan(100, 500) = %v, %v; want true, nil", lt, err)
	}
	if !Equals(a, c) {
		t.Error("Equals(500 USD, 500 USD) = false, want true")
	}
	if !IsZero(zero) {
		t.Error("IsZero(0 USD) = false, want true")
	}
}

func TestAllocate_SplitsProportionally(t *testing.T) {
	total, _ := MakeMoney(100, "USD")
	shares, err := Allocate(total, []int64{1, 1, 1})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	var sum int64
	got := make([]int64, len(shares))
	for i, s := range shares {
		sum += s.MinorUnits()
		got[i] = s.MinorUnits()
	}
	if sum != 100 {
		t.Errorf("sum of shares = %d, want 100", sum)
	}
	want := []int64{33, 33, 34}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("shares[%d] = %d, want %d", i, got[i], want[i])
		}
	}
}

func TestAllocate_SplitsEvenlyWhenClean(t *testing.T) {
	total, _ := MakeMoney(1000, "USD")
	shares, err := Allocate(total, []int64{50, 50})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if shares[0].MinorUnits() != 500 || shares[1].MinorUnits() != 500 {
		t.Errorf("shares = %v, want [500, 500]", shares)
	}
}

func TestAllocate_SingleWeight(t *testing.T) {
	total, _ := MakeMoney(999, "USD")
	shares, err := Allocate(total, []int64{100})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(shares) != 1 {
		t.Fatalf("len(shares) = %d, want 1", len(shares))
	}
	if shares[0].MinorUnits() != 999 {
		t.Errorf("shares[0] = %d, want 999", shares[0].MinorUnits())
	}
}

func TestAllocate_RejectsAllZeroWeights(t *testing.T) {
	total, _ := MakeMoney(100, "USD")
	if _, err := Allocate(total, []int64{0, 0}); err == nil {
		t.Error("expected error for all-zero weights")
	}
}

func TestAllocate_RejectsEmptyWeights(t *testing.T) {
	total, _ := MakeMoney(100, "USD")
	if _, err := Allocate(total, []int64{}); err == nil {
		t.Error("expected error for empty weights")
	}
}

func TestAllocate_RejectsNegativeWeights(t *testing.T) {
	total, _ := MakeMoney(100, "USD")
	if _, err := Allocate(total, []int64{1, -1}); err == nil {
		t.Error("expected error for negative weight")
	}
}

// Property-style exhaustive check: for many random weight sets, the
// shares must always sum back to the original total exactly. Direct
// port of the TS 200-trial ad hoc loop in test/unit/money.test.ts.
func TestAllocate_AlwaysSumsBackToOriginalAmount(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	for trial := 0; trial < 200; trial++ {
		totalMinor := int64(rng.Intn(100_000) + 1)
		weightCount := rng.Intn(5) + 1
		weights := make([]int64, weightCount)
		for i := range weights {
			weights[i] = int64(rng.Intn(10) + 1)
		}
		total, err := MakeMoney(totalMinor, "USD")
		if err != nil {
			t.Fatalf("MakeMoney error: %v", err)
		}
		shares, err := Allocate(total, weights)
		if err != nil {
			t.Fatalf("Allocate error: %v", err)
		}
		var summed int64
		for _, s := range shares {
			if s.MinorUnits() < 0 {
				t.Fatalf("share is negative: %d", s.MinorUnits())
			}
			summed += s.MinorUnits()
		}
		if summed != totalMinor {
			t.Fatalf("trial %d: summed = %d, want %d (weights=%v)", trial, summed, totalMinor, weights)
		}
	}
}

func TestToDisplayString_StandardCurrencies(t *testing.T) {
	m1, _ := MakeMoney(1999, "USD")
	if got := ToDisplayString(m1); got != "19.99 USD" {
		t.Errorf("ToDisplayString(1999 USD) = %q, want %q", got, "19.99 USD")
	}
	m2, _ := MakeMoney(5, "USD")
	if got := ToDisplayString(m2); got != "0.05 USD" {
		t.Errorf("ToDisplayString(5 USD) = %q, want %q", got, "0.05 USD")
	}
}

func TestToDisplayString_ZeroDecimalCurrencies(t *testing.T) {
	m, _ := MakeMoney(500, "JPY")
	if got := ToDisplayString(m); got != "500 JPY" {
		t.Errorf("ToDisplayString(500 JPY) = %q, want %q", got, "500 JPY")
	}
}

// Regression test for the backend review's confirmed silent-truncation
// bug (2026-07-10): FromDecimalString must now REJECT a fraction with
// genuine precision beyond 2 digits instead of quietly discarding it.
func TestFromDecimalString_RejectsExcessFractionalPrecision(t *testing.T) {
	for _, bad := range []string{"19.999", "0.001", "-5.123"} {
		if _, err := FromDecimalString(bad, "USD"); err == nil {
			t.Errorf("expected error for %q (more than 2 significant fractional digits), got none", bad)
		} else if _, ok := err.(*InvalidMoneyError); !ok {
			t.Errorf("expected *InvalidMoneyError for %q, got %T", bad, err)
		}
	}
}

// A fraction longer than 2 digits that is exactly representable in 2
// digits (every digit past position 2 is zero) loses no real precision
// and must still be accepted — the fix targets ACTUAL precision loss,
// not merely "more than 2 characters after the decimal point".
func TestFromDecimalString_AcceptsTrailingZeroFraction(t *testing.T) {
	m, err := FromDecimalString("19.990", "USD")
	if err != nil {
		t.Fatalf("unexpected error for a trailing-zero fraction: %v", err)
	}
	if m.MinorUnits() != 1999 {
		t.Errorf("MinorUnits() = %d, want 1999", m.MinorUnits())
	}
}

// Regression tests for the backend review's confirmed missing-overflow-
// guard bug (2026-07-10): Add, MultiplyByInt, and Allocate must all
// reject an operation that would overflow int64 rather than silently
// wrapping around to an incorrect (and, for multiplication, potentially
// plausible-looking positive) amount.
func TestAdd_RejectsOverflow(t *testing.T) {
	a, _ := MakeMoney(math.MaxInt64-1, "USD")
	b, _ := MakeMoney(2, "USD")
	if _, err := Add(a, b); err == nil {
		t.Error("expected overflow error, got none")
	} else if _, ok := err.(*InvalidMoneyError); !ok {
		t.Errorf("expected *InvalidMoneyError, got %T", err)
	}
}

func TestMultiplyByInt_RejectsOverflow(t *testing.T) {
	a, _ := MakeMoney(math.MaxInt64/2, "USD")
	if _, err := MultiplyByInt(a, 3); err == nil {
		t.Error("expected overflow error, got none")
	} else if _, ok := err.(*InvalidMoneyError); !ok {
		t.Errorf("expected *InvalidMoneyError, got %T", err)
	}
}

func TestMultiplyByInt_ZeroFactorNeverOverflows(t *testing.T) {
	a, _ := MakeMoney(math.MaxInt64, "USD")
	result, err := MultiplyByInt(a, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.MinorUnits() != 0 {
		t.Errorf("MinorUnits() = %d, want 0", result.MinorUnits())
	}
}

func TestAllocate_RejectsWeightSumOverflow(t *testing.T) {
	total, _ := MakeMoney(100, "USD")
	if _, err := Allocate(total, []int64{math.MaxInt64 - 1, 2}); err == nil {
		t.Error("expected overflow error for weights summing beyond int64, got none")
	} else if _, ok := err.(*InvalidMoneyError); !ok {
		t.Errorf("expected *InvalidMoneyError, got %T", err)
	}
}

func TestAllocate_RejectsShareMultiplicationOverflow(t *testing.T) {
	total, _ := MakeMoney(math.MaxInt64/2, "USD")
	if _, err := Allocate(total, []int64{3, 1}); err == nil {
		t.Error("expected overflow error for total*weight exceeding int64, got none")
	} else if _, ok := err.(*InvalidMoneyError); !ok {
		t.Errorf("expected *InvalidMoneyError, got %T", err)
	}
}
