package subscriptions

import (
	"testing"
	"time"
)

// TestDunningLadderHours_ExactValues pins down the exact delay-hours
// table this whole phase's highest-business-risk logic depends on —
// [24, 72, 168] — transcribed directly from
// src/subscriptions/dunning.ts's DUNNING_LADDER_HOURS constant. A
// regression changing any one of these three numbers, or their count,
// changes real billing-retry cadence for real customers without any
// other test in this suite necessarily catching it — this test exists
// specifically so that class of change fails loudly.
func TestDunningLadderHours_ExactValues(t *testing.T) {
	want := []int{24, 72, 168}
	if len(DunningLadderHours) != len(want) {
		t.Fatalf("DunningLadderHours has %d entries, want %d", len(DunningLadderHours), len(want))
	}
	for i, h := range want {
		if DunningLadderHours[i] != h {
			t.Errorf("DunningLadderHours[%d] = %d, want %d", i, DunningLadderHours[i], h)
		}
	}
}

// TestEvaluateDunningStep_StageZero_FirstRetryIn24Hours mirrors the
// exact scenario a subscription is in right after
// MarkSubscriptionPastDue is first called: dunning_stage=0.
func TestEvaluateDunningStep_StageZero_FirstRetryIn24Hours(t *testing.T) {
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	decision := EvaluateDunningStep(0, now, DefaultDunningConfig())

	if !decision.Allowed {
		t.Fatalf("expected stage 0 to be allowed, got Allowed=false reason=%q", decision.Reason)
	}
	if decision.NextStage != 1 {
		t.Errorf("NextStage = %d, want 1", decision.NextStage)
	}
	if decision.NextRetryAt == nil {
		t.Fatal("NextRetryAt is nil, want a value")
	}
	wantRetryAt := now.Add(24 * time.Hour)
	if !decision.NextRetryAt.Equal(wantRetryAt) {
		t.Errorf("NextRetryAt = %v, want %v (24h after now)", decision.NextRetryAt, wantRetryAt)
	}
}

// TestEvaluateDunningStep_StageOne_SecondRetryIn72Hours mirrors the
// second rung: dunning_stage=1 (the first retry already happened and
// also failed).
func TestEvaluateDunningStep_StageOne_SecondRetryIn72Hours(t *testing.T) {
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	decision := EvaluateDunningStep(1, now, DefaultDunningConfig())

	if !decision.Allowed {
		t.Fatalf("expected stage 1 to be allowed, got Allowed=false reason=%q", decision.Reason)
	}
	if decision.NextStage != 2 {
		t.Errorf("NextStage = %d, want 2", decision.NextStage)
	}
	wantRetryAt := now.Add(72 * time.Hour)
	if decision.NextRetryAt == nil || !decision.NextRetryAt.Equal(wantRetryAt) {
		t.Errorf("NextRetryAt = %v, want %v (72h after now)", decision.NextRetryAt, wantRetryAt)
	}
}

// TestEvaluateDunningStep_StageTwo_ThirdRetryIn168Hours mirrors the
// third and final rung: dunning_stage=2.
func TestEvaluateDunningStep_StageTwo_ThirdRetryIn168Hours(t *testing.T) {
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	decision := EvaluateDunningStep(2, now, DefaultDunningConfig())

	if !decision.Allowed {
		t.Fatalf("expected stage 2 to be allowed, got Allowed=false reason=%q", decision.Reason)
	}
	if decision.NextStage != 3 {
		t.Errorf("NextStage = %d, want 3", decision.NextStage)
	}
	wantRetryAt := now.Add(168 * time.Hour)
	if decision.NextRetryAt == nil || !decision.NextRetryAt.Equal(wantRetryAt) {
		t.Errorf("NextRetryAt = %v, want %v (168h after now)", decision.NextRetryAt, wantRetryAt)
	}
}

