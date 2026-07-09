-- AI Agents / MCP feature: self-serve API tokens for MCP clients,
-- reusing the existing api_tokens table (see
-- 1735776400000_api-tokens-and-audit-log.up.sql) rather than a
-- separate one.
--
-- scope gates which /v1/* routes a token may call: 'read_only' can hit
-- every GET but is rejected 403 by RequireWriteScope on anything
-- mutating (internal/api/auth.go); 'read_write' (the default, matching
-- every token issued before this column existed) may call everything
-- its product/merchant_entity scoping already allows.
--
-- kind distinguishes a self-serve MCP agent token ('mcp_agent') from
-- the one original bootstrap token every deployment starts with
-- ('api', the default) — GET/DELETE /v1/agent-tokens only ever
-- lists/revokes kind='mcp_agent' rows, so the bootstrap token can never
-- be revoked through this self-serve resource.
--
-- last_used_at is not written yet anywhere in this phase (no code path
-- updates it) — added now so a later pass can start stamping it on
-- successful Lookup calls without a second migration.

ALTER TABLE api_tokens ADD COLUMN scope text NOT NULL DEFAULT 'read_write'
  CHECK (scope IN ('read_only', 'read_write'));
ALTER TABLE api_tokens ADD COLUMN kind text NOT NULL DEFAULT 'api'
  CHECK (kind IN ('api', 'mcp_agent'));
ALTER TABLE api_tokens ADD COLUMN last_used_at timestamptz;
