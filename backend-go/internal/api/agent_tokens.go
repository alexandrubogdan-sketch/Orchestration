package api

// This file adds the agent-tokens resource: self-serve creation,
// listing, and revocation of API tokens meant for MCP (Model Context
// Protocol) clients — the sibling frontend's app/agents/page.tsx
// dashboard and app/api/mcp/route.ts MCP server are the two things
// that actually use these routes; see the frontend's own doc comments
// and payment-orchestrator-frontend/lib's mcp helpers for the other
// half of this feature.
//
// Deliberately reuses the EXACT same api_tokens table and Bearer-auth
// mechanism every other /v1/* route already trusts (see auth.go)
// rather than inventing a second auth system: creating an agent token
// is itself just another authenticated /v1/* call (made by the
// frontend's own server-side proxy, which already holds a master
// token — see payment-orchestrator-frontend/lib/backend-config.ts),
// and the raw token handed back is shown to the caller exactly once,
// the same guarantee GenerateAPIToken's very first bootstrap token
// already makes (cmd/bootstraptoken). `kind = 'mcp_agent'` (see this
// resource's migration, db/migrations/1735777600000_agent-tokens.up.sql)
// distinguishes these self-serve rows from that one original bootstrap
// token so this resource's own list/revoke routes never touch it.
//
// scope ("read_only" | "read_write") is the one new safety primitive
// this resource introduces: a read_only agent token can call every GET
// /v1/* route but is rejected 403 by RequireWriteScope (auth.go), which
// every mutating handler in this package calls — refund/void/capture
// payments, cancel-subscription (subscriptions.go), and, since
// 2026-07-10, handleCreateAgentToken/handleRevokeAgentToken themselves
// (a read_only token minting or revoking a token — including a more-
// privileged sibling token — would otherwise be a privilege-escalation
// path this same scope check exists to prevent). This is enforced at
// the same layer every other authorization decision in this package
// already lives (the handler, via AuthContext), not duplicated inside
// the MCP server, so it holds regardless of how a caller reaches these
// routes.

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

// AgentTokenRow mirrors the api_tokens columns this resource's handlers
// read/write for a kind='mcp_agent' row. TokenHash is deliberately
// absent — no code path in this file ever reads a hash back out, only
// writes one at creation (CreateAgentTokenRow.TokenHash) and looks one
// up via the unrelated TokenStore.Lookup (auth.go), matching how a
// secret should only ever flow one direction through this API.
type AgentTokenRow struct {
	ID          string
	Description string
	Scope       string
	CreatedAt   time.Time
	LastUsedAt  *time.Time
	RevokedAt   *time.Time
}

// CreateAgentTokenRow is the input to AgentTokenStore.CreateAgentToken —
// everything the INSERT needs. ProductID/MerchantEntityID come from the
// AUTHENTICATED CALLER's own AuthContext (the merchant's dashboard/
// proxy creating this token on the user's behalf), never from the
// request body, so a caller can only ever mint agent tokens scoped to
// their own product — matching every other resource's ownership rule
// in this package.
type CreateAgentTokenRow struct {
	ProductID        string
	MerchantEntityID string
	Description      string
	Scope            string
	TokenHash        string
}

// AgentTokenStore is the narrow capability agent_tokens.go's handlers
// need. Deliberately separate from TokenStore (auth.go), which only
// ever needs Lookup — extending TokenStore itself would force every
// existing implementer (UnavailableTokenStore, any test's fake) to grow
// these three methods too, for no benefit to the auth middleware, which
// never calls them.
type AgentTokenStore interface {
	CreateAgentToken(ctx context.Context, input CreateAgentTokenRow) (AgentTokenRow, error)
	ListAgentTokens(ctx context.Context, productID string) ([]AgentTokenRow, error)
	RevokeAgentToken(ctx context.Context, id string, productID string) (bool, error)
}

// AgentTokensRouteDeps is everything the three agent-token handlers
// need.
type AgentTokensRouteDeps struct {
	Store AgentTokenStore
}

type createAgentTokenRequest struct {
	Description string `json:"description"`
	Scope       string `json:"scope"`
}

// agentTokenDTO is the JSON shape returned by all three routes. Token
// is only ever populated on the CREATE response (see
// handleCreateAgentToken) — `omitempty` keeps it entirely absent from
// the list response's JSON rather than present-but-empty, so a client
// can't mistake an empty string for "the token really is blank."
type agentTokenDTO struct {
	ID          string  `json:"id"`
	Description string  `json:"description"`
	Scope       string  `json:"scope"`
	CreatedAt   string  `json:"createdAt"`
	LastUsedAt  *string `json:"lastUsedAt"`
	RevokedAt   *string `json:"revokedAt"`
	Token       string  `json:"token,omitempty"`
}

