package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/alphapayments/payment-orchestrator/internal/domain"
	"github.com/alphapayments/payment-orchestrator/internal/routing"
	"github.com/alphapayments/payment-orchestrator/internal/webhooks"
)

// PgxPaymentsStore is the real, pgx-backed PaymentsStore — the Go port
// of every db.selectFrom(...)/insertInto(...) call
// src/api/routes/payments.ts's handlers make directly (there is no
// separate query-helper module in the TS source — resolveCustomerId,
// upsertPaymentMethod, and every other query live inline inside
// payments.ts itself; this file mirrors that same inline-query shape,
// one method per distinct query/mutation, matching Phase 3's own
// PaymentsStore interface design).
//
// ApplyCanonicalEvents (below) calls internal/webhooks.ApplyCanonicalEvents
// — the SAME underlying function the webhook apply path
// (internal/webhooks/apply.go's Apply) and gap-detection
// (internal/webhooks/gapdetection.go's RunGapDetection) call — per the
// task's explicit instruction not to duplicate this logic between the
// synchronous payments-API call sites and the async webhook-driven
// ones. Both paths ultimately run through the exact same
// statemachine.Transition, under the exact same FOR UPDATE row lock.
//
// ResolveRouting calls *routing.Evaluator.Resolve directly — NOT
// *registry.Registry.Resolve, which stays the HANDLER's job exactly as
// payments.go's own top doc comment already documents ("the handler
// calls deps.Registry.Resolve(...) afterward, not the store"). This
// store needs a *routing.Evaluator (which itself already resolves
// merchant_entity_id from product_id via a `SELECT merchant_entity_id
// FROM products WHERE id = $1` query — see internal/routing/rules.go's
// Evaluator.Resolve — so this store does NOT need its own separate
// products lookup for that purpose).
type PgxPaymentsStore struct {
	Pool      *pgxpool.Pool
	Evaluator *routing.Evaluator
	Webhooks  webhooks.Deps
}

// ResolveCustomerID mirrors resolveCustomerId exactly: if customerID is
// given, return it as-is (no existence check — the TS source doesn't
// verify it either). Otherwise look up an existing customer by
// (merchant_entity_id, email); if none exists, insert a new customer
// row and return its freshly generated id.
func (s PgxPaymentsStore) ResolveCustomerID(ctx context.Context, merchantEntityID string, customerID *string, customerEmail *string) (string, error) {
	if customerID != nil && *customerID != "" {
		return *customerID, nil
	}
	if customerEmail == nil {
		return "", fmt.Errorf("api: ResolveCustomerID: neither customerID nor customerEmail supplied")
	}

	var existingID string
	err := s.Pool.QueryRow(ctx,
		`SELECT id FROM customers WHERE merchant_entity_id = $1 AND email = $2`,
		merchantEntityID, *customerEmail,
	).Scan(&existingID)
	if err == nil {
		return existingID, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("api: query customers by email: %w", err)
	}

	id, err := uuid.NewV7()
	if err != nil {
		return "", fmt.Errorf("api: generate customers id: %w", err)
	}
	_, err = s.Pool.Exec(ctx,
		`INSERT INTO customers (id, merchant_entity_id, email) VALUES ($1, $2, $3)`,
		id.String(), merchantEntityID, *customerEmail,
	)
	if err != nil {
		return "", fmt.Errorf("api: insert customers row: %w", err)
	}
	return id.String(), nil
}

// paymentColumns is the exact column list/order every payments-row
// SELECT in this file uses, so scanPaymentRow can be shared verbatim
// across every call site.
const paymentColumns = `id, merchant_entity_id, product_id, customer_id, amount_minor_units, currency, state, cit_mit, routing_decision, created_at, updated_at`

func scanPaymentRow(row pgx.Row) (PaymentRow, error) {
	var p PaymentRow
	var routingDecisionRaw []byte
	err := row.Scan(&p.ID, new(string), &p.ProductID, &p.CustomerID, &p.AmountMinor, &p.Currency, &p.State, &p.CitMit, &routingDecisionRaw, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		return PaymentRow{}, err
	}
	if len(routingDecisionRaw) > 0 {
		var stored storedRoutingDecision
		if err := json.Unmarshal(routingDecisionRaw, &stored); err == nil && stored.PspAccountID != "" {
			p.RoutingDecision = &RoutingDecision{PspAccountID: stored.PspAccountID}
		}
	}
	return p, nil
}

// storedRoutingDecision is the shape this store persists into
// payments.routing_decision (jsonb) — deliberately narrower than
// routing.Decision (only the one field payments.go's RoutingDecision
// actually carries: PspAccountID), matching this port's standing
// convention of storing/round-tripping only the columns actually used
// downstream (see internal/api/payments.go's own RoutingDecision doc
// comment: "a narrower stand-in for the TS RoutingDecision type ...
// PspAccountID is the one field every call site in this file actually
// needs").
type storedRoutingDecision struct {
	PspAccountID string `json:"pspAccountId"`
	PSP          string `json:"psp,omitempty"`
	Strategy     string `json:"strategy,omitempty"`
	Reason       string `json:"reason,omitempty"`
}

