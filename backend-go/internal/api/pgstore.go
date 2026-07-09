package api

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// This file provides real pgx-backed implementations of the three
// persistence interfaces this phase CAN wire for real without a
// routing engine or full DB layer: TokenStore, AuditLogWriter, and
// IdempotencyStore. All three are single-table operations against
// tables Phase 1's migrations already created (api_tokens, audit_log,
// idempotency_keys) with no dependency on routing_rules, psp_accounts
// resolution, or any other later-phase concept — unlike
// PaymentsStore/CustomersStore (payments.go/customers.go/stubs.go),
// which DO depend on the routing engine (Milestone 5) and are
// therefore left as explicit stubs in this phase.
//
// cmd/api/main.go wires these three against the real *pgxpool.Pool it
// constructs; nothing here is a stub.

// pgUniqueViolationCode is Postgres error code 23505
// (unique_violation) — the Go analogue of the TS isUniqueViolation
// helper's `(err as { code?: string }).code === '23505'` duck-typed
// check. pgx surfaces this as a *pgconn.PgError with a .Code field, so
// this port checks it the structurally-equivalent way rather than
// duck-typing, which Go's type system makes both possible and safer
// than the TS version's duck-typed check.
const pgUniqueViolationCode = "23505"

func isPgUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == pgUniqueViolationCode
	}
	return false
}

// PgxTokenStore is a real pgx-backed TokenStore.
type PgxTokenStore struct {
	Pool *pgxpool.Pool
}

// Lookup mirrors auth.ts's exact query: select id, product_id,
// merchant_entity_id from api_tokens where token_hash = $1 and
// revoked_at is null.
func (s PgxTokenStore) Lookup(ctx context.Context, tokenHash string) (TokenRow, error) {
	var row TokenRow
	err := s.Pool.QueryRow(ctx,
		`SELECT id, product_id, merchant_entity_id, scope FROM api_tokens WHERE token_hash = $1 AND revoked_at IS NULL`,
		tokenHash,
	).Scan(&row.ID, &row.ProductID, &row.MerchantEntityID, &row.Scope)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return TokenRow{}, ErrTokenNotFound
		}
		return TokenRow{}, err
	}
	return row, nil
}

// CreateAgentToken inserts a new api_tokens row tagged kind='mcp_agent'
// — see agent_tokens.go's top doc comment for why this reuses the exact
// same table/hashing scheme as the original bootstrap token rather than
// a separate one.
func (s PgxTokenStore) CreateAgentToken(ctx context.Context, input CreateAgentTokenRow) (AgentTokenRow, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return AgentTokenRow{}, err
	}
	var row AgentTokenRow
	err = s.Pool.QueryRow(ctx,
		`INSERT INTO api_tokens (id, product_id, merchant_entity_id, token_hash, description, scope, kind)
		 VALUES ($1, $2, $3, $4, $5, $6, 'mcp_agent')
		 RETURNING id, description, scope, created_at`,
		id.String(), input.ProductID, input.MerchantEntityID, input.TokenHash, input.Description, input.Scope,
	).Scan(&row.ID, &row.Description, &row.Scope, &row.CreatedAt)
	if err != nil {
		return AgentTokenRow{}, err
	}
	return row, nil
}

// ListAgentTokens returns every non-deleted mcp_agent token for a
// product, newest first, never including token_hash — the redacted
// listing agent_tokens.go's handleListAgentTokens serializes as-is.
func (s PgxTokenStore) ListAgentTokens(ctx context.Context, productID string) ([]AgentTokenRow, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT id, description, scope, created_at, last_used_at, revoked_at
		 FROM api_tokens WHERE product_id = $1 AND kind = 'mcp_agent'
		 ORDER BY created_at DESC`,
		productID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []AgentTokenRow
	for rows.Next() {
		var row AgentTokenRow
		if err := rows.Scan(&row.ID, &row.Description, &row.Scope, &row.CreatedAt, &row.LastUsedAt, &row.RevokedAt); err != nil {
			return nil, err
		}
		result = append(result, row)
	}
	return result, rows.Err()
}

// RevokeAgentToken sets revoked_at, scoped to both the token's id and
// the caller's own product_id (a caller can never revoke a token
// belonging to a different product, matching every other resource's
// ownership scoping in this package) and to kind='mcp_agent' (the
// original bootstrap token can never be revoked through this route).
func (s PgxTokenStore) RevokeAgentToken(ctx context.Context, id string, productID string) (bool, error) {
	tag, err := s.Pool.Exec(ctx,
		`UPDATE api_tokens SET revoked_at = now(), updated_at = now()
		 WHERE id = $1 AND product_id = $2 AND kind = 'mcp_agent' AND revoked_at IS NULL`,
		id, productID,
	)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// PgxAuditLogWriter is a real pgx-backed AuditLogWriter.
type PgxAuditLogWriter struct {
	Pool *pgxpool.Pool
}

// Write mirrors auth.ts's exact insert into audit_log.
func (w PgxAuditLogWriter) Write(ctx context.Context, entry AuditLogEntry) error {
	_, err := w.Pool.Exec(ctx,
		`INSERT INTO audit_log (id, api_token_id, product_id, method, path, status_code, request_id)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		entry.ID, entry.APITokenID, entry.ProductID, entry.Method, entry.Path, entry.StatusCode, entry.RequestID,
	)
	return err
}

