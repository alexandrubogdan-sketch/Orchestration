// Package domain contains the core payment-orchestration domain types:
// Money, the payment state machine, and the decline taxonomy. This
// package has no I/O and no external dependencies — it is pure logic,
// ported 1:1 from the TypeScript reference implementation's
// src/domain/*.ts files.
package domain

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// InvalidMoneyError is the Go analogue of the TS InvalidMoneyError class.
// It is returned (never panicked) by every Money constructor/operation
// that detects an invalid input, per Non-negotiable #1: "Money is
// integers. All amounts are integer minor units + ISO 4217 currency
// code. Any float in a money path is a bug."
type InvalidMoneyError struct {
	Message string
}

func (e *InvalidMoneyError) Error() string {
	return e.Message
}

func newInvalidMoneyError(format string, args ...any) *InvalidMoneyError {
	return &InvalidMoneyError{Message: fmt.Sprintf(format, args...)}
}

// Money is a branded amount: integer minor units + a normalized
// (uppercase) ISO 4217 currency code. Its fields are unexported so a
// Money value can never be constructed outside this package except via
// MakeMoney / FromDecimalString — the Go idiom for the TS version's
// `Symbol`-branded interface, which likewise makes it impossible to
// fabricate a Money value without going through makeMoney().
//
// Note on integer-safety: the TS constructor must explicitly reject
// non-integers, NaN, and Infinity (`Number.isInteger` /
// `Number.isSafeInteger`) because JS's `number` type is a float64 that
// can hold all of those. In Go, MakeMoney's minorUnits parameter is
// declared as int64, so "must be an integer" and "must be within
// int64's representable range" are structural guarantees enforced by
// the type system at compile time — there is no float/NaN/Infinity
// value that can ever reach this function as an int64. This is the
// Go-idiomatic equivalent of those TS runtime checks, not a gap: it is
// simply impossible to construct a non-integer, NaN, or Infinity int64.
type Money struct {
	minorUnits int64
	currency   string
}

// MinorUnits returns the integer minor-units amount.
func (m Money) MinorUnits() int64 { return m.minorUnits }

// Currency returns the normalized (uppercase) ISO 4217 currency code.
func (m Money) Currency() string { return m.currency }

// KnownCurrencies mirrors the TS KNOWN_CURRENCIES set: not exhaustive of
// ISO 4217, but covers every currency this codebase's PSPs (Stripe
// first) are likely to process at launch. Extend deliberately.
var KnownCurrencies = map[string]struct{}{
	"USD": {}, "EUR": {}, "GBP": {}, "CAD": {}, "AUD": {},
	"JPY": {}, "CHF": {}, "SEK": {}, "NOK": {}, "DKK": {},
	"PLN": {}, "CZK": {}, "BRL": {}, "MXN": {}, "INR": {},
	"SGD": {}, "HKD": {}, "NZD": {}, "ZAR": {}, "AED": {},
}

// ZeroDecimalCurrencies mirrors the TS ZERO_DECIMAL_CURRENCIES set.
// Minor units ARE the whole unit for these currencies — JPY 100 means
// ¥100, not ¥1.00.
var ZeroDecimalCurrencies = map[string]struct{}{
	"JPY": {}, "KRW": {}, "VND": {}, "CLP": {}, "ISK": {}, "HUF": {},
}

// IsZeroDecimalCurrency reports whether currency (case-insensitive) is
// a zero-decimal currency.
func IsZeroDecimalCurrency(currency string) bool {
	_, ok := ZeroDecimalCurrencies[strings.ToUpper(currency)]
	return ok
}

var currencyCodePattern = regexp.MustCompile(`^[A-Z]{3}$`)