// FindPaymentByIdempotencyKey mirrors the TS route's
// `selectFrom('payments').selectAll().where('idempotency_key','=',idempotencyKey).executeTakeFirst()`,
// but ADDITIONALLY scopes by product_id.
//
// Fixed 2026-07-10 (confirmed cross-tenant IDOR): the original query
// matched on idempotency_key alone. If two different products/tenants
// ever submitted the same Idempotency-Key value — plausible with
// sequential order ids or shared test scripts — tenant B's request
// would find tenant A's payment row here, and createPaymentHandler's
// "not found under my own scope -> fall back to this row" logic would
// serialize tenant A's payment id/customer id/amount/state back to
// tenant B. Scoping this lookup by productID closes that: a foreign
// idempotency key now behaves as a genuine cache miss, matching what
// GetPayment already enforces on the read-back path.
func (s PgxPaymentsStore) FindPaymentByIdempotencyKey(ctx context.Context, productID string, idempotencyKey string) (PaymentRow, bool, error) {
	row := s.Pool.QueryRow(ctx,
		`SELECT `+paymentColumns+` FROM payments WHERE idempotency_key = $1 AND product_id = $2`,
		idempotencyKey, productID,
	)
	p, err := scanPaymentRow(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return PaymentRow{}, false, nil
		}
		return PaymentRow{}, false, fmt.Errorf("api: query payments by idempotency_key: %w", err)
	}
	return p, true, nil
}

// ResolveRouting delegates to *routing.Evaluator.Resolve — see this
// type's top doc comment for why the store, not the registry, owns
// this call, and why no separate merchant_entity_id lookup is needed
// here (the Evaluator already does it internally).
func (s PgxPaymentsStore) ResolveRouting(ctx context.Context, productID string, currency string, citMit string, paymentMethodType string) (RoutingDecision, error) {
	decision, err := s.Evaluator.Resolve(ctx, routing.Input{
		ProductID:         productID,
		Currency:           currency,
		CitMit:             citMit,
		PaymentMethodType:  paymentMethodType,
	})
	if err != nil {
		return RoutingDecision{}, err
	}
	return RoutingDecision{PspAccountID: decision.PspAccountID}, nil
}

// CreatePayment mirrors the TS route's
// `insertInto('payments').values({...}).returningAll().executeTakeFirstOrThrow()`.
// No explicit state value is set on insert — matching the TS source
// exactly (payments.state defaults to 'created' at the schema level;
// see db/migrations/1735776100000_core-schema.up.sql's
// `state text NOT NULL DEFAULT 'created'`).
func (s PgxPaymentsStore) CreatePayment(ctx context.Context, input CreatePaymentRow) (PaymentRow, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return PaymentRow{}, fmt.Errorf("api: generate payments id: %w", err)
	}
	routingJSON, err := json.Marshal(storedRoutingDecision{PspAccountID: input.RoutingDecision.PspAccountID})
	if err != nil {
		return PaymentRow{}, fmt.Errorf("api: marshal routing_decision: %w", err)
	}

	row := s.Pool.QueryRow(ctx,
		`INSERT INTO payments (id, merchant_entity_id, product_id, customer_id, amount_minor_units, currency, cit_mit, routing_decision, idempotency_key)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		 RETURNING `+paymentColumns,
		id.String(), input.MerchantEntityID, input.ProductID, input.CustomerID, input.AmountMinor, input.Currency, input.CitMit, routingJSON, input.IdempotencyKey,
	)
	p, err := scanPaymentRow(row)
	if err != nil {
		return PaymentRow{}, fmt.Errorf("api: insert payments row: %w", err)
	}
	return p, nil
}

// ErrPspAccountNotFound is returned by GetPspAccount when id doesn't
// match any row — distinguished from a real query failure so callers
// can tell "a routing decision pointed at a psp_account that no longer
// exists" (a diagnosable, expected-to-be-rare data issue) apart from an
// actual database error, instead of both collapsing into the same
// generic 500.
var ErrPspAccountNotFound = errors.New("psp_account not found")

// GetPspAccount mirrors the TS route's repeated
// `selectFrom('psp_accounts').selectAll().where('id','=',id).executeTakeFirstOrThrow()`.
func (s PgxPaymentsStore) GetPspAccount(ctx context.Context, id string) (PspAccountRow, error) {
	var row PspAccountRow
	err := s.Pool.QueryRow(ctx,
		`SELECT id, psp, mode, secret_ref, statement_descriptor_suffix FROM psp_accounts WHERE id = $1`,
		id,
	).Scan(&row.ID, &row.PSP, &row.Mode, &row.SecretRef, &row.StatementDescriptorSuffix)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return PspAccountRow{}, fmt.Errorf("api: psp_account %s: %w", id, ErrPspAccountNotFound)
		}
		return PspAccountRow{}, fmt.Errorf("api: query psp_accounts %s: %w", id, err)
	}
	return row, nil
}

const attemptColumns = `attempt_number, status, psp_attempt_ref, psp_account_id, created_at`

func scanAttemptRow(row pgx.Row) (AttemptRow, error) {
	var a AttemptRow
	err := row.Scan(&a.AttemptNumber, &a.Status, &a.PspAttemptRef, &a.PspAccountID, &a.CreatedAt)
	return a, err
}

// FindAttempt mirrors the TS route's inline
// `selectFrom('payment_attempts').where('payment_id','=',...).where('attempt_number','=',...).executeTakeFirst()`.
func (s PgxPaymentsStore) FindAttempt(ctx context.Context, paymentID string, attemptNumber int) (AttemptRow, bool, error) {
	row := s.Pool.QueryRow(ctx,
		`SELECT `+attemptColumns+` FROM payment_attempts WHERE payment_id = $1 AND attempt_number = $2`,
		paymentID, attemptNumber,
	)
	a, err := scanAttemptRow(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return AttemptRow{}, false, nil
		}
		return AttemptRow{}, false, fmt.Errorf("api: query payment_attempts by attempt_number: %w", err)
	}
	return a, true, nil
}

// LatestAttempt mirrors the TS route's inline
// `selectFrom('payment_attempts').where('payment_id','=',id).orderBy('attempt_number','desc').executeTakeFirst()`
// (repeated identically at every capture/void/refund call site in the
// TS source, not a separately named function there either).
func (s PgxPaymentsStore) LatestAttempt(ctx context.Context, paymentID string) (AttemptRow, bool, error) {
	row := s.Pool.QueryRow(ctx,
		`SELECT `+attemptColumns+` FROM payment_attempts WHERE payment_id = $1 ORDER BY attempt_number DESC LIMIT 1`,
		paymentID,
	)
	a, err := scanAttemptRow(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return AttemptRow{}, false, nil
		}
		return AttemptRow{}, false, fmt.Errorf("api: query latest payment_attempts row: %w", err)
	}
	return a, true, nil
}

