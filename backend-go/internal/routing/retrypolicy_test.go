package routing

import (
	"regexp"
	"testing"
	"time"

	"github.com/alphapayments/payment-orchestrator/internal/domain"
)

func TestCanRetrySameInstrument(t *testing.T) {
	t.Run("refuses a hard (retryClass never) decline outright, regardless of attempt count", func(t *testing.T) {
		result := CanRetrySameInstrument(DeclineForRetryCheck(domain.RetryClassNever), 0, DefaultRetryPolicy)
		if result.Allowed {
			t.Fatal("expected refused")
		}
		if !regexp.MustCompile(`(?i)hard decline`).MatchString(result.Reason) {
			t.Fatalf("reason %q does not mention hard decline", result.Reason)
		}
	})

	t.Run(`refuses a "review" (unmapped) decline outright`, func(t *testing.T) {
		result := CanRetrySameInstrument(DeclineForRetryCheck(domain.RetryClassReview), 0, DefaultRetryPolicy)
		if result.Allowed {
			t.Fatal("expected refused")
		}
		if !regexp.MustCompile(`(?i)review`).MatchString(result.Reason) {
			t.Fatalf("reason %q does not mention review", result.Reason)
		}
	})

	t.Run("allows a retryable decline under the attempt cap", func(t *testing.T) {
		result := CanRetrySameInstrument(DeclineForRetryCheck(domain.RetryClassSameInstrumentLater), 1, DefaultRetryPolicy)
		if !result.Allowed {
			t.Fatalf("expected allowed, got refused: %s", result.Reason)
		}
	})

	t.Run("refuses a retryable decline once the attempt cap is reached", func(t *testing.T) {
		result := CanRetrySameInstrument(
			DeclineForRetryCheck(domain.RetryClassSameInstrumentLater),
			DefaultRetryPolicy.MaxAttemptsPerPayment,
			DefaultRetryPolicy,
		)
		if result.Allowed {
			t.Fatal("expected refused")
		}
		if !regexp.MustCompile(`(?i)max attempts`).MatchString(result.Reason) {
			t.Fatalf("reason %q does not mention max attempts", result.Reason)
		}
	})

	t.Run("a hard decline is refused even with zero prior attempts and plenty of budget left", func(t *testing.T) {
		// Guards against a bug where the attempt-cap check runs first and
		// masks the hard-decline check.
		result := CanRetrySameInstrument(DeclineForRetryCheck(domain.RetryClassNever), 0, RetryPolicyConfig{
			MaxAttemptsPerPayment: 100,
			MinSpacing:            0,
		})
		if result.Allowed {
			t.Fatal("expected refused")
		}
	})

	t.Run("the 4th attempt (attemptsSoFar == 3) is refused under the default policy", func(t *testing.T) {
		result := CanRetrySameInstrument(DeclineForRetryCheck(domain.RetryClassSameInstrumentLater), 3, DefaultRetryPolicy)
		if result.Allowed {
			t.Fatal("expected the 4th attempt to be refused (max 3 per payment)")
		}
	})

	t.Run("retry_after_challenge and retry_different_psp are retryable (subject to the attempt cap)", func(t *testing.T) {
		if !CanRetrySameInstrument(DeclineForRetryCheck(domain.RetryClassRetryAfterChallenge), 0, DefaultRetryPolicy).Allowed {
			t.Fatal("expected retry_after_challenge to be retryable")
		}
		if !CanRetrySameInstrument(DeclineForRetryCheck(domain.RetryClassRetryDifferentPSP), 0, DefaultRetryPolicy).Allowed {
			t.Fatal("expected retry_different_psp to be retryable")
		}
	})
}

func TestHasSufficientSpacing(t *testing.T) {
	t.Run("is false immediately after the last attempt", func(t *testing.T) {
		now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
		if HasSufficientSpacing(now, now, DefaultRetryPolicy) {
			t.Fatal("expected insufficient spacing")
		}
	})

	t.Run("is true once minSpacing has elapsed", func(t *testing.T) {
		last := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
		now := last.Add(DefaultRetryPolicy.MinSpacing)
		if !HasSufficientSpacing(last, now, DefaultRetryPolicy) {
			t.Fatal("expected sufficient spacing")
		}
	})

	t.Run("is false one millisecond before minSpacing has elapsed", func(t *testing.T) {
		last := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
		now := last.Add(DefaultRetryPolicy.MinSpacing - time.Millisecond)
		if HasSufficientSpacing(last, now, DefaultRetryPolicy) {
			t.Fatal("expected insufficient spacing")
		}
	})
}
