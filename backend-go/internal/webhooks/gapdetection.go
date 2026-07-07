// This file is the Go port of src/workflow/tasks/gapDetection.ts's
// gap-detection sweep, plus src/webhooks/inboxAttempts.ts's
// refreshWebhookHealthGauges (called at the top of every gap-detection
// run, exactly matching the TS source's own placement/reasoning: T7.2/
// T7.3's webhooks_inbox_backlog/webhooks_dlq_depth gauges were declared
// as placeholders back in Milestone 0/3 but nothing ever actually set
// them, since incrementing a gauge doesn't fit either the webhook
// route's or the apply/normalize tasks' request-scoped code paths — a
// periodic poll piggybacking on gap-detection's existing cadence is
// the fix, ported here verbatim).
//
// NO CRON SCHEDULING IN THIS PHASE — this is a plain exported Go
// function (RunGapDetection), matching this package's top doc comment
// on why nothing here is queue-aware yet. Phase 6 (a real Hatchet-
// equivalent worker) is responsible for actually scheduling this on a
// recurring cadence; today it must be invoked manually or by an
// external scheduler (e.g. a cron-triggered HTTP endpoint or a
// one-shot binary) until then.
package webhooks

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/alphapayments/payment-orchestrator/internal/adapters"
	"github.com/alphapayments/payment-orchestrator/internal/domain"
)

// PollableStates mirrors POLLABLE_STATES exactly — see gapDetection.ts's
// doc comment for why authorized/dispute_opened are deliberately
// excluded (both have long "normal" dwell times that aren't a sign of
// a missed webhook) and why captured/settled staleness is Milestone 6's
// reconciliation job's concern instead.
var PollableStates = []domain.PaymentState{
	domain.StateCreated,
	domain.StateRequiresAction,
	domain.StateAuthorizing,
	domain.StateCapturing,
	domain.StateRefundPending,
}

func pollableStateStrings() []string {
	out := make([]string, len(PollableStates))
	for i, s := range PollableStates {
		out[i] = string(s)
	}
	return out
}

// GapDetectionInput mirrors GapDetectionInput.
type GapDetectionInput struct {
	// ThresholdMinutes defaults to 15 when zero.
	ThresholdMinutes int
	// BatchSize defaults to 200 when zero.
	BatchSize int
}

// GapDetectionResult mirrors GapDetectionResult.
type GapDetectionResult struct {
	Scanned  int
	Resynced int
}

// synthesizeEventsForStatus mirrors synthesizeEventsForStatus's exact
// switch, including the deliberately over-inclusive 'captured' branch
// (see gapDetection.ts's own comment: late-event handling makes
// replaying already-applied steps harmless).
func synthesizeEventsForStatus(snapshot adapters.AttemptSnapshot) []domain.CanonicalEvent {
	switch snapshot.Status {
	case adapters.AttemptStatusRequiresAction:
		return []domain.CanonicalEvent{{Type: domain.EventAuthenticationRequired}}
	case adapters.AttemptStatusAuthorized:
		return []domain.CanonicalEvent{{Type: domain.EventAuthorized}}
	case adapters.AttemptStatusCaptured:
		return []domain.CanonicalEvent{
			{Type: domain.EventAuthorized},
			{Type: domain.EventCaptureStarted},
			{Type: domain.EventCaptured},
		}
	case adapters.AttemptStatusDeclined:
		var declineCode *string
		if snapshot.Decline != nil {
			code := snapshot.Decline.NormalizedCode
			declineCode = &code
		}
		return []domain.CanonicalEvent{{Type: domain.EventDeclined, DeclineCode: declineCode}}
	case adapters.AttemptStatusFailed:
		return []domain.CanonicalEvent{{Type: domain.EventAuthorizationFailed}}
	case adapters.AttemptStatusVoided:
		return []domain.CanonicalEvent{{Type: domain.EventVoided}}
	case adapters.AttemptStatusRefunded:
		return []domain.CanonicalEvent{
			{Type: domain.EventRefundStarted},
			{Type: domain.EventRefunded},
		}
	default: // "pending" and anything else.
		return nil
	}
}

type stalePaymentCandidate struct {
	ID    string
	State string
}