// UpsertPaymentMethod mirrors the TS route's upsertPaymentMethod
// exactly: check-then-insert (NOT a real ON CONFLICT upsert — the TS
// source uses a plain SELECT-then-INSERT here, unlike RecordAttempt's
// real ON CONFLICT DO NOTHING below), scoped by
// (customer_id, psp_account_id, psp_payment_method_ref). type is
// hardcoded 'card' and is_active is hardcoded true, matching the TS
// source's literal values exactly (both are real limitations of the
// current API surface, not a Go-port simplification — see
// MIGRATION_NOTES.md's self-critical list).
func (s PgxPaymentsStore) UpsertPaymentMethod(ctx context.Context, customerID string, pspAccountID string, pspPaymentMethodRef string) (PaymentMethodRow, error) {
	existing, err := scanPaymentMethodRow(s.Pool.QueryRow(ctx,
		`SELECT id, type, card_brand, card_last4, is_active, created_at, psp_payment_method_ref
		 FROM payment_methods
		 WHERE customer_id = $1 AND psp_account_id = $2 AND psp_payment_method_ref = $3`,
		customerID, pspAccountID, pspPaymentMethodRef,
	))
	if err == nil {
		return existing, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return PaymentMethodRow{}, fmt.Errorf("api: query existing payment_methods row: %w", err)
	}

	id, err := uuid.NewV7()
	if err != nil {
		return PaymentMethodRow{}, fmt.Errorf("api: generate payment_methods id: %w", err)
	}
	_, err = s.Pool.Exec(ctx,
		`INSERT INTO payment_methods (id, customer_id, psp_account_id, psp_payment_method_ref, type, is_active)
		 VALUES ($1, $2, $3, $4, 'card', true)`,
		id.String(), customerID, pspAccountID, pspPaymentMethodRef,
	)
	if err != nil {
		return PaymentMethodRow{}, fmt.Errorf("api: insert payment_methods row: %w", err)
	}

	return scanPaymentMethodRow(s.Pool.QueryRow(ctx,
		`SELECT id, type, card_brand, card_last4, is_active, created_at, psp_payment_method_ref
		 FROM payment_methods WHERE id = $1`,
		id.String(),
	))
}

func scanPaymentMethodRow(row pgx.Row) (PaymentMethodRow, error) {
	var r PaymentMethodRow
	err := row.Scan(&r.ID, &r.Type, &r.CardBrand, &r.CardLast4, &r.IsActive, &r.CreatedAt, &r.PspPaymentMethodRef)
	return r, err
}

// LookupCustomerEmail mirrors the TS route's inline fallback lookup:
// `selectFrom('customers').select('email').where('id','=',customerId).executeTakeFirst())?.email`.
func (s PgxPaymentsStore) LookupCustomerEmail(ctx context.Context, customerID string) (string, bool, error) {
	var email *string
	err := s.Pool.QueryRow(ctx,
		`SELECT email FROM customers WHERE id = $1`,
		customerID,
	).Scan(&email)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", false, nil
		}
		return "", false, fmt.Errorf("api: query customers email: %w", err)
	}
	if email == nil || *email == "" {
		return "", false, nil
	}
	return *email, true, nil
}

// RecordAttempt mirrors the TS route's
// `insertInto('payment_attempts').values({...}).onConflict((oc) => oc.columns(['payment_id','attempt_number']).doNothing()).execute()`
// — a REAL ON CONFLICT DO NOTHING (unlike UpsertPaymentMethod's plain
// check-then-insert above), matching the TS source's own two different
// idioms exactly rather than normalizing them to one Go pattern.
func (s PgxPaymentsStore) RecordAttempt(ctx context.Context, input RecordAttemptRow) error {
	id, err := uuid.NewV7()
	if err != nil {
		return fmt.Errorf("api: generate payment_attempts id: %w", err)
	}
	_, err = s.Pool.Exec(ctx,
		`INSERT INTO payment_attempts (id, payment_id, psp_account_id, attempt_number, psp_attempt_ref, idempotency_key, status)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 ON CONFLICT (payment_id, attempt_number) DO NOTHING`,
		id.String(), input.PaymentID, input.PspAccountID, input.AttemptNumber, input.PspAttemptRef, input.IdempotencyKey, input.Status,
	)
	if err != nil {
		return fmt.Errorf("api: insert payment_attempts row: %w", err)
	}
	return nil
}

// ApplyCanonicalEvents delegates to internal/webhooks.ApplyCanonicalEvents
// — see this type's top doc comment for why this is the SAME function
// the webhook apply path and gap-detection call, not a duplicate.
func (s PgxPaymentsStore) ApplyCanonicalEvents(ctx context.Context, paymentID string, events []domain.CanonicalEvent, psp string) error {
	_, err := webhooks.ApplyCanonicalEvents(ctx, s.Webhooks, paymentID, events, psp)
	return err
}

// GetPayment mirrors the TS route's
// `selectFrom('payments').selectAll().where('id','=',id).where('product_id','=',auth.productId).executeTakeFirst()`
// — scoped by product_id (Non-negotiable: a product can only ever
// see/act on its own data).
func (s PgxPaymentsStore) GetPayment(ctx context.Context, id string, productID string) (PaymentRow, bool, error) {
	row := s.Pool.QueryRow(ctx,
		`SELECT `+paymentColumns+` FROM payments WHERE id = $1 AND product_id = $2`,
		id, productID,
	)
	p, err := scanPaymentRow(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return PaymentRow{}, false, nil
		}
		return PaymentRow{}, false, fmt.Errorf("api: query payments by id/product_id: %w", err)
	}
	return p, true, nil
}

