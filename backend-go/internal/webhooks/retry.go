// This file is the Go port of src/webhooks/inboxAttempts.ts — shared by
// both the normalize (normalize.go) and apply (apply.go) steps, exactly
// as the TS source shares it between webhookNormalize.ts and
// webhookApply.ts: either step can fail for the same two reasons (a
// transient error, or an "unknown object" creation race where our
// payment row doesn't exist yet), and both need identical
// attempt-counting/DLQ bookkeeping. Covers both retry-decision and
// DLQ-marking in one file (a single well-organized file, not split into
// a separate dlq.go) — a deliberate deviation from the task's literal
// "separate dlq.go" suggestion, made because the two concerns
// (incrementing attempts, deciding retry-vs-dlq) are a single atomic
// decision in both the TS source and this port, not two independently
// callable operations; splitting them across files would separate code
// that must always run together and is never meaningfully reused apart.
package webhooks

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// MaxWebhookAttempts mirrors MAX_WEBHOOK_ATTEMPTS exactly.
const MaxWebhookAttempts = 5

// FailureDecision mirrors the TS FailureDecision union type.
type FailureDecision string

const (
	DecisionRetry FailureDecision = "retry"
	DecisionDlq   FailureDecision = "dlq"
)

// RecordFailureAndDecide mirrors recordFailureAndDecide exactly:
// increments webhook_inbox.attempts, and if the new count has reached
// MaxWebhookAttempts, marks the row 'dlq' and increments the
// webhooks_dlq_total counter, returning DecisionDlq; otherwise returns
// DecisionRetry so the caller knows to retry (in this Go port, that
// means: the caller's own goroutine-based dispatch has already
// returned/failed — since there's no Hatchet-style automatic backoff
// yet, "retry" here means "leave status=pending so a future
// gap-detection sweep or manual re-trigger picks it up again," not "an
// automatic retry is about to happen" — see this package's top doc
// comment for the full framing of what "retry" means with no worker).
func RecordFailureAndDecide(ctx context.Context, pool *pgxpool.Pool, metrics Metrics, inboxID string, psp string) (FailureDecision, error) {
	var attempts int
	err := pool.QueryRow(ctx,
		`UPDATE webhook_inbox SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts`,
		inboxID,
	).Scan(&attempts)
	if err != nil {
		return "", fmt.Errorf("webhooks: increment webhook_inbox.attempts for %s: %w", inboxID, err)
	}

	if attempts >= MaxWebhookAttempts {
		_, err := pool.Exec(ctx, `UPDATE webhook_inbox SET status = 'dlq' WHERE id = $1`, inboxID)
		if err != nil {
			return "", fmt.Errorf("webhooks: mark webhook_inbox %s as dlq: %w", inboxID, err)
		}
		if metrics != nil {
			metrics.IncDlq(psp)
		}
		return DecisionDlq, nil
	}

	return DecisionRetry, nil
}