// PgxIdempotencyStore is a real pgx-backed IdempotencyStore.
type PgxIdempotencyStore struct {
	Pool *pgxpool.Pool
}

// Insert mirrors withIdempotencyKey's
// `insertInto('idempotency_keys').values({key, request_hash, status: 'in_progress'})`.
// ProductID is deliberately not set here (nullable, audit-only column
// per the migration's own doc comment) — a later phase's route layer
// may extend this store to accept one; this phase's routes do not
// thread a product id through to this call today, matching how narrow
// this phase's PaymentsStore wiring already is.
func (s PgxIdempotencyStore) Insert(ctx context.Context, key string, requestHash string) error {
	_, err := s.Pool.Exec(ctx,
		`INSERT INTO idempotency_keys (key, request_hash, status) VALUES ($1, $2, 'in_progress')`,
		key, requestHash,
	)
	if err != nil {
		if isPgUniqueViolation(err) {
			return ErrIdempotencyKeyExists
		}
		return err
	}
	return nil
}

// Get mirrors pollForCompletion's
// `selectFrom('idempotency_keys').select([...]).where('key', '=', key)`.
//
// response_status/response_body are both nullable columns (NULL while
// status = 'in_progress' — see the core-schema migration) — scanned
// into *int/[]byte here (both accept a NULL/zero-length result without
// erroring) rather than directly into IdempotencyKeyRow.ResponseStatus
// (a plain int), since pgx returns an error scanning SQL NULL into a
// non-pointer int. This matters concretely: pollForCompletion calls
// Get repeatedly against a row that is legitimately still
// in_progress (both columns NULL) until it flips to completed, so this
// path is exercised on every single poll iteration, not just once.
func (s PgxIdempotencyStore) Get(ctx context.Context, key string) (IdempotencyKeyRow, error) {
	var row IdempotencyKeyRow
	var responseStatus *int
	var responseBodyRaw []byte
	err := s.Pool.QueryRow(ctx,
		`SELECT request_hash, status, response_status, response_body FROM idempotency_keys WHERE key = $1`,
		key,
	).Scan(&row.RequestHash, &row.Status, &responseStatus, &responseBodyRaw)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return IdempotencyKeyRow{}, ErrIdempotencyKeyNotFound
		}
		return IdempotencyKeyRow{}, err
	}
	if responseStatus != nil {
		row.ResponseStatus = *responseStatus
	}
	if len(responseBodyRaw) > 0 {
		if err := json.Unmarshal(responseBodyRaw, &row.ResponseBody); err != nil {
			return IdempotencyKeyRow{}, err
		}
	}
	return row, nil
}

// Complete mirrors withIdempotencyKey's
// `updateTable('idempotency_keys').set({status: 'completed', response_status,
// response_body, updated_at: new Date()}).where('key', '=', key)`.
func (s PgxIdempotencyStore) Complete(ctx context.Context, key string, responseStatus int, responseBody any) error {
	encoded, err := json.Marshal(responseBody)
	if err != nil {
		return err
	}
	_, err = s.Pool.Exec(ctx,
		`UPDATE idempotency_keys SET status = 'completed', response_status = $1, response_body = $2, updated_at = now() WHERE key = $3`,
		responseStatus, encoded, key,
	)
	return err
}

// Delete mirrors withIdempotencyKey's
// `deleteFrom('idempotency_keys').where('key', '=', key)` call made
// when handler() throws.
func (s PgxIdempotencyStore) Delete(ctx context.Context, key string) error {
	_, err := s.Pool.Exec(ctx, `DELETE FROM idempotency_keys WHERE key = $1`, key)
	return err
}
