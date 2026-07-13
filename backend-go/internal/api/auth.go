package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
)

// GenerateAPIToken/HashAPIToken are 1:1 ports of src/api/auth.ts's
// generateApiToken/hashApiToken:
//   - the raw token is "po_" + 24 random bytes hex-encoded (48 hex
//     chars) — Go's crypto/rand.Read is the analogue of Node's
//     randomBytes(24), both reading from the OS CSPRNG;
//   - the persisted value is always the SHA-256 hex digest of the raw
//     token, never the raw token itself.
func GenerateAPIToken() (raw string, hash string, err error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", "", err
	}
	raw = "po_" + hex.EncodeToString(buf)
	return raw, HashAPIToken(raw), nil
}

// HashAPIToken hashes a raw API token with SHA-256, hex-encoded —
// exactly matching src/api/auth.ts's
// createHash('sha256').update(raw).digest('hex').
func HashAPIToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// AuthContext mirrors the TS AuthContext interface exactly — the
// three fields every route handler needs to scope its own queries by
// (Non-negotiable: a product can only ever see/act on its own data;
// see auth.ts's own doc comment that THIS middleware only establishes
// *who* is calling — every route handler remains responsible for
// filtering by ProductID itself).
type AuthContext struct {
	APITokenID       string
	ProductID        string
	MerchantEntityID string
	// Scope is "read_write" (the default for every token created before
	// this field existed — see the agent-tokens migration) or
	// "read_only". Added for MCP agent tokens (agent_tokens.go): a
	// read_only-scoped caller can hit every GET /v1/* route but is
	// rejected 403 by RequireWriteScope below on anything mutating. A
	// zero-value AuthContext (e.g. a test double that doesn't set this
	// field) is treated as fully read_write, matching every pre-existing
	// token/test's actual behavior — see RequireWriteScope's own doc
	// comment.
	Scope string
}

// TokenRow is what TokenStore.Lookup returns for a valid, non-revoked
// token — the four columns the auth middleware actually selects (`id`,
// `product_id`, `merchant_entity_id`, `scope`) from api_tokens.
type TokenRow struct {
	ID               string
	ProductID        string
	MerchantEntityID string
	Scope            string
}

// RequireWriteScope rejects a read_only-scoped caller with 403 before a
// mutating handler does anything else, writing the response and
// returning false if so. Every mutating route in this package
// (refund/void/capture payments, cancel subscription) calls this right
// after resolving AuthContext, so scope enforcement lives in exactly
// one place rather than being reimplemented per handler.
//
// Only "read_only" is ever rejected — an empty Scope (every token that
// existed before this field was added, and every test's AuthContext
// literal that doesn't set it) is treated as read_write, so this is
// purely additive: no pre-existing token or test behavior changes.
func RequireWriteScope(w http.ResponseWriter, auth AuthContext) bool {
	if auth.Scope == "read_only" {
		WriteProblem(w, http.StatusForbidden, "Read-only token",
			"This API token is scoped to read_only and cannot call a mutating endpoint. Create a read_write agent token instead.")
		return false
	}
	return true
}

// TokenStore is the minimal capability the Auth middleware needs from
// a database — the Go analogue of auth.ts's
// `deps.db.selectFrom('api_tokens')...` query, narrowed to an
// interface so this package's tests never need a live Postgres. A
// later phase's pgx-backed implementation queries exactly:
//
//	SELECT id, product_id, merchant_entity_id FROM api_tokens
//	WHERE token_hash = $1 AND revoked_at IS NULL
//
// matching auth.ts's `.where('token_hash', '=', ...).where('revoked_at',
// 'is', null)` filter exactly — a revoked token must be rejected even
// though its row still exists (see test/integration/authz.test.ts's
// "a revoked token is rejected even though the row still exists").
//
// A real pgx-backed implementation (PgxTokenStore) lives in
// internal/api/pgstore.go and IS wired for real in cmd/api/main.go —
// unlike PaymentsStore/CustomersStore, this table has no dependency on
// the routing engine or any other later phase, so this phase wires it
// against a live Postgres query rather than leaving it stubbed. See
// internal/api/stubs.go's UnavailableTokenStore for the fail-closed
// fallback this package's tests (or a future caller without a DB) can
// use instead.
type TokenStore interface {
	// Lookup returns the TokenRow for tokenHash, or ErrTokenNotFound if
	// no non-revoked token with that hash exists.
	Lookup(ctx context.Context, tokenHash string) (TokenRow, error)
}