// MakeMoney is the one constructor for Money. It validates:
//   - minorUnits is non-negative (refunds/adjustments are modeled as
//     separate signed ledger entries, not negative Money — see the
//     ledger package, a later phase).
//   - currency is a recognized 3-letter uppercase ISO 4217 code.
//
// (minorUnits being an integer at all is guaranteed by its int64 type —
// see the Money doc comment.)
func MakeMoney(minorUnits int64, currency string) (Money, error) {
	if minorUnits < 0 {
		return Money{}, newInvalidMoneyError("Money.minorUnits must be non-negative, got %d", minorUnits)
	}
	normalizedCurrency := strings.ToUpper(currency)
	if !currencyCodePattern.MatchString(normalizedCurrency) {
		return Money{}, newInvalidMoneyError("Currency must be a 3-letter ISO 4217 code, got %s", currency)
	}
	if _, ok := KnownCurrencies[normalizedCurrency]; !ok {
		return Money{}, newInvalidMoneyError(
			"Currency %s is not in the known-currency list (internal/domain/money.go). "+
				"Add it deliberately rather than silently accepting unrecognized codes.",
			normalizedCurrency,
		)
	}
	return Money{minorUnits: minorUnits, currency: normalizedCurrency}, nil
}

var decimalStringPattern = regexp.MustCompile(`^-?\d+(\.\d+)?$`)

// FromDecimalString is the ONE sanctioned place a decimal string (e.g.
// "19.99") is allowed to enter the system as Money. It never goes
// through float64 — parsing and scaling are done with integer
// arithmetic only, matching the TS fromDecimalString's "no float
// rounding error" guarantee (achieved there by taking a string, not a
// number, as input; achieved here by never using a float type at all).
func FromDecimalString(decimal string, currency string) (Money, error) {
	trimmed := strings.TrimSpace(decimal)
	if !decimalStringPattern.MatchString(trimmed) {
		return Money{}, newInvalidMoneyError(`fromDecimalString: "%s" is not a plain decimal string`, decimal)
	}

	negative := strings.HasPrefix(trimmed, "-")
	unsigned := trimmed
	if negative {
		unsigned = trimmed[1:]
	}

	wholePart := unsigned
	fractionPart := ""
	if idx := strings.IndexByte(unsigned, '.'); idx >= 0 {
		wholePart = unsigned[:idx]
		fractionPart = unsigned[idx+1:]
	}

	zeroDecimal := IsZeroDecimalCurrency(currency)

	if zeroDecimal {
		if strings.Trim(fractionPart, "0") != "" {
			return Money{}, newInvalidMoneyError(
				"fromDecimalString: %s is zero-decimal but \"%s\" has a fractional part", currency, decimal,
			)
		}
		whole, err := strconv.ParseInt(wholePart, 10, 64)
		if err != nil {
			return Money{}, newInvalidMoneyError(`fromDecimalString: "%s" is not a plain decimal string`, decimal)
		}
		if negative {
			whole = -whole
		}
		return MakeMoney(whole, currency)
	}

	paddedFraction := (fractionPart + "00")[:2]
	whole, err := strconv.ParseInt(wholePart, 10, 64)
	if err != nil {
		return Money{}, newInvalidMoneyError(`fromDecimalString: "%s" is not a plain decimal string`, decimal)
	}
	fraction, err := strconv.ParseInt(paddedFraction, 10, 64)
	if err != nil {
		return Money{}, newInvalidMoneyError(`fromDecimalString: "%s" is not a plain decimal string`, decimal)
	}
	minorUnits := whole*100 + fraction
	if negative {
		minorUnits = -minorUnits
	}
	return MakeMoney(minorUnits, currency)
}

func assertSameCurrency(a, b Money) error {
	if a.currency != b.currency {
		return newInvalidMoneyError("Currency mismatch: %s vs %s", a.currency, b.currency)
	}
	return nil
}

// Add sums two same-currency Money values.
func Add(a, b Money) (Money, error) {
	if err := assertSameCurrency(a, b); err != nil {
		return Money{}, err
	}
	return MakeMoney(a.minorUnits+b.minorUnits, a.currency)
}