// ListAttempts mirrors the TS route's
// `selectFrom('payment_attempts').selectAll().where('payment_id','=',id).orderBy('attempt_number','asc').execute()`.
func (s PgxPaymentsStore) ListAttempts(ctx context.Context, paymentID string) ([]AttemptRow, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT `+attemptColumns+` FROM payment_attempts WHERE payment_id = $1 ORDER BY attempt_number ASC`,
		paymentID,
	)
	if err != nil {
		return nil, fmt.Errorf("api: query payment_attempts list: %w", err)
	}
	defer rows.Close()

	var out []AttemptRow
	for rows.Next() {
		a, err := scanAttemptRow(rows)
		if err != nil {
			return nil, fmt.Errorf("api: scan payment_attempts row: %w", err)
		}
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("api: iterate payment_attempts rows: %w", err)
	}
	return out, nil
}

// ListEvents mirrors the TS route's
// `selectFrom('payment_events').select(['event_type','decline_code','occurred_at']).where('payment_id','=',id).orderBy('occurred_at','asc').execute()`.
func (s PgxPaymentsStore) ListEvents(ctx context.Context, paymentID string) ([]PaymentEventRow, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT event_type, decline_code, occurred_at FROM payment_events WHERE payment_id = $1 ORDER BY occurred_at ASC`,
		paymentID,
	)
	if err != nil {
		return nil, fmt.Errorf("api: query payment_events list: %w", err)
	}
	defer rows.Close()

	var out []PaymentEventRow
	for rows.Next() {
		var e PaymentEventRow
		if err := rows.Scan(&e.EventType, &e.DeclineCode, &e.OccurredAt); err != nil {
			return nil, fmt.Errorf("api: scan payment_events row: %w", err)
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("api: iterate payment_events rows: %w", err)
	}
	return out, nil
}

// ListPayments mirrors the TS route's ListPayments query exactly:
// scoped by product_id; optionally filtered by customer_id/state/
// created_at range; keyset-paginated by id (UUIDv7 primary keys are
// time-sortable, so `id` doubles as a stable cursor — WHERE id < cursor
// ORDER BY id DESC, matching the TS source's own comment verbatim).
// query.Limit+1 rows are fetched so the handler (payments.go's
// handleListPayments) can compute hasMore/nextCursor from whether the
// extra row came back, exactly matching the TS handler's own division
// of labor (this store method does NOT trim to Limit itself).
func (s PgxPaymentsStore) ListPayments(ctx context.Context, productID string, query ListPaymentsQuery) ([]PaymentRow, error) {
	sql := `SELECT ` + paymentColumns + ` FROM payments WHERE product_id = $1`
	args := []any{productID}

	if query.CustomerID != nil {
		args = append(args, *query.CustomerID)
		sql += fmt.Sprintf(" AND customer_id = $%d", len(args))
	}
	if query.State != nil {
		args = append(args, *query.State)
		sql += fmt.Sprintf(" AND state = $%d", len(args))
	}
	if query.CreatedAfter != nil {
		args = append(args, *query.CreatedAfter)
		sql += fmt.Sprintf(" AND created_at >= $%d", len(args))
	}
	if query.CreatedBefore != nil {
		args = append(args, *query.CreatedBefore)
		sql += fmt.Sprintf(" AND created_at <= $%d", len(args))
	}
	if query.Cursor != nil {
		args = append(args, *query.Cursor)
		sql += fmt.Sprintf(" AND id < $%d", len(args))
	}

	limit := query.Limit
	if limit <= 0 {
		limit = 20
	}
	args = append(args, limit+1)
	sql += fmt.Sprintf(" ORDER BY id DESC LIMIT $%d", len(args))

	rows, err := s.Pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("api: query payments list: %w", err)
	}
	defer rows.Close()

	var out []PaymentRow
	for rows.Next() {
		p, err := scanPaymentRow(rows)
		if err != nil {
			return nil, fmt.Errorf("api: scan payments list row: %w", err)
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("api: iterate payments list rows: %w", err)
	}
	return out, nil
}

// checkoutSessionColumns is the exact column list/order every
// checkout_sessions SELECT in this file uses, matching paymentColumns's
// own established pattern so scanCheckoutSessionRow can be shared
// verbatim across every call site.
const checkoutSessionColumns = `id, merchant_entity_id, product_id, customer_id, amount_minor_units, currency, cit_mit, psp_account_id, client_secret_hash, status, payment_id, created_at, expires_at`

func scanCheckoutSessionRow(row pgx.Row) (CheckoutSessionRow, error) {
	var s CheckoutSessionRow
	err := row.Scan(
		&s.ID, &s.MerchantEntityID, &s.ProductID, &s.CustomerID, &s.AmountMinor, &s.Currency, &s.CitMit,
		&s.PspAccountID, &s.ClientSecretHash, &s.Status, &s.PaymentID, &s.CreatedAt, &s.ExpiresAt,
	)
	if err != nil {
		return CheckoutSessionRow{}, err
	}
	return s, nil
}