// RunGapDetection mirrors createGapDetectionTask's handler exactly:
// refresh health gauges first, then find stale candidates in
// PollableStates older than the threshold, then for each one resolve
// its latest attempt -> psp_account -> adapter -> GetPayment snapshot
// -> synthesize events -> ApplyCanonicalEvents. A single payment's
// failure is logged (via the returned error slice, since this Go port
// has no ctx.logger equivalent threaded through — callers should log
// each error themselves) and does NOT abort the sweep, mirroring the
// TS handler's own per-payment try/catch that continues to the next
// candidate.
func RunGapDetection(ctx context.Context, deps Deps, input GapDetectionInput) (GapDetectionResult, []error) {
	var errs []error

	if err := RefreshWebhookHealthGauges(ctx, deps.Pool, deps.Metrics); err != nil {
		errs = append(errs, fmt.Errorf("webhooks: refresh health gauges: %w", err))
	}

	thresholdMinutes := input.ThresholdMinutes
	if thresholdMinutes <= 0 {
		thresholdMinutes = 15
	}
	batchSize := input.BatchSize
	if batchSize <= 0 {
		batchSize = 200
	}
	cutoff := time.Now().Add(-time.Duration(thresholdMinutes) * time.Minute)

	rows, err := deps.Pool.Query(ctx,
		`SELECT id, state FROM payments
		 WHERE state = ANY($1) AND updated_at < $2
		 LIMIT $3`,
		pollableStateStrings(), cutoff, batchSize,
	)
	if err != nil {
		return GapDetectionResult{}, append(errs, fmt.Errorf("webhooks: query stale payments: %w", err))
	}
	var candidates []stalePaymentCandidate
	for rows.Next() {
		var c stalePaymentCandidate
		if err := rows.Scan(&c.ID, &c.State); err != nil {
			rows.Close()
			return GapDetectionResult{}, append(errs, fmt.Errorf("webhooks: scan stale payment row: %w", err))
		}
		candidates = append(candidates, c)
	}
	iterErr := rows.Err()
	rows.Close()
	if iterErr != nil {
		return GapDetectionResult{}, append(errs, fmt.Errorf("webhooks: iterate stale payment rows: %w", iterErr))
	}

	resynced := 0
	for _, payment := range candidates {
		events, psp, err := resolveGapDetectionEvents(ctx, deps, payment.ID)
		if err != nil {
			errs = append(errs, fmt.Errorf("webhooks: gap-detection failed for payment %s: %w", payment.ID, err))
			continue
		}
		if len(events) == 0 {
			continue
		}
		if _, err := ApplyCanonicalEvents(ctx, deps, payment.ID, events, psp); err != nil {
			errs = append(errs, fmt.Errorf("webhooks: gap-detection applyCanonicalEvents failed for payment %s: %w", payment.ID, err))
			continue
		}
		resynced++
	}

	return GapDetectionResult{Scanned: len(candidates), Resynced: resynced}, errs
}

// resolveGapDetectionEvents resolves the latest attempt -> psp_account
// -> adapter -> GetPayment snapshot -> synthesized events for one
// payment, mirroring the inline logic inside gapDetection.ts's
// handler's for-loop body.
func resolveGapDetectionEvents(ctx context.Context, deps Deps, paymentID string) ([]domain.CanonicalEvent, string, error) {
	var pspAttemptRef *string
	var pspAccountID string
	err := deps.Pool.QueryRow(ctx,
		`SELECT psp_attempt_ref, psp_account_id FROM payment_attempts
		 WHERE payment_id = $1
		 ORDER BY attempt_number DESC
		 LIMIT 1`,
		paymentID,
	).Scan(&pspAttemptRef, &pspAccountID)
	if err != nil {
		return nil, "", fmt.Errorf("query latest payment_attempts row: %w", err)
	}
	if pspAttemptRef == nil {
		return nil, "", nil
	}

	var account PspAccountRow
	err = deps.Pool.QueryRow(ctx,
		`SELECT id, psp, mode, secret_ref FROM psp_accounts WHERE id = $1`,
		pspAccountID,
	).Scan(&account.ID, &account.PSP, &account.Mode, &account.SecretRef)
	if err != nil {
		return nil, "", fmt.Errorf("query psp_accounts row %s: %w", pspAccountID, err)
	}

	adapter, err := deps.Registry.Resolve(account.toRegistryAccount())
	if err != nil {
		return nil, account.PSP, fmt.Errorf("resolve adapter for psp_account %s: %w", pspAccountID, err)
	}

	snapshot, err := adapter.GetPayment(ctx, *pspAttemptRef)
	if err != nil {
		return nil, account.PSP, fmt.Errorf("adapter.GetPayment(%s): %w", *pspAttemptRef, err)
	}

	return synthesizeEventsForStatus(snapshot), account.PSP, nil
}

// RefreshWebhookHealthGauges mirrors refreshWebhookHealthGauges
// exactly: polls webhook_inbox grouped by (psp, status) to set the
// webhooks_inbox_backlog (pending/processing/failed) and
// webhooks_dlq_depth (dlq) gauges.
func RefreshWebhookHealthGauges(ctx context.Context, pool *pgxpool.Pool, metrics Metrics) error {
	if metrics == nil {
		return nil
	}

	backlogRows, err := pool.Query(ctx,
		`SELECT psp, count(*) FROM webhook_inbox
		 WHERE status IN ('pending', 'processing', 'failed')
		 GROUP BY psp`,
	)
	if err != nil {
		return fmt.Errorf("webhooks: query inbox backlog: %w", err)
	}
	for backlogRows.Next() {
		var psp string
		var count int64
		if err := backlogRows.Scan(&psp, &count); err != nil {
			backlogRows.Close()
			return fmt.Errorf("webhooks: scan inbox backlog row: %w", err)
		}
		metrics.SetInboxBacklog(psp, float64(count))
	}
	if err := backlogRows.Err(); err != nil {
		backlogRows.Close()
		return fmt.Errorf("webhooks: iterate inbox backlog rows: %w", err)
	}
	backlogRows.Close()

	dlqRows, err := pool.Query(ctx,
		`SELECT psp, count(*) FROM webhook_inbox WHERE status = 'dlq' GROUP BY psp`,
	)
	if err != nil {
		return fmt.Errorf("webhooks: query dlq depth: %w", err)
	}
	for dlqRows.Next() {
		var psp string
		var count int64
		if err := dlqRows.Scan(&psp, &count); err != nil {
			dlqRows.Close()
			return fmt.Errorf("webhooks: scan dlq depth row: %w", err)
		}
		metrics.SetDlqDepth(psp, float64(count))
	}
	if err := dlqRows.Err(); err != nil {
		dlqRows.Close()
		return fmt.Errorf("webhooks: iterate dlq depth rows: %w", err)
	}
	dlqRows.Close()

	return nil
}
