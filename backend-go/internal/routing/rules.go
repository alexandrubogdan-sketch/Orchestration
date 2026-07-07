// Package routing is Phase 4 of the Go rewrite: the config-driven PSP
// routing evaluator (T5.1/T5.2), the per-psp_account circuit breaker
// (T5.3), the central same-instrument retry policy (T5.4), and the
// outbound per-psp_account rate limiter (T7.1) — ported from
// src/routing/{types,rulesRepo,evaluator,circuitBreaker,retryPolicy}.ts
// and src/routing/rateLimiter.ts.
//
// docs/adr/0007-routing-rules-engine.md, referenced by the TS source's
// own doc comments, does NOT exist on disk in this repository (checked
// explicitly via a full directory search before writing this package --
// only src/routing/evaluator.ts's comment pointing at it exists, not
// the file itself). Every invariant this package implements is
// therefore sourced from the TS files' own doc comments and their unit
// tests (test/unit/{routingEvaluator,circuitBreaker,retryPolicy,
// rateLimiter}.test.ts, test/integration/routing.test.ts), not from a
// separately-read ADR -- flagged here loudly since the task brief asked
// this ADR be checked "if present."
package routing

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// MatchCriteria mirrors RoutingMatchCriteria's wire/JSONB shape
// exactly: three optional allow-lists. A nil/empty field means
// "matches anything" for that dimension -- a rule with an empty
// MatchCriteria matches every attempt routed to its product/entity
// scope, exactly as evaluator.ts's matchesCriteria documents.
type MatchCriteria struct {
	Currency          []string `json:"currency,omitempty"`
	CitMit            []string `json:"citMit,omitempty"`
	PaymentMethodType []string `json:"paymentMethodType,omitempty"`
}

// Rule mirrors RoutingRule (src/routing/types.ts) field-for-field.
// ProductID/FallbackPspAccountID/Description are pointers because the
// TS type allows `null` for each -- nil here means the same thing null
// means there (ProductID nil == entity-wide rule).
type Rule struct {
	ID                   string
	MerchantEntityID     string
	ProductID            *string
	Priority             int
	IsEnabled            bool
	Match                MatchCriteria
	PspAccountID         string
	FallbackPspAccountID *string
	Description          *string
}

// Input mirrors RoutingInput.
type Input struct {
	ProductID         string
	Currency          string
	CitMit            string // "cit" | "mit"
	PaymentMethodType string
}

// Decision mirrors RoutingDecision.
type Decision struct {
	Strategy     string // "rule-match" | "naive-fallback"
	RuleID       *string
	PspAccountID string
	PSP          string
	Reason       string
}

// NoRoutablePspAccountError mirrors the TS NoRoutablePspAccountError
// class -- same message shape (`No routable psp_account found for
// product %s`), so log lines/error messages a human might grep for
// stay stable across the rewrite.
type NoRoutablePspAccountError struct {
	ProductID string
}

func (e *NoRoutablePspAccountError) Error() string {
	return fmt.Sprintf("No routable psp_account found for product %s", e.ProductID)
}

// MatchesCriteria mirrors evaluator.ts's matchesCriteria exactly: each
// specified dimension must include the input's value (AND across
// dimensions, not OR); an absent/empty allow-list matches anything for
// that dimension.
func MatchesCriteria(criteria MatchCriteria, input Input) bool {
	if len(criteria.Currency) > 0 && !containsString(criteria.Currency, input.Currency) {
		return false
	}
	if len(criteria.CitMit) > 0 && !containsString(criteria.CitMit, input.CitMit) {
		return false
	}
	if len(criteria.PaymentMethodType) > 0 && !containsString(criteria.PaymentMethodType, input.PaymentMethodType) {
		return false
	}
	return true
}

func containsString(list []string, needle string) bool {
	for _, v := range list {
		if v == needle {
			return true
		}
	}
	return false
}

// SortRules mirrors evaluator.ts's sortRules exactly: ascending
// priority; a product-specific rule (ProductID != nil) breaks a
// priority tie against an entity-wide rule (ProductID == nil). Returns
// a new slice -- the input slice is never mutated, matching the TS
// version's `[...rules].sort(...)` copy-then-sort. sort.SliceStable is
// used deliberately (not sort.Slice, which is not guaranteed stable)
// so that already-ordered input stays in the same relative order,
// matching the TS test's explicit "is stable ... for already-ordered
// input" case.
func SortRules(rules []Rule) []Rule {
	out := make([]Rule, len(rules))
	copy(out, rules)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Priority != out[j].Priority {
			return out[i].Priority < out[j].Priority
		}
		aSpecific := out[i].ProductID != nil
		bSpecific := out[j].ProductID != nil
		// A product-specific rule (aSpecific) wins a priority tie
		// against an entity-wide rule.
		return aSpecific && !bSpecific
	})
	return out
}

// pspAccountAvailability is the minimal shape availablePsp needs about
// a psp_accounts row.
type pspAccountAvailability struct {
	PSP       string
	IsEnabled bool
}

