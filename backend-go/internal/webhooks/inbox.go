// Package webhooks is the Go port of Milestone 3's webhook pipeline:
// ingress (src/webhooks/route.ts), normalization
// (src/workflow/tasks/webhookNormalize.ts), apply
// (src/workflow/tasks/webhookApply.ts), retry/DLQ bookkeeping
// (src/webhooks/inboxAttempts.ts), and gap-detection
// (src/workflow/tasks/gapDetection.ts).
//
// NO HATCHET WORKER EXISTS IN THIS GO PORT YET (Phase 6 territory —
// see MIGRATION_NOTES.md). Normalize/Apply/gap-detection are therefore
// plain, synchronously-callable Go functions here — NOT queue-aware,
// NOT scheduled, NOT retried by any framework. The webhook HTTP route
// (internal/api/webhooks.go) triggers Normalize via a background
// goroutine with its OWN context (context.Background(), not the
// request's context) so a slow/failed dispatch never turns into a
// slow/failed HTTP ack — this mirrors the TS route's own "fire-and-
// forget; a dispatch failure must never turn into a slow/failed ack"
// framing (src/webhooks/route.ts's doc comment), just replacing
// Hatchet's actual queue with a goroutine since no queue exists yet in
// this Go port. Retries beyond that first attempt do NOT happen
// automatically today — gap-detection (gapdetection.go) and a manual
// re-trigger are the only backstops until Phase 6 adds a real worker
// with retry/backoff, exactly as the TS source's own T3.1 doc comment
// already names gap-detection and `make replay-webhook` as the
// backstops for a dispatch that never lands.
package webhooks

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/alphapayments/payment-orchestrator/internal/adapters"
	"github.com/alphapayments/payment-orchestrator/internal/adapters/registry"
	"github.com/alphapayments/payment-orchestrator/internal/statemachine"
)

// pgUniqueViolationCode mirrors internal/api/pgstore.go's identical
// constant — duplicated here rather than imported, since importing
// internal/api from internal/webhooks would create the exact import
// cycle this package's top doc comment and Deps.StableName's doc
// comment both describe, and because this is a two-line, extremely
// stable Postgres error code, not meaningfully DRY-able logic.
const pgUniqueViolationCode = "23505"

// PspAccountRow mirrors the columns the webhook route/normalizer need
// from a psp_accounts row — the Go analogue of route.ts's/
// webhookNormalize.ts's shared PspAccountRow shape
// (src/adapters/registry.ts). toRegistryAccount converts to
// registry.PspAccount for Resolve, mirroring
// internal/api/payments.go's PspAccountRow.toRegistryAccount pattern
// exactly.
type PspAccountRow struct {
	ID        string
	PSP       string
	Mode      string
	SecretRef string
}

func (p PspAccountRow) toRegistryAccount() registry.PspAccount {
	return registry.PspAccount{ID: p.ID, PSP: p.PSP, Mode: p.Mode, SecretRef: p.SecretRef}
}

// StableNameLookup is a TYPE ALIAS (not a new named type) for
// statemachine.StableNameLookup — deliberately, not by accident: Go's
// assignability rule for named function types requires at least one
// side of an assignment to be an unnamed type when the underlying
// types match; if this were its own distinct named type (as an
// earlier draft of this file had it), passing deps.StableName straight
// through to statemachine.Transition in apply.go would be a compile
// error (two different named types, even with identical underlying
// signatures, are not assignable to one another without an explicit
// conversion). Aliasing to the exact same underlying type
// statemachine.Transition's own parameter expects avoids that trap
// entirely — see this package's top doc comment and apply.go's
// import-cycle note for why this package still cannot import
// internal/api directly (internal/api's PaymentsStore needs to call
// INTO this package, so the reverse import would cycle); importing
// internal/statemachine, by contrast, is safe (statemachine has no
// dependency on internal/webhooks).
type StableNameLookup = statemachine.StableNameLookup

// Deps is everything the webhook ingress/normalize/apply/gap-detection
// functions in this package need — constructed once in cmd/api/main.go
// and passed to every exported function in this package.
type Deps struct {
	Pool     *pgxpool.Pool
	Registry *registry.Registry
	Metrics  Metrics
	// StableName resolves a canonical event type to its stable,
	// product-facing timeline name — passed straight through to
	// statemachine.Transition by ApplyCanonicalEvents (apply.go).
	// cmd/api/main.go wires this to api.StableName (internal/api/timeline.go).
	StableName StableNameLookup
}

// InboxRow mirrors the columns this package's ingress/normalize/apply
// logic reads/writes on webhook_inbox.
type InboxRow struct {
	ID              string
	PSP             string
	PspAccountID    *string
	ProviderEventID string
	RawPayload      json.RawMessage
	Status          string
	Attempts        int
}