// TestEvaluateDunningStep_StageThree_LadderExhausted is the
// max-attempts-then-cancel cutoff this whole test file's docstring
// calls out as the other highest-risk behavior: once dunning_stage
// reaches len(DunningLadderHours) (3), the ladder must refuse to
// schedule a further retry — this is exactly what
// internal/worker/tasks.go's dunningProcessorHandler uses to decide
// "cancel the subscription outright (dunning_exhausted)" instead of
// scheduling yet another attempt. An off-by-one here (allowing a 4th
// attempt, or refusing the legitimate 3rd one) is exactly the class of
// bug this test exists to catch.
func TestEvaluateDunningStep_StageThree_LadderExhausted(t *testing.T) {
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	decision := EvaluateDunningStep(len(DunningLadderHours), now, DefaultDunningConfig())

	if decision.Allowed {
		t.Fatalf("expected the ladder to be exhausted at stage %d, got Allowed=true", len(DunningLadderHours))
	}
	if decision.NextRetryAt != nil {
		t.Errorf("NextRetryAt = %v, want nil once the ladder is exhausted", decision.NextRetryAt)
	}
	if decision.NextStage != len(DunningLadderHours) {
		t.Errorf("NextStage = %d, want %d (unchanged once exhausted)", decision.NextStage, len(DunningLadderHours))
	}
}

// TestEvaluateDunningStep_StageBeyondExhausted_StillRefused guards
// against a regression where only the EXACT boundary value is checked
// (e.g. `== len(DunningLadderHours)` instead of `>=`) — a stage further
// past exhaustion must also be refused, not accidentally treated as
// "back in range."
func TestEvaluateDunningStep_StageBeyondExhausted_StillRefused(t *testing.T) {
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	decision := EvaluateDunningStep(len(DunningLadderHours)+5, now, DefaultDunningConfig())

	if decision.Allowed {
		t.Fatalf("expected a stage far beyond exhaustion to be refused, got Allowed=true")
	}
}

// TestEvaluateDunningStep_EveryStage_MatchesLadderTableExactly is a
// single table-driven sweep asserting every legal stage (0 through
// len-1) produces exactly the delay from DunningLadderHours at that
// index — a second, independent way of catching an off-by-one that
// TestEvaluateDunningStep_Stage{Zero,One,Two}'s individually-hardcoded
// expectations might share a mistake with, since this test derives its
// expectation directly from the DunningLadderHours slice rather than
// repeating the literal numbers 24/72/168 a second time.
func TestEvaluateDunningStep_EveryStage_MatchesLadderTableExactly(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for stage, wantDelayHours := range DunningLadderHours {
		decision := EvaluateDunningStep(stage, now, DefaultDunningConfig())
		if !decision.Allowed {
			t.Fatalf("stage %d: expected Allowed=true, got reason %q", stage, decision.Reason)
		}
		wantRetryAt := now.Add(time.Duration(wantDelayHours) * time.Hour)
		if decision.NextRetryAt == nil || !decision.NextRetryAt.Equal(wantRetryAt) {
			t.Errorf("stage %d: NextRetryAt = %v, want %v (delay %dh)", stage, decision.NextRetryAt, wantRetryAt, wantDelayHours)
		}
		if decision.NextStage != stage+1 {
			t.Errorf("stage %d: NextStage = %d, want %d", stage, decision.NextStage, stage+1)
		}
	}
}

// TestEvaluateDunningStep_ZeroTimeDefaultsToNow mirrors the TS
// default-parameter semantics (`now: Date = new Date()`) — passing the
// zero time.Time value must fall back to a real "now," not literally
// schedule the next retry near the Unix epoch.
func TestEvaluateDunningStep_ZeroTimeDefaultsToNow(t *testing.T) {
	before := time.Now()
	decision := EvaluateDunningStep(0, time.Time{}, DefaultDunningConfig())
	after := time.Now()

	if decision.NextRetryAt == nil {
		t.Fatal("NextRetryAt is nil")
	}
	lowerBound := before.Add(24 * time.Hour)
	upperBound := after.Add(24 * time.Hour)
	if decision.NextRetryAt.Before(lowerBound) || decision.NextRetryAt.After(upperBound) {
		t.Errorf("NextRetryAt = %v, want within [%v, %v] (24h after 'now')", decision.NextRetryAt, lowerBound, upperBound)
	}
}