// CreateCheckoutSession implements CheckoutSessionsStore — a plain
// INSERT ... RETURNING, mirroring CreatePayment's own shape exactly
// (generate a UUIDv7 id in application code, matching this whole
// codebase's "no DEFAULT gen_random_uuid()" convention — see the
// core-schema migration's own top doc comment). status/created_at both
// default at the schema level ('open'/now()), so neither is set
// explicitly here, matching CreatePayment's own "no explicit state
// value on insert" comment.
func (s PgxPaymentsStore) CreateCheckoutSession(ctx context.Context, input CreateCheckoutSessionRow) (CheckoutSessionRow, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return CheckoutSessionRow{}, fmt.Errorf("api: generate checkout_sessions id: %w", err)
	}

	row := s.Pool.QueryRow(ctx,
		`INSERT INTO checkout_sessions (id, merchant_entity_id, product_id, customer_id, amount_minor_units, currency, cit_mit, psp_account_id, client_secret_hash, expires_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		 RETURNING `+checkoutSessionColumns,
		id.String(), input.MerchantEntityID, input.ProductID, input.CustomerID, input.AmountMinor, input.Currency,
		input.CitMit, input.PspAccountID, input.ClientSecretHash, input.ExpiresAt,
	)
	session, err := scanCheckoutSessionRow(row)
	if err != nil {
		return CheckoutSessionRow{}, fmt.Errorf("api: insert checkout_sessions row: %w", err)
	}
	return session, nil
}

// GetCheckoutSession implements CheckoutSessionsStore — looked up by id
// alone (NOT scoped by merchant_entity_id/product_id the way
// GetPayment scopes by product_id), because the two callers of this
// method (checkout_sessions.go's authenticateCheckoutSession, called
// from the clientSecret-authenticated GET .../public and
// POST .../confirm routes) have no Bearer auth context to scope by in
// the first place — the client secret itself, verified by the caller
// AFTER this returns, is what stands in for that authorization check
// here. See authenticateCheckoutSession's own doc comment for the
// full security-ordering rationale.
func (s PgxPaymentsStore) GetCheckoutSession(ctx context.Context, id string) (CheckoutSessionRow, bool, error) {
	row := s.Pool.QueryRow(ctx,
		`SELECT `+checkoutSessionColumns+` FROM checkout_sessions WHERE id = $1`,
		id,
	)
	session, err := scanCheckoutSessionRow(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return CheckoutSessionRow{}, false, nil
		}
		return CheckoutSessionRow{}, false, fmt.Errorf("api: query checkout_sessions by id: %w", err)
	}
	return session, true, nil
}

// MarkCheckoutSessionConsumed implements CheckoutSessionsStore — flips
// status to 'consumed' and records payment_id, once, after
// checkout_sessions.go's confirm handler has already successfully
// created the payment. Deliberately does NOT check the current status
// first (no WHERE status = 'open' guard) — by the time this is called,
// WithIdempotencyKey has already ensured the attempt-creation flow only
// ever runs once per session id (see checkoutSessionIdempotencyKey's
// doc comment), so a second call to THIS specific method for the same
// session id in the current code path never happens; being unconditional
// here simply means this method does exactly one thing (set these two
// columns) without re-deriving invariants its one caller already
// enforces upstream.
func (s PgxPaymentsStore) MarkCheckoutSessionConsumed(ctx context.Context, id string, paymentID string) error {
	// updated_at = now() added alongside the Stripe integration audit's
	// checkout_sessions.updated_at migration (2026-07-12, Task #321) —
	// the one place this row is ever mutated in place now keeps that
	// column meaningful instead of leaving it permanently equal to
	// created_at.
	_, err := s.Pool.Exec(ctx,
		`UPDATE checkout_sessions SET status = 'consumed', payment_id = $1, updated_at = now() WHERE id = $2`,
		paymentID, id,
	)
	if err != nil {
		return fmt.Errorf("api: update checkout_sessions status=consumed: %w", err)
	}
	return nil
}

// retrySettingsColumns is the exact column list/order every
// retry_settings SELECT in this file uses, matching paymentColumns'/
// checkoutSessionColumns' own established pattern.
const retrySettingsColumns = `merchant_entity_id, dunning_ladder_hours, max_attempts_per_payment, min_spacing_seconds, updated_at`

// scanRetrySettingsRow scans a retry_settings row. dunning_ladder_hours
// is a Postgres `integer[]` column — pgx v5's default type map scans a
// Postgres integer[] into a Go []int32 (NOT plain []int, which is not
// one of pgx's built-in fixed-width array element types), so this scans
// into a local []int32 first and converts element-by-element into the
// []int this package's RetrySettingsRow/RetrySettingsDTO already use
// everywhere else (matching every other int-typed column in this
// package, e.g. PaymentRow.AmountMinor's sibling int-typed fields
// elsewhere, none of which use int32). This int32<->int conversion path
// is this feature's single least-verified piece of pgx-specific
// behavior — flagged explicitly in MIGRATION_NOTES.md's Configurable
// Retry/Dunning Policy section's least-confident list, since it could
// not be exercised against a live Postgres/pgx round-trip in this
// sandbox.
func scanRetrySettingsRow(row pgx.Row) (RetrySettingsRow, error) {
	var r RetrySettingsRow
	var hours []int32
	err := row.Scan(&r.MerchantEntityID, &hours, &r.MaxAttemptsPerPayment, &r.MinSpacingSeconds, &r.UpdatedAt)
	if err != nil {
		return RetrySettingsRow{}, err
	}
	r.DunningLadderHours = make([]int, len(hours))
	for i, h := range hours {
		r.DunningLadderHours[i] = int(h)
	}
	return r, nil
}

// GetRetrySettings implements RetrySettingsStore — a plain SELECT by
// primary key. Returns (zero value, false, nil) when no row exists yet
// for this merchant entity, matching pgx.ErrNoRows -> (false, nil)
// exactly like GetCheckoutSession/FindPaymentByIdempotencyKey's own
// "not found is not an error" convention elsewhere in this file. This
// is the expected, common case for a merchant entity that has never
// called PUT /v1/retry-settings — see retry_settings.go's
// handleGetRetrySettings for what the HTTP layer does with `false`
// here (falls back to hardcoded defaults, never inserts a row itself).
func (s PgxPaymentsStore) GetRetrySettings(ctx context.Context, merchantEntityID string) (RetrySettingsRow, bool, error) {
	row := s.Pool.QueryRow(ctx,
		`SELECT `+retrySettingsColumns+` FROM retry_settings WHERE merchant_entity_id = $1`,
		merchantEntityID,
	)
	settings, err := scanRetrySettingsRow(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return RetrySettingsRow{}, false, nil
		}
		return RetrySettingsRow{}, false, fmt.Errorf("api: query retry_settings by merchant_entity_id: %w", err)
	}
	return settings, true, nil
}

