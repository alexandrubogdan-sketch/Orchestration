package routing

import (
	"fmt"
	"time"

	"github.com/alphapayments/payment-orchestrator/internal/domain"
)

// This file is the Go port of T5.4's central retry-policy config
// (src/routing/retryPolicy.ts) -- one place every retry path (same-
// session retries today; a later dunning-ladder phase's retries later)
// must consult before scheduling another attempt on the SAME
// instrument. This governs same-instrument retries only. Cross-PSP
// failover for `technical` failures is a completely separate decision,
// governed by domain.IsEligibleForPspFailover and the CircuitBreaker
// (circuitbreaker.go) -- a hard decline can still legitimately cause a
// routing failover attempt on a *different* instrument or a customer
// retry with a *different* card; what this file refuses is ever
// re-trying the exact same card against a hard/fraud/review decline.

// RetryPolicyConfig mirrors RetryPolicyConfig.
type RetryPolicyConfig struct {
	// MaxAttemptsPerPayment is the maximum total attempts (including
	// the first) for a single payment.
	MaxAttemptsPerPayment int
	// MinSpacing is the minimum spacing between attempts on the same
	// payment.
	MinSpacing time.Duration
}

// DefaultRetryPolicy mirrors RETRY_POLICY exactly: 3 max attempts per
// payment, 2 second minimum spacing.
var DefaultRetryPolicy = RetryPolicyConfig{
	MaxAttemptsPerPayment: 3,
	MinSpacing:            2 * time.Second,
}

// RetryDecision mirrors RetryDecision.
type RetryDecision struct {
	Allowed bool
	Reason  string
}

// declineForRetryCheck is the minimal shape CanRetrySameInstrument
// needs about a decline -- mirroring the TS signature's
// `Pick<NormalizedDecline, 'retryClass'>` parameter type exactly
// (only RetryClass is read; the caller does not need to construct a
// full domain.NormalizedDecline just to ask this question).
type declineForRetryCheck struct {
	RetryClass domain.DeclineRetryClass
}

// DeclineForRetryCheck constructs the minimal input
// CanRetrySameInstrument needs from just a retry class -- exported
// convenience constructor so callers holding a domain.NormalizedDecline
// don't need to know about this package's internal narrow-input type;
// see CanRetrySameInstrument's signature for why this parameter type
// exists at all instead of taking a bare domain.DeclineRetryClass.
func DeclineForRetryCheck(retryClass domain.DeclineRetryClass) declineForRetryCheck {
	return declineForRetryCheck{RetryClass: retryClass}
}

// CanRetrySameInstrument mirrors canRetrySameInstrument exactly,
// including its exact branch order (hard decline check FIRST, then
// review-class check, then the attempt-cap check) -- this ordering is
// load-bearing: the TS test suite has an explicit case
// ("a hard decline is refused even with zero prior attempts and plenty
// of budget left") specifically guarding against a bug where the
// attempt-cap check runs first and masks the hard-decline check. This
// Go port preserves that exact order for the same reason and ports
// that exact test case (see retrypolicy_test.go).
//
// attemptsSoFar counts attempts already made (i.e. before the one
// being considered) -- passing attemptsSoFar == config.MaxAttemptsPerPayment
// means the payment has already used its full budget.
func CanRetrySameInstrument(decline declineForRetryCheck, attemptsSoFar int, config RetryPolicyConfig) RetryDecision {
	if domain.IsHardDecline(decline.RetryClass) {
		return RetryDecision{Allowed: false, Reason: "hard decline: never retried on the same instrument"}
	}
	if decline.RetryClass == domain.RetryClassReview {
		return RetryDecision{
			Allowed: false,
			Reason:  "unmapped/review-class decline: requires manual review before any retry",
		}
	}
	if attemptsSoFar >= config.MaxAttemptsPerPayment {
		return RetryDecision{
			Allowed: false,
			Reason:  fmt.Sprintf("max attempts per payment (%d) already reached", config.MaxAttemptsPerPayment),
		}
	}
	return RetryDecision{
		Allowed: true,
		Reason:  fmt.Sprintf("retryClass %q permits a further attempt", decline.RetryClass),
	}
}

// HasSufficientSpacing mirrors hasSufficientSpacing: true if enough
// time has passed since the last attempt per config.MinSpacing.
func HasSufficientSpacing(lastAttemptAt time.Time, now time.Time, config RetryPolicyConfig) bool {
	return now.Sub(lastAttemptAt) >= config.MinSpacing
}