// candidateAccounts loads every enabled psp_accounts row for psp — the
// Go analogue of route.ts's
// `db.selectFrom('psp_accounts').where('psp','=',psp).where('is_enabled','=',true)`.
func candidateAccounts(ctx context.Context, pool *pgxpool.Pool, psp string) ([]PspAccountRow, error) {
	rows, err := pool.Query(ctx,
		`SELECT id, psp, mode, secret_ref FROM psp_accounts WHERE psp = $1 AND is_enabled = true`,
		psp,
	)
	if err != nil {
		return nil, fmt.Errorf("webhooks: query candidate psp_accounts: %w", err)
	}
	defer rows.Close()

	var out []PspAccountRow
	for rows.Next() {
		var r PspAccountRow
		if err := rows.Scan(&r.ID, &r.PSP, &r.Mode, &r.SecretRef); err != nil {
			return nil, fmt.Errorf("webhooks: scan candidate psp_accounts row: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("webhooks: iterate candidate psp_accounts rows: %w", err)
	}
	return out, nil
}

// IngestResult tells the HTTP handler what happened, so it can decide
// the response — mirroring route.ts's own two outcomes (400 on no
// verified candidate; 200 otherwise, whether newly-inserted or a
// duplicate).
type IngestResult struct {
	// Verified is false if signature verification failed against every
	// candidate account — the caller must respond 400.
	Verified bool
	// InboxID is the webhook_inbox row's id, populated only when
	// Verified is true.
	InboxID string
	// Inserted is true only for a genuinely new (psp, provider_event_id)
	// pair — false for a duplicate delivery (ON CONFLICT DO NOTHING hit
	// zero rows). The caller should trigger Normalize only when Inserted
	// is true, exactly matching route.ts's `if (inserted) { dispatch... }`
	// / "else: duplicate delivery — ack without re-dispatching" branch.
	Inserted bool
}

// Ingest is the Go port of route.ts's POST /webhooks/:psp handler body
// (minus the actual HTTP framing, which lives in
// internal/api/webhooks.go — this function is deliberately transport-
// agnostic so it's unit-testable without a live chi router):
//
//  1. Load every enabled psp_accounts row for psp.
//  2. Try each candidate's adapter.VerifyWebhook(rawBody, headers) in
//     order, catching *adapters.InvalidSignatureError to try the next
//     candidate — stopping at the first one that verifies. No verified
//     candidate at all -> Verified=false (caller responds 400).
//  3. INSERT INTO webhook_inbox ... ON CONFLICT (psp, provider_event_id)
//     DO NOTHING — the dedup boundary (Non-negotiable #4). A conflict
//     means Inserted=false (duplicate delivery — caller acks 200 without
//     triggering Normalize).
//
// This function does NOT trigger Normalize itself — see this package's
// top doc comment and internal/api/webhooks.go for why that's the
// caller's job (a background goroutine with its own context, not this
// function's request-scoped one).
func Ingest(ctx context.Context, deps Deps, psp string, rawBody []byte, headers map[string][]string) (IngestResult, error) {
	candidates, err := candidateAccounts(ctx, deps.Pool, psp)
	if err != nil {
		return IngestResult{}, err
	}

	var verified *adapters.VerifiedEvent
	var matchedAccount *PspAccountRow
	for i := range candidates {
		account := candidates[i]
		adapter, err := deps.Registry.Resolve(account.toRegistryAccount())
		if err != nil {
			return IngestResult{}, err
		}
		v, err := adapter.VerifyWebhook(rawBody, headers)
		if err != nil {
			var sigErr *adapters.InvalidSignatureError
			if errors.As(err, &sigErr) {
				continue
			}
			return IngestResult{}, err
		}
		verified = &v
		matchedAccount = &account
		break
	}

	if verified == nil || matchedAccount == nil {
		if deps.Metrics != nil {
			deps.Metrics.IncSignatureInvalid(psp)
		}
		return IngestResult{Verified: false}, nil
	}

	payloadJSON, err := json.Marshal(verified.RawPayload)
	if err != nil {
		return IngestResult{}, fmt.Errorf("webhooks: marshal verified raw payload: %w", err)
	}

	id, err := uuid.NewV7()
	if err != nil {
		return IngestResult{}, fmt.Errorf("webhooks: generate webhook_inbox id: %w", err)
	}

	var insertedID *string
	err = deps.Pool.QueryRow(ctx,
		`INSERT INTO webhook_inbox (id, psp, psp_account_id, provider_event_id, raw_payload, status)
		 VALUES ($1, $2, $3, $4, $5, 'pending')
		 ON CONFLICT (psp, provider_event_id) DO NOTHING
		 RETURNING id`,
		id.String(), psp, matchedAccount.ID, verified.ProviderEventID, payloadJSON,
	).Scan(&insertedID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// ON CONFLICT DO NOTHING hit — duplicate delivery. Ack without
			// re-dispatching (route.ts: "duplicate delivery -> 200 fast
			// path, no re-dispatch").
			return IngestResult{Verified: true, Inserted: false}, nil
		}
		return IngestResult{}, fmt.Errorf("webhooks: insert webhook_inbox row: %w", err)
	}

	return IngestResult{Verified: true, Inserted: true, InboxID: id.String()}, nil
}

// isPgUniqueViolation is currently unused by Ingest (ON CONFLICT DO
// NOTHING means Postgres never actually raises 23505 here — matching
// the TS source's own onConflict(...).doNothing() shape exactly), but
// kept for parity with pgstore.go's naming/pattern and in case a future
// caller in this package needs it (e.g. a replay-webhook admin endpoint
// that does NOT use ON CONFLICT DO NOTHING and needs to distinguish
// "already exists" from other errors).
func isPgUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == pgUniqueViolationCode
	}
	return false
}