// UpsertRetrySettings implements RetrySettingsStore — a single
// INSERT ... ON CONFLICT (merchant_entity_id) DO UPDATE, which is what
// makes this resource genuinely a singleton-per-merchant-entity row:
// the FIRST call for a given merchant entity inserts a fresh row (the
// "lazily created on first PUT" behavior retry_settings.go's top doc
// comment and the migration's own doc comment both describe); every
// subsequent call updates that same row in place rather than erroring
// on the primary-key conflict or creating a duplicate. updated_at is
// set explicitly to now() on the UPDATE branch (rather than relying on
// a trigger, which this schema does not use anywhere — see
// merchant_entities/products' own plain `DEFAULT now()` columns with no
// update trigger either) so a PUT always reflects the moment it was
// actually written, matching the table's own doc comment.
//
// dunning_ladder_hours is passed as a []int32 explicitly, converting
// from the []int this package's UpsertRetrySettingsInput carries — the
// pgx v5 write-side counterpart of scanRetrySettingsRow's read-side
// []int32->[]int conversion above; pgx's default type map encodes a Go
// []int32 as a Postgres integer[] directly, but a plain Go []int has no
// such built-in encoding (int's width is platform-dependent; int32's is
// not) — this conversion is the other half of this feature's single
// least-verified pgx-specific behavior, flagged in MIGRATION_NOTES.md
// alongside the read-side one.
func (s PgxPaymentsStore) UpsertRetrySettings(ctx context.Context, merchantEntityID string, input UpsertRetrySettingsInput) (RetrySettingsRow, error) {
	hours := make([]int32, len(input.DunningLadderHours))
	for i, h := range input.DunningLadderHours {
		hours[i] = int32(h)
	}

	row := s.Pool.QueryRow(ctx,
		`INSERT INTO retry_settings (merchant_entity_id, dunning_ladder_hours, max_attempts_per_payment, min_spacing_seconds, updated_at)
		 VALUES ($1, $2, $3, $4, now())
		 ON CONFLICT (merchant_entity_id) DO UPDATE SET
		   dunning_ladder_hours = EXCLUDED.dunning_ladder_hours,
		   max_attempts_per_payment = EXCLUDED.max_attempts_per_payment,
		   min_spacing_seconds = EXCLUDED.min_spacing_seconds,
		   updated_at = now()
		 RETURNING `+retrySettingsColumns,
		merchantEntityID, hours, input.MaxAttemptsPerPayment, input.MinSpacingSeconds,
	)
	settings, err := scanRetrySettingsRow(row)
	if err != nil {
		return RetrySettingsRow{}, fmt.Errorf("api: upsert retry_settings row: %w", err)
	}
	return settings, nil
}

// planColumns is the exact column list/order every plans SELECT in
// this file uses, matching paymentColumns'/checkoutSessionColumns'/
// retrySettingsColumns' own established pattern.
const planColumns = `id, merchant_entity_id, name, type, billing_interval_amount, billing_interval_unit, base_price_minor_units, base_price_currency, tax_collection, trial_enabled, trial_interval_amount, trial_interval_unit, trial_price_minor_units, trial_price_currency, created_at, updated_at`

// planRuleColumns is the exact column list/order every plan_price_rules
// SELECT in this file uses.
const planRuleColumns = `id, applies_to, currency, countries, amount_minor_units`

// scanPlanRow scans one plans row (WITHOUT its rules — see
// loadPlanRules below, called separately by every method that needs
// them, matching this file's general "one query per table" shape
// rather than a single join query, since a plan has a variable number
// of rule rows that would otherwise need GROUP BY/array_agg
// gymnastics this port's author judged riskier to get right without a
// compiler than two plain queries).
func scanPlanRow(row pgx.Row) (PlanRow, error) {
	var p PlanRow
	err := row.Scan(
		&p.ID, &p.MerchantEntityID, &p.Name, &p.Type,
		&p.BillingIntervalAmount, &p.BillingIntervalUnit,
		&p.BasePriceMinorUnits, &p.BasePriceCurrency,
		&p.TaxCollection, &p.TrialEnabled,
		&p.TrialIntervalAmount, &p.TrialIntervalUnit,
		&p.TrialPriceMinorUnits, &p.TrialPriceCurrency,
		&p.CreatedAt, &p.UpdatedAt,
	)
	return p, err
}

// scanPlanRuleRow scans one plan_price_rules row. countries is a
// Postgres text[] column — pgx v5's default type map scans this
// directly into a Go []string with no int-width ambiguity to resolve
// (unlike retry_settings.dunning_ladder_hours's integer[]/[]int32
// conversion — see scanRetrySettingsRow's own doc comment for that
// case; text[]/[]string has no such built-in-element-type mismatch),
// so this scans straight into PlanPriceRuleRow.Countries with no
// intermediate conversion step.
func scanPlanRuleRow(row pgx.Row) (PlanPriceRuleRow, error) {
	var r PlanPriceRuleRow
	err := row.Scan(&r.ID, &r.AppliesTo, &r.Currency, &r.Countries, &r.AmountMinorUnits)
	return r, err
}

