package routing

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// This file is the Go port of rulesRepo.ts's write path:
// createRule/updateRule/deleteRule plus the routing_rules_audit writer
// every one of them calls. routing_rules_audit is one of this
// project's append-only tables (see MIGRATION_NOTES.md's Phase 1
// section on the BEFORE UPDATE OR DELETE ... RAISE EXCEPTION trigger
// enforcing that) -- this file only ever INSERTs into it, never
// UPDATEs/DELETEs, matching that invariant.

// AuditAction mirrors the TS `'created' | 'updated' | 'deleted'`
// union exactly.
type AuditAction string

const (
	AuditActionCreated AuditAction = "created"
	AuditActionUpdated AuditAction = "updated"
	AuditActionDeleted AuditAction = "deleted"
)

// writeAudit mirrors rulesRepo.ts's writeAudit: one INSERT into
// routing_rules_audit per rule mutation, snapshotting the rule's full
// post-mutation state as JSON (matching the TS
// `snapshot: JSON.stringify(snapshot)` call -- snapshot here is always
// a Rule, mirroring every real call site in rulesRepo.ts, which always
// passes the freshly-toRule()'d row, never a partial patch).
func writeAudit(ctx context.Context, pool Querier, routingRuleID string, action AuditAction, snapshot Rule, actor *string) error {
	snapshotJSON, err := json.Marshal(snapshot)
	if err != nil {
		return fmt.Errorf("routing: marshal audit snapshot for rule %s: %w", routingRuleID, err)
	}
	id, err := uuid.NewV7()
	if err != nil {
		return fmt.Errorf("routing: generate audit row id: %w", err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO routing_rules_audit (id, routing_rule_id, action, snapshot, actor)
		VALUES ($1, $2, $3, $4, $5)
	`, id.String(), routingRuleID, string(action), snapshotJSON, actor)
	if err != nil {
		return fmt.Errorf("routing: insert routing_rules_audit: %w", err)
	}
	return nil
}

// CreateRuleInput mirrors CreateRoutingRuleInput.
type CreateRuleInput struct {
	MerchantEntityID     string
	ProductID            *string
	Priority             int
	IsEnabled            *bool // nil => defaults to true, matching `input.isEnabled ?? true`
	Match                *MatchCriteria
	PspAccountID         string
	FallbackPspAccountID *string
	Description          *string
	Actor                *string
}

// CreateRule mirrors rulesRepo.ts's createRule: INSERT, write the
// audit row, then invalidate every cache key for the entity.
func (r *RulesRepo) CreateRule(ctx context.Context, input CreateRuleInput) (Rule, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return Rule{}, fmt.Errorf("routing: generate rule id: %w", err)
	}
	isEnabled := true
	if input.IsEnabled != nil {
		isEnabled = *input.IsEnabled
	}
	match := MatchCriteria{}
	if input.Match != nil {
		match = *input.Match
	}
	matchJSON, err := json.Marshal(match)
	if err != nil {
		return Rule{}, fmt.Errorf("routing: marshal match criteria: %w", err)
	}

	row := r.pool.QueryRow(ctx, `
		INSERT INTO routing_rules
			(id, merchant_entity_id, product_id, priority, is_enabled, match, psp_account_id, fallback_psp_account_id, description)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING id, merchant_entity_id, product_id, priority, is_enabled, match, psp_account_id, fallback_psp_account_id, description
	`, id.String(), input.MerchantEntityID, input.ProductID, input.Priority, isEnabled, matchJSON,
		input.PspAccountID, input.FallbackPspAccountID, input.Description)

	rule, err := scanRuleRow(row)
	if err != nil {
		return Rule{}, err
	}

	if err := writeAudit(ctx, r.pool, rule.ID, AuditActionCreated, rule, input.Actor); err != nil {
		return Rule{}, err
	}
	if r.cache != nil {
		if err := r.cache.InvalidateEntity(ctx, input.MerchantEntityID); err != nil {
			return Rule{}, err
		}
	}
	return rule, nil
}

// UpdateRuleInput mirrors UpdateRoutingRuleInput -- every field is a
// pointer so a nil field means "leave this column unchanged," matching
// the TS `if (patch.x !== undefined) updateValues.x = patch.x` pattern
// exactly (Go has no `undefined`, so a pointer is this port's
// equivalent of "the caller didn't mention this field at all").
type UpdateRuleInput struct {
	Priority             *int
	IsEnabled            *bool
	Match                *MatchCriteria
	PspAccountID         *string
	FallbackPspAccountID **string // outer nil = "leave unchanged"; *outer = nil = "set to NULL"
	Description          **string
	Actor                *string
}

// UpdateRule mirrors rulesRepo.ts's updateRule: a partial UPDATE
// (only the fields patch actually sets), always bumping updated_at,
// then the same audit-write + cache-invalidate tail as CreateRule.
//
// This uses Postgres's COALESCE-free explicit-column-list approach
// instead of building a dynamic SQL string, to avoid any SQL-injection
// surface from a hand-rolled query builder -- every column is updated
// unconditionally to either the patch's new value or its current
// value (fetched first), which is behaviorally identical to the TS
// version's sparse `updateValues` object for every observable purpose
// (the audit snapshot and the row returned to the caller), at the cost
// of one extra SELECT per update. Routing-rule updates are an admin
// operation (per rulesRepo.ts's own "not a hot path" note about
// `invalidate`'s use of Redis KEYS), so this trade-off favors
// simplicity/safety over shaving one round-trip.
func (r *RulesRepo) UpdateRule(ctx context.Context, id string, patch UpdateRuleInput) (Rule, error) {
	current, err := r.getRuleByID(ctx, id)
	if err != nil {
		return Rule{}, err
	}

	priority := current.Priority
	if patch.Priority != nil {
		priority = *patch.Priority
	}
	isEnabled := current.IsEnabled
	if patch.IsEnabled != nil {
		isEnabled = *patch.IsEnabled
	}
	match := current.Match
	if patch.Match != nil {
		match = *patch.Match
	}
	pspAccountID := current.PspAccountID
	if patch.PspAccountID != nil {
		pspAccountID = *patch.PspAccountID
	}
	fallbackPspAccountID := current.FallbackPspAccountID
	if patch.FallbackPspAccountID != nil {
		fallbackPspAccountID = *patch.FallbackPspAccountID
	}
	description := current.Description
	if patch.Description != nil {
		description = *patch.Description
	}

	matchJSON, err := json.Marshal(match)
	if err != nil {
		return Rule{}, fmt.Errorf("routing: marshal match criteria: %w", err)
	}

	row := r.pool.QueryRow(ctx, `
		UPDATE routing_rules
		SET priority = $2, is_enabled = $3, match = $4, psp_account_id = $5,
		    fallback_psp_account_id = $6, description = $7, updated_at = $8
		WHERE id = $1
		RETURNING id, merchant_entity_id, product_id, priority, is_enabled, match, psp_account_id, fallback_psp_account_id, description
	`, id, priority, isEnabled, matchJSON, pspAccountID, fallbackPspAccountID, description, time.Now().UTC())

	rule, err := scanRuleRow(row)
	if err != nil {
		return Rule{}, err
	}

	if err := writeAudit(ctx, r.pool, rule.ID, AuditActionUpdated, rule, patch.Actor); err != nil {
		return Rule{}, err
	}
	if r.cache != nil {
		if err := r.cache.InvalidateEntity(ctx, rule.MerchantEntityID); err != nil {
			return Rule{}, err
		}
	}
	return rule, nil
}

// DeleteRule mirrors rulesRepo.ts's deleteRule: DELETE ... RETURNING,
// a no-op if the row didn't exist (mirroring the TS
// `if (!row) return;` early return), otherwise the same audit-write +
// cache-invalidate tail.
func (r *RulesRepo) DeleteRule(ctx context.Context, id string, actor *string) error {
	row := r.pool.QueryRow(ctx, `
		DELETE FROM routing_rules
		WHERE id = $1
		RETURNING id, merchant_entity_id, product_id, priority, is_enabled, match, psp_account_id, fallback_psp_account_id, description
	`, id)

	rule, err := scanRuleRow(row)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil
		}
		return err
	}

	if err := writeAudit(ctx, r.pool, rule.ID, AuditActionDeleted, rule, actor); err != nil {
		return err
	}
	if r.cache != nil {
		if err := r.cache.InvalidateEntity(ctx, rule.MerchantEntityID); err != nil {
			return err
		}
	}
	return nil
}

func (r *RulesRepo) getRuleByID(ctx context.Context, id string) (Rule, error) {
	row := r.pool.QueryRow(ctx, `
		SELECT id, merchant_entity_id, product_id, priority, is_enabled, match, psp_account_id, fallback_psp_account_id, description
		FROM routing_rules WHERE id = $1
	`, id)
	return scanRuleRow(row)
}

// rowScanner is the minimal pgx.Row surface scanRuleRow needs --
// satisfied by both pgx.Row (from QueryRow) and, in principle, any
// other single-row scanner this package might use in tests.
type rowScanner interface {
	Scan(dest ...any) error
}

func scanRuleRow(row rowScanner) (Rule, error) {
	var rr ruleRow
	if err := row.Scan(
		&rr.ID, &rr.MerchantEntityID, &rr.ProductID, &rr.Priority, &rr.IsEnabled,
		&rr.Match, &rr.PspAccountID, &rr.FallbackPspAccountID, &rr.Description,
	); err != nil {
		if err == pgx.ErrNoRows {
			return Rule{}, err
		}
		return Rule{}, fmt.Errorf("routing: scan routing_rules row: %w", err)
	}
	return rr.toRule()
}
