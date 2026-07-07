// This file is the Go port of src/subscriptions/dunning.ts, T8.2's
// dunning ladder engine — read this file's own doc comment plus this
// package's top doc comment before touching anything here; the exact
// delay-hours table and max-attempts-then-cancel behavior are called
// out explicitly in MIGRATION_NOTES.md's Phase 7 section as the
// highest-business-risk item in this phase (an off-by-one on the ladder
// step, or a wrong hour count, silently changes when real customers get
// billed again after a failed renewal).
package subscriptions

import (
	"fmt"
	"time"

	"github.com/alphapayments/payment-orchestrator/internal/domain"
	"github.com/alphapayments/payment-orchestrator/internal/routing"
)

// DunningLadderHours mirrors DUNNING_LADDER_HOURS exactly: [24, 72,
// 168] — delays are hours after the PREVIOUS attempt, indexed by
// dunning_stage (1-based: stage 1 is the first dunning retry after the
// original renewal failure, ..., stage len(DunningLadderHours) is the
// last one before giving up).
//
// A subscription only ever reaches 'past_due' (and therefore this
// ladder) via MarkSubscriptionPastDue, which the renewal dispatcher
// (T8.1) only calls for a NON-hard decline — a hard/fraud decline
// cancels the subscription immediately instead (see
// internal/worker/tasks.go's renewal dispatcher task). So by the time
// this function is consulted, "is this retryable at all" has already
// been answered; this ladder's job is purely "how many more times, how
// far apart."
//
// STANDING DEFAULT ONLY as of the configurable retry/dunning policy
// feature: this package-level var remains EvaluateDunningStep's
// fallback value (used by every existing call site/test that doesn't
// have a merchant-specific override), but it is no longer the only
// source of truth — EvaluateDunningStep now takes an explicit
// DunningConfig parameter, and internal/worker/tasks.go's real call
// site loads a per-merchant-entity override from the retry_settings
// table (internal/api.RetrySettingsStore) before calling it, falling
// back to DefaultDunningConfig() (built from this exact var) only when
// no retry_settings row exists yet for that merchant entity. See
// MIGRATION_NOTES.md's Configurable Retry/Dunning Policy section for
// the full writeup and this file's own EvaluateDunningStep doc comment
// for exactly how the parameter threading works.
var DunningLadderHours = []int{24, 72, 168}

// DunningConfig is the configurable input EvaluateDunningStep now
// requires explicitly, replacing its previous direct read of the
// package-level DunningLadderHours var. Mirrors the one field that var
// carried — deliberately just a plain struct wrapping []int rather than
// a richer type, since the ladder-hours slice is the only thing this
// whole package's dunning-step logic actually varies on (max attempts
// is derived from len(LadderHours) as it always was, per
// EvaluateDunningStep's own doc comment below).
type DunningConfig struct {
	// LadderHours is the ordered "wait N hours, then retry" schedule —
	// the same shape/semantics DunningLadderHours always had. Must be
	// non-empty for EvaluateDunningStep to behave sensibly (an empty
	// slice would mean "0 max attempts," i.e. every stage immediately
	// exhausted) — validation of that constraint belongs to whatever
	// constructs a DunningConfig from user input (see
	// internal/api/retry_settings.go's validateRetrySettingsInput),
	// not to this struct or EvaluateDunningStep itself, matching this
	// package's existing convention of validating at the API boundary,
	// not deep in domain logic.
	LadderHours []int
}

// DefaultDunningConfig returns a DunningConfig built from
// DunningLadderHours — the fallback every existing call site/test in
// this package used implicitly before this parameter existed, and the
// fallback internal/worker/tasks.go's real call site now uses
// explicitly when a merchant entity has no retry_settings row yet.
func DefaultDunningConfig() DunningConfig {
	return DunningConfig{LadderHours: DunningLadderHours}
}

// DunningDecision mirrors DunningDecision exactly.
type DunningDecision struct {
	Allowed     bool
	Reason      string
	NextStage   int
	NextRetryAt *time.Time
}

// EvaluateDunningStep mirrors evaluateDunningStep exactly, including
// its exact reuse of routing.CanRetrySameInstrument (Milestone 5, T5.4)
// purely for its attempt-cap check — the synthetic retryClass passed in
// (domain.RetryClassSameInstrumentLater) is always a retryable one by
// construction (see this file's own doc comment above), so
// CanRetrySameInstrument's hard-decline/review-class branches are
// intentionally unreachable from this call site, not dead code left in
// by mistake — this exactly matches the TS source's own comment on the
// identical call.
//
// currentStage is the subscription's dunning_stage BEFORE this attempt
// (0 the first time a renewal failed and handed off here). now defaults
// to time.Now() if the zero value is passed, mirroring the TS default
// parameter `now: Date = new Date()`.
//
// config is the CONFIGURABLE RETRY/DUNNING POLICY feature's new
// required parameter, replacing this function's previous direct read
// of the package-level DunningLadderHours var — every call site now
// passes its ladder explicitly. Every existing caller/test in this
// package that used to rely on the hardcoded default continues to see
// byte-for-byte identical behavior by passing DefaultDunningConfig()
// (built from that exact same DunningLadderHours var) — this parameter
// threading changed ONLY the call signature, never the numbers
// themselves, exactly as this feature's own task brief requires
// ("keeping the exact same test assertions/behavior when the config
// passed in matches today's hardcoded defaults, so no existing test's
// expected behavior changes only its call signature does"). See
// internal/worker/tasks.go's dunningProcessorHandler for the one real
// call site that now passes a merchant-specific config loaded from the
// retry_settings table instead of the default.
func EvaluateDunningStep(currentStage int, now time.Time, config DunningConfig) DunningDecision {
	if now.IsZero() {
		now = time.Now()
	}

	ladderHours := config.LadderHours

	decision := routing.CanRetrySameInstrument(
		routing.DeclineForRetryCheck(domain.RetryClassSameInstrumentLater),
		currentStage,
		routing.RetryPolicyConfig{
			MaxAttemptsPerPayment: len(ladderHours),
			MinSpacing:            0,
		},
	)

	if !decision.Allowed {
		return DunningDecision{Allowed: false, Reason: "dunning ladder exhausted", NextStage: currentStage}
	}

	nextStage := currentStage + 1
	delayHours := ladderHours[currentStage]
	nextRetryAt := now.Add(time.Duration(delayHours) * time.Hour)
	return DunningDecision{
		Allowed:     true,
		Reason:      fmt.Sprintf("stage %d of %d, next retry in %dh if this one also fails", nextStage, len(ladderHours), delayHours),
		NextStage:   nextStage,
		NextRetryAt: &nextRetryAt,
	}
}
