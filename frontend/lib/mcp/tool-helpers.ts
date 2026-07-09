/** Shared plumbing for every tool registered in
 *  app/api/[transport]/route.ts — kept out of that file so the 10 tool
 *  registrations there read as "call backend-go, format the result,"
 *  with the error/auth-missing/unconfigured-backend boilerplate
 *  factored out once. */
import { BackendUnconfiguredError, type BackendCallResult } from "@/lib/mcp/backend-client";

export interface McpToolTextResult {
  // Index signature to satisfy registerTool's callback return type
  // (the SDK's CallToolResult is `{ [x: string]: unknown; content: ... }`
  // — an open shape, not a closed interface, so a plain closed
  // interface here is NOT assignable to it without this).
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export function errorResult(text: string): McpToolTextResult {
  return { content: [{ type: "text", text }], isError: true };
}

export const MISSING_TOKEN_RESULT = errorResult(
  "No bearer token was presented with this MCP request. Connect this client with one of your Alpha Payments agent tokens (create one under AI Agents in the dashboard) and try again.",
);

/** Turns a raw backend-go response into an MCP tool result. A non-2xx
 *  status is surfaced as isError: true with the backend's own RFC 7807
 *  problem+json body included verbatim — in particular this is how a
 *  read_only-scoped token's 403 on a mutating tool (RequireWriteScope,
 *  payment-orchestrator-go/internal/api/auth.go) reaches the calling
 *  model as a clear, actionable message rather than a generic failure. */
export function backendResult(result: BackendCallResult): McpToolTextResult {
  const text = JSON.stringify(result.body, null, 2);
  if (result.status >= 400) {
    return errorResult(`backend-go responded ${result.status}:\n${text}`);
  }
  return { content: [{ type: "text", text }] };
}

/** Wraps a tool handler body so BackendUnconfiguredError (no
 *  BACKEND_API_BASE_URL set on this deployment) and any other thrown
 *  error both become a normal isError tool result instead of an
 *  unhandled rejection the MCP transport would otherwise have to guess
 *  how to represent. */
export async function runTool(fn: () => Promise<McpToolTextResult>): Promise<McpToolTextResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BackendUnconfiguredError) {
      return errorResult(err.message);
    }
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}
