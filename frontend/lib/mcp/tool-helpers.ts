import { BackendUnconfiguredError, type BackendCallResult } from "@/lib/mcp/backend-client";

export interface McpToolTextResult {
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

export function backendResult(result: BackendCallResult): McpToolTextResult {
  const text = JSON.stringify(result.body, null, 2);
  if (result.status >= 400) {
    return errorResult(`backend-go responded ${result.status}:\n${text}`);
  }
  return { content: [{ type: "text", text }] };
}

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