// Querier is the minimal pgx surface audit.go's writeAudit needs --
// satisfied structurally by *pgxpool.Pool (and by pgx.Tx, for a future
// caller that wraps rule mutations in an explicit transaction). Kept
// narrow and local to this package rather than importing a shared DB
// interface from elsewhere, matching this port's existing preference
// (see internal/api/pgstore.go) for small package-local interfaces
// over a single shared DB abstraction.
type Querier interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// RulesRepo is the Postgres-backed routing_rules reader/writer --
// T5.1's repository layer, ported from rulesRepo.ts. Every write path
// (Create/Update/Delete) writes a routing_rules_audit row (audit.go)
// and invalidates the Redis cache (cache.go) for every cache key that
// could be affected -- see Cache's doc comment for exactly which keys.
type RulesRepo struct {
	pool  *pgxpool.Pool
	cache *Cache
}

// NewRulesRepo constructs a RulesRepo. cache may be nil, in which case
// every read goes straight to Postgres (no caching) -- useful for
// tests or a deployment that hasn't provisioned Redis for routing yet;
// production wiring should always supply a real *Cache.
func NewRulesRepo(pool *pgxpool.Pool, cache *Cache) *RulesRepo {
	return &RulesRepo{pool: pool, cache: cache}
}

// ruleRow mirrors one routing_rules row as scanned from Postgres.
type ruleRow struct {
	ID                   string
	MerchantEntityID     string
	ProductID            *string
	Priority             int
	IsEnabled            bool
	Match                []byte // raw jsonb bytes
	PspAccountID         string
	FallbackPspAccountID *string
	Description          *string
}

func (row ruleRow) toRule() (Rule, error) {
	var match MatchCriteria
	if len(row.Match) > 0 {
		if err := json.Unmarshal(row.Match, &match); err != nil {
			return Rule{}, fmt.Errorf("routing: unmarshal routing_rules.match for rule %s: %w", row.ID, err)
		}
	}
	return Rule{
		ID:                   row.ID,
		MerchantEntityID:     row.MerchantEntityID,
		ProductID:            row.ProductID,
		Priority:             row.Priority,
		IsEnabled:            row.IsEnabled,
		Match:                match,
		PspAccountID:         row.PspAccountID,
		FallbackPspAccountID: row.FallbackPspAccountID,
		Description:          row.Description,
	}, nil
}

// ListActiveRules mirrors rulesRepo.ts's listActiveRules exactly:
// every enabled rule visible to productID -- both rules scoped to this
// exact product AND entity-wide rules (product_id IS NULL) -- ordered
// by priority ascending. Cached per (merchantEntityID, productID) pair
// with a 300s TTL (cache.go) when r.cache is non-nil; a cache miss (or
// no cache configured) falls through to Postgres and repopulates the
// cache.
func (r *RulesRepo) ListActiveRules(ctx context.Context, merchantEntityID, productID string) ([]Rule, error) {
	if r.cache != nil {
		if cached, ok, err := r.cache.Get(ctx, merchantEntityID, productID); err != nil {
			return nil, err
		} else if ok {
			return cached, nil
		}
	}

	rows, err := r.pool.Query(ctx, `
		SELECT id, merchant_entity_id, product_id, priority, is_enabled,
		       match, psp_account_id, fallback_psp_account_id, description
		FROM routing_rules
		WHERE merchant_entity_id = $1
		  AND (product_id = $2 OR product_id IS NULL)
		  AND is_enabled = true
		ORDER BY priority ASC
	`, merchantEntityID, productID)
	if err != nil {
		return nil, fmt.Errorf("routing: query routing_rules: %w", err)
	}
	defer rows.Close()

	var rules []Rule
	for rows.Next() {
		var row ruleRow
		if err := rows.Scan(
			&row.ID, &row.MerchantEntityID, &row.ProductID, &row.Priority, &row.IsEnabled,
			&row.Match, &row.PspAccountID, &row.FallbackPspAccountID, &row.Description,
		); err != nil {
			return nil, fmt.Errorf("routing: scan routing_rules row: %w", err)
		}
		rule, err := row.toRule()
		if err != nil {
			return nil, err
		}
		rules = append(rules, rule)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("routing: iterate routing_rules rows: %w", err)
	}

	if r.cache != nil {
		if err := r.cache.Set(ctx, merchantEntityID, productID, rules); err != nil {
			return nil, err
		}
	}
	return rules, nil
}

// availablePsp mirrors evaluator.ts's availablePsp helper: an account
// is available if it exists, is_enabled, and the circuit breaker
// reports it as available (i.e. not fully open).
func availablePsp(ctx context.Context, pool *pgxpool.Pool, breaker *CircuitBreaker, pspAccountID string) (*pspAccountAvailability, error) {
	var acct pspAccountAvailability
	err := pool.QueryRow(ctx, `SELECT psp, is_enabled FROM psp_accounts WHERE id = $1`, pspAccountID).
		Scan(&acct.PSP, &acct.IsEnabled)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("routing: query psp_accounts: %w", err)
	}
	if !acct.IsEnabled {
		return nil, nil
	}
	available, err := breaker.IsAvailable(ctx, pspAccountID)
	if err != nil {
		return nil, err
	}
	if !available {
		return nil, nil
	}
	return &acct, nil
}