// Subtract computes a - b. It is intentionally the only place a
// "negative" outcome is even possible, and it errors rather than
// returning a negative Money (Money is always non-negative — see
// MakeMoney). Model refunds/credits as their own ledger entries with
// their own sign semantics (a later phase), not as negative Money.
func Subtract(a, b Money) (Money, error) {
	if err := assertSameCurrency(a, b); err != nil {
		return Money{}, err
	}
	if b.minorUnits > a.minorUnits {
		return Money{}, newInvalidMoneyError(
			"subtract() would produce a negative amount: %d - %d", a.minorUnits, b.minorUnits,
		)
	}
	return MakeMoney(a.minorUnits-b.minorUnits, a.currency)
}

// MultiplyByInt multiplies Money by an integer factor only (e.g.
// quantity) — never a float. (Go's type system already forbids passing
// a float here; factor is declared int64.)
func MultiplyByInt(a Money, factor int64) (Money, error) {
	return MakeMoney(a.minorUnits*factor, a.currency)
}

// Allocate splits total into len(weights) non-negative integer shares
// that sum exactly back to total.MinorUnits() — the standard "largest
// remainder to last share" allocation algorithm, so proportional splits
// never lose or fabricate a minor unit to floating-point rounding.
func Allocate(total Money, weights []int64) ([]Money, error) {
	if len(weights) == 0 {
		return nil, newInvalidMoneyError("allocate() requires at least one weight")
	}
	var totalWeight int64
	for _, w := range weights {
		if w < 0 {
			return nil, newInvalidMoneyError("allocate() weights must be non-negative integers")
		}
		totalWeight += w
	}
	if totalWeight == 0 {
		return nil, newInvalidMoneyError("allocate() requires at least one non-zero weight")
	}

	remaining := total.minorUnits
	shares := make([]int64, len(weights))
	for i, weight := range weights {
		isLast := i == len(weights)-1
		var share int64
		if isLast {
			share = remaining
		} else {
			share = (total.minorUnits * weight) / totalWeight
		}
		shares[i] = share
		remaining -= share
	}

	results := make([]Money, len(shares))
	for i, share := range shares {
		m, err := MakeMoney(share, total.currency)
		if err != nil {
			return nil, err
		}
		results[i] = m
	}
	return results, nil
}

// IsZero reports whether a is zero minor units.
func IsZero(a Money) bool {
	return a.minorUnits == 0
}

// Equals reports whether a and b have the same currency and minor
// units. Unlike Add/Subtract/IsGreaterThan/IsLessThan, Equals does NOT
// error on currency mismatch — it simply returns false, matching the
// TS equals().
func Equals(a, b Money) bool {
	return a.currency == b.currency && a.minorUnits == b.minorUnits
}

// IsGreaterThan reports whether a > b. Errors on currency mismatch.
func IsGreaterThan(a, b Money) (bool, error) {
	if err := assertSameCurrency(a, b); err != nil {
		return false, err
	}
	return a.minorUnits > b.minorUnits, nil
}

// IsLessThan reports whether a < b. Errors on currency mismatch.
func IsLessThan(a, b Money) (bool, error) {
	if err := assertSameCurrency(a, b); err != nil {
		return false, err
	}
	return a.minorUnits < b.minorUnits, nil
}

// ToDisplayString renders Money for display only (dashboards/logs) —
// never parsed back. Zero-decimal currencies print as "{minorUnits}
// {currency}"; others print as "{whole}.{fraction:02d} {currency}",
// using integer division/modulo only, matching the TS's
// Math.trunc()/Math.abs(...% 100) behavior exactly.
func ToDisplayString(m Money) string {
	if IsZeroDecimalCurrency(m.currency) {
		return fmt.Sprintf("%d %s", m.minorUnits, m.currency)
	}
	whole := m.minorUnits / 100 // Go's integer division truncates toward zero, matching Math.trunc.
	fraction := m.minorUnits % 100
	if fraction < 0 {
		fraction = -fraction
	}
	return fmt.Sprintf("%d.%02d %s", whole, fraction, m.currency)
}
