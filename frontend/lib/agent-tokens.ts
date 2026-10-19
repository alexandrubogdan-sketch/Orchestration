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