func serializeAgentToken(row AgentTokenRow) agentTokenDTO {
	dto := agentTokenDTO{
		ID:          row.ID,
		Description: row.Description,
		Scope:       row.Scope,
		CreatedAt:   row.CreatedAt.UTC().Format(time.RFC3339Nano),
	}
	if row.LastUsedAt != nil {
		s := row.LastUsedAt.UTC().Format(time.RFC3339Nano)
		dto.LastUsedAt = &s
	}
	if row.RevokedAt != nil {
		s := row.RevokedAt.UTC().Format(time.RFC3339Nano)
		dto.RevokedAt = &s
	}
	return dto
}

func registerAgentTokensRoutes(r chi.Router, deps AgentTokensRouteDeps) {
	r.Post("/agent-tokens", handleCreateAgentToken(deps))
	r.Get("/agent-tokens", handleListAgentTokens(deps))
	r.Delete("/agent-tokens/{id}", handleRevokeAgentToken(deps))
}

// handleCreateAgentToken implements POST /v1/agent-tokens. The raw
// token is returned exactly once, in this response only — only its
// SHA-256 hash is ever persisted (GenerateAPIToken, auth.go), so it can
// never be recovered afterward; a lost token means issuing a new one
// and revoking the old.
func handleCreateAgentToken(deps AgentTokensRouteDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth, ok := authFromContext(r.Context())
		if !ok {
			WriteProblem(w, http.StatusUnauthorized, "Missing or invalid API token", "")
			return
		}
		// Fixed 2026-07-10: minting a new agent token is itself a
		// mutating, privilege-bearing action — a read_only-scoped token
		// (e.g. one already handed to a read-only MCP agent) must not be
		// able to mint itself a fresh read_write token and escalate.
		// Matches every other mutating handler in this package/payments.go.
		if !RequireWriteScope(w, auth) {
			return
		}

		var body createAgentTokenRequest
		if r.ContentLength != 0 {
			if !decodeJSONBody(w, r, &body) {
				return
			}
		}
		scope := body.Scope
		if scope == "" {
			scope = "read_write"
		}
		if scope != "read_only" && scope != "read_write" {
			WriteProblem(w, http.StatusBadRequest, "Validation failed", `scope must be "read_only" or "read_write"`)
			return
		}
		description := strings.TrimSpace(body.Description)
		if description == "" {
			description = "MCP agent token"
		}

		if deps.Store == nil {
			WriteProblem(w, http.StatusNotImplemented, "Not implemented", ErrNotImplemented.Error())
			return
		}

		raw, hash, err := GenerateAPIToken()
		if err != nil {
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}

		row, err := deps.Store.CreateAgentToken(r.Context(), CreateAgentTokenRow{
			ProductID:        auth.ProductID,
			MerchantEntityID: auth.MerchantEntityID,
			Description:      description,
			Scope:            scope,
			TokenHash:        hash,
		})
		if err != nil {
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}

		dto := serializeAgentToken(row)
		dto.Token = raw
		writeJSON(w, http.StatusCreated, dto)
	}
}

// handleListAgentTokens implements GET /v1/agent-tokens — redacted
// (never includes a token value), scoped to auth.ProductID.
func handleListAgentTokens(deps AgentTokensRouteDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth, ok := authFromContext(r.Context())
		if !ok {
			WriteProblem(w, http.StatusUnauthorized, "Missing or invalid API token", "")
			return
		}
		if deps.Store == nil {
			WriteProblem(w, http.StatusNotImplemented, "Not implemented", ErrNotImplemented.Error())
			return
		}

		rows, err := deps.Store.ListAgentTokens(r.Context(), auth.ProductID)
		if err != nil {
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}
		dtos := make([]agentTokenDTO, 0, len(rows))
		for _, row := range rows {
			dtos = append(dtos, serializeAgentToken(row))
		}
		writeJSON(w, http.StatusOK, dtos)
	}
}

// handleRevokeAgentToken implements DELETE /v1/agent-tokens/{id}.
// Revoking is permanent — there is no "unrevoke," matching every other
// revoked_at column in this schema (api_tokens itself, subscriptions'
// canceled_at).
func handleRevokeAgentToken(deps AgentTokensRouteDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth, ok := authFromContext(r.Context())
		if !ok {
			WriteProblem(w, http.StatusUnauthorized, "Missing or invalid API token", "")
			return
		}
		// Fixed 2026-07-10: revocation is mutating too — see
		// handleCreateAgentToken's identical fix above for the full
		// rationale (a read_only agent token must not be able to revoke
		// any token, including escalating by revoking a more-restricted
		// sibling token or another agent's token).
		if !RequireWriteScope(w, auth) {
			return
		}
		id := chi.URLParam(r, "id")
		if deps.Store == nil {
			WriteProblem(w, http.StatusNotImplemented, "Not implemented", ErrNotImplemented.Error())
			return
		}

		found, err := deps.Store.RevokeAgentToken(r.Context(), id, auth.ProductID)
		if err != nil {
			WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "")
			return
		}
		if !found {
			WriteProblem(w, http.StatusNotFound, "Agent token not found", "")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