// loadPlanRules fetches every plan_price_rules row for planID, ordered
// by id for deterministic output — called by GetPlan/ListPlans/
// CreatePlan/UpdatePlan alike (via a shared querier — either the pool
// itself, for a plain read, or the tx, when called from inside
// CreatePlan/UpdatePlan's own transaction, immediately after inserting
// the rows it's about to read back) so serializePlan always sees the
// exact rows that were actually written.
func loadPlanRules(ctx context.Context, q pgxQuerier, planID string) ([]PlanPriceRuleRow, error) {
	rows, err := q.Query(ctx,
		`SELECT `+planRuleColumns+` FROM plan_price_rules WHERE plan_id = $1 ORDER BY id ASC`,
		planID,
	)
	if err != nil {
		return nil, fmt.Errorf("api: query plan_price_rules list: %w", err)
	}
	defer rows.Close()

	var out []PlanPriceRuleRow
	for rows.Next() {
		r, err := scanPlanRuleRow(rows)
		if err != nil {
			return nil, fmt.Errorf("api: scan plan_price_rules row: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("api: iterate plan_price_rules rows: %w", err)
	}
	return out, nil
}

// pgxQuerier is the minimal method set loadPlanRules/insertPlanRules
// need — satisfied structurally by both *pgxpool.Pool and pgx.Tx
// (matching internal/statemachine/db.go's own Querier-style interface
// for the exact same "this helper works identically whether called
// with a bare pool or inside an already-open transaction" reason),
// so these two helpers can be shared between GetPlan/ListPlans (plain
// pool reads) and CreatePlan/UpdatePlan (inside a transaction) without
// duplicating either function's body.
type pgxQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// insertPlanRules inserts every rule in rules for planID, generating a
// fresh UUIDv7 id for each — shared by CreatePlan (fresh insert) and
// UpdatePlan (re-insert after a delete-all, see UpdatePlan's own doc
// comment for why a full delete-then-reinsert was chosen over a
// diff-based reconciliation).
func insertPlanRules(ctx context.Context, q pgxQuerier, planID string, rules []PlanPriceRuleInput) error {
	for _, rule := range rules {
		id, err := uuid.NewV7()
		if err != nil {
			return fmt.Errorf("api: generate plan_price_rules id: %w", err)
		}
		_, err = q.Exec(ctx,
			`INSERT INTO plan_price_rules (id, plan_id, applies_to, currency, countries, amount_minor_units)
			 VALUES ($1, $2, $3, $4, $5, $6)`,
			id.String(), planID, rule.AppliesTo, rule.Currency, rule.Countries, rule.AmountMinorUnits,
		)
		if err != nil {
			return fmt.Errorf("api: insert plan_price_rules row: %w", err)
		}
	}
	return nil
}

// CreatePlan implements PlansStore — wraps the plans row INSERT and
// its plan_price_rules rows' INSERTs in a single transaction (all-or-
// nothing, per this task's explicit instruction: a plan is never left
// half-written with some rules persisted and others not, and a
// failure partway through rolls back the plan row itself too, not
// just the remaining rules). Mirrors CreatePayment's own "generate a
// UUIDv7 id in application code" convention (no
// DEFAULT gen_random_uuid() anywhere in this schema).
func (s PgxPaymentsStore) CreatePlan(ctx context.Context, input CreatePlanRow) (PlanRow, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return PlanRow{}, fmt.Errorf("api: generate plans id: %w", err)
	}

	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return PlanRow{}, fmt.Errorf("api: begin create-plan tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // safe no-op after a successful Commit (pgx.ErrTxClosed)

	row := tx.QueryRow(ctx,
		`INSERT INTO plans (id, merchant_entity_id, name, type, billing_interval_amount, billing_interval_unit, base_price_minor_units, base_price_currency, tax_collection, trial_enabled, trial_interval_amount, trial_interval_unit, trial_price_minor_units, trial_price_currency)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
		 RETURNING `+planColumns,
		id.String(), input.MerchantEntityID, input.Name, input.Type,
		input.BillingIntervalAmount, input.BillingIntervalUnit,
		input.BasePriceMinorUnits, input.BasePriceCurrency,
		input.TaxCollection, input.TrialEnabled,
		input.TrialIntervalAmount, input.TrialIntervalUnit,
		input.TrialPriceMinorUnits, input.TrialPriceCurrency,
	)
	plan, err := scanPlanRow(row)
	if err != nil {
		return PlanRow{}, fmt.Errorf("api: insert plans row: %w", err)
	}

	if err := insertPlanRules(ctx, tx, plan.ID, input.Rules); err != nil {
		return PlanRow{}, err
	}

	rules, err := loadPlanRules(ctx, tx, plan.ID)
	if err != nil {
		return PlanRow{}, err
	}
	plan.Rules = rules

	if err := tx.Commit(ctx); err != nil {
		return PlanRow{}, fmt.Errorf("api: commit create-plan tx: %w", err)
	}
	return plan, nil
}

// GetPlan implements PlansStore — scoped by merchant_entity_id in the
// WHERE clause itself (Non-negotiable: a merchant can only ever see
// its own data), matching GetPayment's own product_id-scoped
// precedent, just scoped by merchant_entity_id instead per PlansStore's
// own doc comment on why plans follow customers.go's/retry_settings.go's
// merchant-entity-level scoping rather than payments'/checkout-sessions'
// product-level scoping.
func (s PgxPaymentsStore) GetPlan(ctx context.Context, id string, merchantEntityID string) (PlanRow, bool, error) {
	row := s.Pool.QueryRow(ctx,
		`SELECT `+planColumns+` FROM plans WHERE id = $1 AND merchant_entity_id = $2`,
		id, merchantEntityID,
	)
	plan, err := scanPlanRow(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return PlanRow{}, false, nil
		}
		return PlanRow{}, false, fmt.Errorf("api: query plans by id/merchant_entity_id: %w", err)
	}
	rules, err := loadPlanRules(ctx, s.Pool, plan.ID)
	if err != nil {
		return PlanRow{}, false, err
	}
	plan.Rules = rules
	return plan, true, nil
}

// ListPlans implements PlansStore — scoped by merchant_entity_id, no
// pagination (see handleListPlans's own doc comment for why). Ordered
// by created_at DESC (newest first) — matching this codebase's general
// "most recently created/updated first" list convention (e.g.
// ListPayments' id-descending keyset order, since UUIDv7 ids are
// time-sortable) even though plans has no cursor to page through yet.
func (s PgxPaymentsStore) ListPlans(ctx context.Context, merchantEntityID string) ([]PlanRow, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT `+planColumns+` FROM plans WHERE merchant_entity_id = $1 ORDER BY created_at DESC`,
		merchantEntityID,
	)
	if err != nil {
		return nil, fmt.Errorf("api: query plans list: %w", err)
	}
	var plans []PlanRow
	for rows.Next() {
		p, err := scanPlanRow(rows)
		if err != nil {
			rows.Close()
			return nil, fmt.Errorf("api: scan plans list row: %w", err)
		}
		plans = append(plans, p)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, fmt.Errorf("api: iterate plans list rows: %w", err)
	}
	rows.Close()

	for i := range plans {
		rules, err := loadPlanRules(ctx, s.Pool, plans[i].ID)
		if err != nil {
			return nil, err
		}
		plans[i].Rules = rules
	}
	return plans, nil
}

// UpdatePlan implements PlansStore — wraps the plans row UPDATE and a
// full delete-then-reinsert of its plan_price_rules rows in a single
// transaction, same all-or-nothing guarantee as CreatePlan. Scoped by
// merchant_entity_id in the UPDATE's WHERE clause itself, matching
// GetPlan's own scoping (a merchant can never update another
// merchant's plan by guessing its id).
//
// Rules are deleted and reinserted wholesale rather than diffed
// (matching a row-by-row "does this rule already exist, does it need
// updating" reconciliation) because a price-override rule has no
// natural stable identity from the CLIENT's point of view once
// created (PriceOverrideRuleDTO.ID is server-generated on create/
// update, never client-supplied on a PATCH body — see PlanRequest's
// own doc comment: this is a full-replace PATCH, not a partial merge),
// so there is nothing meaningful to diff against; delete-all-then-
// reinsert is both simpler and unambiguously correct here, at the cost
// of every rule getting a fresh id on every update (an accepted
// trade-off — a rule's id has no meaning to anything outside this
// plan's own edit form, unlike e.g. a payment's id, which is referenced
// externally).
func (s PgxPaymentsStore) UpdatePlan(ctx context.Context, id string, merchantEntityID string, input UpdatePlanRow) (PlanRow, bool, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return PlanRow{}, false, fmt.Errorf("api: begin update-plan tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // safe no-op after a successful Commit (pgx.ErrTxClosed)

	row := tx.QueryRow(ctx,
		`UPDATE plans SET
		   name = $1, type = $2, billing_interval_amount = $3, billing_interval_unit = $4,
		   base_price_minor_units = $5, base_price_currency = $6, tax_collection = $7,
		   trial_enabled = $8, trial_interval_amount = $9, trial_interval_unit = $10,
		   trial_price_minor_units = $11, trial_price_currency = $12, updated_at = now()
		 WHERE id = $13 AND merchant_entity_id = $14
		 RETURNING `+planColumns,
		input.Name, input.Type, input.BillingIntervalAmount, input.BillingIntervalUnit,
		input.BasePriceMinorUnits, input.BasePriceCurrency, input.TaxCollection,
		input.TrialEnabled, input.TrialIntervalAmount, input.TrialIntervalUnit,
		input.TrialPriceMinorUnits, input.TrialPriceCurrency,
		id, merchantEntityID,
	)
	plan, err := scanPlanRow(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// No row matched id+merchant_entity_id — either the plan
			// doesn't exist, or it belongs to a different merchant
			// entity. Either way, this is a 404 to the caller, not an
			// error; the transaction is rolled back (via the deferred
			// Rollback above) since there is nothing to commit.
			return PlanRow{}, false, nil
		}
		return PlanRow{}, false, fmt.Errorf("api: update plans row: %w", err)
	}

	if _, err := tx.Exec(ctx, `DELETE FROM plan_price_rules WHERE plan_id = $1`, plan.ID); err != nil {
		return PlanRow{}, false, fmt.Errorf("api: delete existing plan_price_rules rows: %w", err)
	}
	if err := insertPlanRules(ctx, tx, plan.ID, input.Rules); err != nil {
		return PlanRow{}, false, err
	}

	rules, err := loadPlanRules(ctx, tx, plan.ID)
	if err != nil {
		return PlanRow{}, false, err
	}
	plan.Rules = rules

	if err := tx.Commit(ctx); err != nil {
		return PlanRow{}, false, fmt.Errorf("api: commit update-plan tx: %w", err)
	}
	return plan, true, nil
}

// DeletePlan implements PlansStore — scoped by merchant_entity_id in
// the DELETE's WHERE clause itself, matching GetPlan/UpdatePlan's own
// scoping. plan_price_rules rows are removed automatically by the
// table's own ON DELETE CASCADE (see the migration's doc comment) —
// no separate DELETE statement needed here, unlike UpdatePlan's
// explicit delete-then-reinsert (which must run BEFORE the plan
// itself is touched, since UpdatePlan keeps the plan row; DeletePlan
// removes it entirely, so the FK cascade already does the rules
// cleanup for free). No transaction needed for this reason — a single
// DELETE statement is already atomic.
func (s PgxPaymentsStore) DeletePlan(ctx context.Context, id string, merchantEntityID string) (bool, error) {
	tag, err := s.Pool.Exec(ctx,
		`DELETE FROM plans WHERE id = $1 AND merchant_entity_id = $2`,
		id, merchantEntityID,
	)
	if err != nil {
		return false, fmt.Errorf("api: delete plans row: %w", err)
	}
	return tag.RowsAffected() > 0, nil
}