// ErrTokenNotFound is returned by TokenStore.Lookup when no non-revoked
// token matches — the Go analogue of auth.ts's `if (!row) { throw new
// UnauthorizedError(); }` branch.
var ErrTokenNotFound = &tokenNotFoundError{}

type tokenNotFoundError struct{}

func (*tokenNotFoundError) Error() string { return "api token not found or revoked" }

// AuditLogEntry mirrors the exact set of columns auth.ts's onResponse
// hook inserts into audit_log.
type AuditLogEntry struct {
	ID         string
	APITokenID *string
	ProductID  *string
	Method     string
	Path       string
	StatusCode int
	RequestID  string
}

// AuditLogWriter is the minimal capability the Auth middleware needs
// to record an audit_log row per /v1/* request — the Go analogue of
// auth.ts's `deps.db.insertInto('audit_log').values({...}).execute()`
// call, narrowed to an interface for the same DB-independence reason
// as TokenStore.
//
// A real pgx-backed implementation (PgxAuditLogWriter) lives in
// internal/api/pgstore.go and IS wired for real in cmd/api/main.go,
// for the same reason as TokenStore above. internal/api/stubs.go's
// NoopAuditLogWriter remains available as a discard-only fallback —
// see this file's Middleware doc comment for how a nil/absent
// AuditLogWriter is handled (audit logging is skipped, not fatal,
// exactly matching the TS source's own "audit logging must never break
// the request" guarantee).
type AuditLogWriter interface {
	Write(ctx context.Context, entry AuditLogEntry) error
}

// AuthDeps is what NewAuthMiddleware needs — the Go analogue of the TS
// registerAuth(app, deps: { db: Db }) parameter, split into the two
// narrow capabilities (TokenStore, AuditLogWriter) the middleware
// actually uses rather than a single Db handle.
type AuthDeps struct {
	Tokens TokenStore
	Audit  AuditLogWriter
	Logger *slog.Logger
}

// AuthMiddleware is the Go analogue of registerAuth's combined
// preHandler + onResponse hook pair.
type AuthMiddleware struct {
	deps AuthDeps
}

// NewAuthMiddleware constructs an AuthMiddleware.
func NewAuthMiddleware(deps AuthDeps) *AuthMiddleware {
	return &AuthMiddleware{deps: deps}
}

