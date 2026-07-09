/** Wire shape returned by GET/POST /api/agent-tokens (which proxies
 *  backend-go's agentTokenDTO — see
 *  payment-orchestrator-go/internal/api/agent_tokens.go). `token` is
 *  only ever present on the object returned by a successful POST
 *  (create) call — the raw secret is never included in the GET list,
 *  and is unrecoverable once its one-time reveal dialog is dismissed. */
export interface AgentToken {
  id: string;
  description: string;
  scope: "read_only" | "read_write";
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  token?: string;
}

export interface ProblemDetails {
  title?: string;
  detail?: string;
}