// Evaluator is T5.2's routing evaluator -- the Go port of
// evaluator.ts's evaluateRouting. Rules are evaluated in ascending
// priority order (SortRules); the first rule whose Match criteria fit
// the Input AND whose target psp_account is enabled and not
// circuit-broken wins. If the primary account is unavailable but the
// rule names a FallbackPspAccountID that IS available, that fallback
// is used instead; otherwise evaluation falls through to the
// next-lower-priority matching rule. If no routing_rules row matches
// at all (including a merchant with zero rules configured), this
// falls back to the naive strategy: the lowest-id enabled, available
// psp_account for the product's merchant entity (every primary key in
// this schema is an app-generated UUIDv7 -- see MIGRATION_NOTES.md's
// Phase 1 section on UUIDs being app-generated, not DB-generated,
// which is what makes ORDER BY id ASC equivalent to ORDER BY
// created_at ASC here).
type Evaluator struct {
	pool    *pgxpool.Pool
	repo    *RulesRepo
	breaker *CircuitBreaker
}

// NewEvaluator constructs an Evaluator.
func NewEvaluator(pool *pgxpool.Pool, repo *RulesRepo, breaker *CircuitBreaker) *Evaluator {
	return &Evaluator{pool: pool, repo: repo, breaker: breaker}
}

// Resolve mirrors evaluateRouting exactly, including its exact
// `reason` string templates (kept byte-for-byte identical to the TS
// source, since these strings are surfaced in payments.routing_decision
// for support/debugging -- a human or a saved dashboard filter may
// already be matching on their exact wording).
func (e *Evaluator) Resolve(ctx context.Context, input Input) (Decision, error) {
	var merchantEntityID string
	err := e.pool.QueryRow(ctx, `SELECT merchant_entity_id FROM products WHERE id = $1`, input.ProductID).
		Scan(&merchantEntityID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return Decision{}, &NoRoutablePspAccountError{ProductID: input.ProductID}
		}
		return Decision{}, fmt.Errorf("routing: query products: %w", err)
	}

	rules, err := e.repo.ListActiveRules(ctx, merchantEntityID, input.ProductID)
	if err != nil {
		return Decision{}, err
	}

	for _, rule := range SortRules(rules) {
		if !MatchesCriteria(rule.Match, input) {
			continue
		}

		primary, err := availablePsp(ctx, e.pool, e.breaker, rule.PspAccountID)
		if err != nil {
			return Decision{}, err
		}
		if primary != nil {
			ruleID := rule.ID
			return Decision{
				Strategy:     "rule-match",
				RuleID:       &ruleID,
				PspAccountID: rule.PspAccountID,
				PSP:          primary.PSP,
				Reason:       fmt.Sprintf("matched routing_rules row %s (priority %d)", rule.ID, rule.Priority),
			}, nil
		}

		if rule.FallbackPspAccountID != nil {
			fallback, err := availablePsp(ctx, e.pool, e.breaker, *rule.FallbackPspAccountID)
			if err != nil {
				return Decision{}, err
			}
			if fallback != nil {
				ruleID := rule.ID
				return Decision{
					Strategy:     "rule-match",
					RuleID:       &ruleID,
					PspAccountID: *rule.FallbackPspAccountID,
					PSP:          fallback.PSP,
					Reason:       fmt.Sprintf("matched routing_rules row %s; primary psp_account's circuit breaker was open, used its configured fallback", rule.ID),
				}, nil
			}
		}
		// Neither the primary nor its fallback is available -- fall
		// through to the next-lower-priority matching rule rather than
		// failing here.
	}

	rows, err := e.pool.Query(ctx, `
		SELECT id, psp FROM psp_accounts
		WHERE merchant_entity_id = $1 AND is_enabled = true
		ORDER BY id ASC
	`, merchantEntityID)
	if err != nil {
		return Decision{}, fmt.Errorf("routing: query psp_accounts naive fallback: %w", err)
	}
	defer rows.Close()

	type candidate struct {
		ID  string
		PSP string
	}
	var candidates []candidate
	for rows.Next() {
		var c candidate
		if err := rows.Scan(&c.ID, &c.PSP); err != nil {
			return Decision{}, fmt.Errorf("routing: scan psp_accounts naive fallback row: %w", err)
		}
		candidates = append(candidates, c)
	}
	if err := rows.Err(); err != nil {
		return Decision{}, fmt.Errorf("routing: iterate psp_accounts naive fallback rows: %w", err)
	}

	for _, c := range candidates {
		available, err := e.breaker.IsAvailable(ctx, c.ID)
		if err != nil {
			return Decision{}, err
		}
		if available {
			return Decision{
				Strategy:     "naive-fallback",
				RuleID:       nil,
				PspAccountID: c.ID,
				PSP:          c.PSP,
				Reason:       "no matching/available routing_rules row; used lowest-id enabled psp_account",
			}, nil
		}
	}

	return Decision{}, &NoRoutablePspAccountError{ProductID: input.ProductID}
}