// Middleware is chi middleware guarding every route it wraps —
// intended to be mounted only under the /v1 route group (see
// router.go's BuildRouter), which is the structural equivalent of
// auth.ts's preHandler hook's own `if (!request.url.startsWith('/v1/'))
// return;` early-return guard: unauthenticated routes never run this
// logic in either version, just expressed via chi's route grouping
// instead of a URL-prefix check inside a globally-registered hook.
//
// Validates the Authorization header exactly as auth.ts does:
//   - must be present and start with "Bearer " (capital B, one space,
//     matching the TS `header?.startsWith('Bearer ')` check exactly —
//     no case-insensitive fallback, no "bearer" lowercase acceptance,
//     since the TS source has none either);
//   - the token after that prefix must be non-empty;
//   - SHA-256-hash the token and look it up via TokenStore — a missing
//     or revoked token means 401.
//
// On success, stores an AuthContext on the request context (the
// Go-idiomatic replacement for the TS `request.auth = {...}` ambient
// property assignment) and, after the handler completes, writes one
// AuditLogEntry via AuditLogWriter — matching auth.ts's onResponse
// hook running after the response has already been sent, and its
// explicit contract that a failure to write the audit row must NEVER
// change the response the caller already received (auth.ts: "Audit
// logging must never break the request it's logging — it already
// completed and was sent by the time this hook runs"). This Go port
// preserves that exactly: the audit write happens in a deferred
// closure after next.ServeHTTP returns, and any error from it is only
// logged, never surfaced to the client.
//
// If deps.Audit is nil (as it is until a later phase's DB layer exists
// — see this file's AuditLogWriter doc comment), audit logging is
// skipped silently rather than panicking on a nil interface call. This
// is a deliberate accommodation for this phase's narrower scope, not a
// behavior this middleware would exhibit once a real AuditLogWriter is
// wired in cmd/api/main.go.
func (m *AuthMiddleware) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header := r.Header.Get("Authorization")
		const prefix = "Bearer "
		if !strings.HasPrefix(header, prefix) {
			WriteProblem(w, http.StatusUnauthorized, "Missing or invalid API token", "")
			return
		}
		token := header[len(prefix):]
		if token == "" {
			WriteProblem(w, http.StatusUnauthorized, "Missing or invalid API token", "")
			return
		}

		if m.deps.Tokens == nil {
			// No TokenStore wired yet (see this file's TokenStore doc
			// comment) — fail closed, never open, on missing wiring.
			WriteProblem(w, http.StatusUnauthorized, "Missing or invalid API token", "")
			return
		}

		row, err := m.deps.Tokens.Lookup(r.Context(), HashAPIToken(token))
		if err != nil {
			// BUG FIX (backend review, 2026-07-10): this used to map EVERY
			// Lookup error to 401 "Missing or invalid API token" — that's
			// correct for ErrTokenNotFound (PgxTokenStore.Lookup returns it
			// specifically for pgx.ErrNoRows, i.e. an actually-missing/
			// revoked token — see pgstore.go), but a transient failure
			// (a dropped connection, a query timeout, Postgres itself being
			// briefly unavailable) is a completely different situation:
			// every legitimate caller's real, valid token would ALSO get
			// rejected as "invalid" during an outage, with nothing logged
			// to distinguish "the database is down" from "someone is
			// hammering us with bad tokens" — the single worst time to lose
			// that signal. Now: only a genuine ErrTokenNotFound is a 401;
			// anything else is a 500, logged with the actual error, exactly
			// matching this package's standing convention elsewhere
			// (createPaymentHandler, RecordAttempt, ...) of surfacing
			// infrastructure failures as 500s rather than silently
			// reinterpreting them as a client-side auth problem.
			if errors.Is(err, ErrTokenNotFound) {
				WriteProblem(w, http.StatusUnauthorized, "Missing or invalid API token", "")
				return
			}
			if m.deps.Logger != nil {
				m.deps.Logger.Error("token lookup failed",
					"error", err,
					"request_id", middleware.GetReqID(r.Context()),
				)
			}
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}

		authCtx := AuthContext{
			APITokenID:       row.ID,
			ProductID:        row.ProductID,
			MerchantEntityID: row.MerchantEntityID,
			Scope:            row.Scope,
		}
		ctx := context.WithValue(r.Context(), authContextKey, authCtx)
		r = r.WithContext(ctx)

		sw := &statusCapturingWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)

		if m.deps.Audit == nil {
			return
		}
		entry := AuditLogEntry{
			ID:         uuid.NewString(),
			APITokenID: &authCtx.APITokenID,
			ProductID:  &authCtx.ProductID,
			Method:     r.Method,
			Path:       r.URL.Path,
			StatusCode: sw.status,
			RequestID:  middleware.GetReqID(r.Context()),
		}
		// Fire-and-forget-with-logging, matching auth.ts's
		// `.catch((err) => { request.log.error(...) }).finally(() =>
		// done())` — the response is already written by this point, so
		// nothing here can or should affect it.
		if writeErr := m.deps.Audit.Write(r.Context(), entry); writeErr != nil && m.deps.Logger != nil {
			m.deps.Logger.Error("failed to write audit_log row",
				"error", writeErr,
				"request_id", entry.RequestID,
			)
		}
	})
}

// statusCapturingWriter records the status code written to it so the
// audit-log hook (which runs after the handler completes) can report
// the actual response status, mirroring auth.ts's
// `reply.statusCode` access inside its onResponse hook.
type statusCapturingWriter struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (s *statusCapturingWriter) WriteHeader(status int) {
	if !s.wroteHeader {
		s.status = status
		s.wroteHeader = true
	}
	s.ResponseWriter.WriteHeader(status)
}

func (s *statusCapturingWriter) Write(b []byte) (int, error) {
	if !s.wroteHeader {
		s.WriteHeader(http.StatusOK)
	}
	return s.ResponseWriter.Write(b)
}
