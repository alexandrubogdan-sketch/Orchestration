import type { NextRequest } from "next/server";

import { proxyToBackend } from "@/lib/backend-proxy";

/** GET /api/agent-tokens — proxies to backend-go's GET /v1/agent-tokens
 *  (redacted list, never includes a token value).
 *
 *  POST /api/agent-tokens — proxies to backend-go's POST
 *  /v1/agent-tokens ({ description, scope }), which mints a new
 *  self-serve MCP agent token and returns the raw value exactly once —
 *  see payment-orchestrator-go/internal/api/agent_tokens.go's doc
 *  comment. Both routes use the master BACKEND_API_TOKEN via
 *  proxyToBackend, same as every other app/api/* route in this app
 *  (NOT the caller's own agent token — that pattern only applies to
 *  app/api/[transport]/route.ts, the MCP server itself). */
export async function GET(request: NextRequest) {
  return proxyToBackend(request, "v1/agent-tokens");
}

export async function POST(request: NextRequest) {
  return proxyToBackend(request, "v1/agent-tokens");
}
