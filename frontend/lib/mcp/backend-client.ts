/** Server-only. Calls backend-go's /v1/* routes using the CALLER's own
 *  MCP agent token — extracted from the incoming MCP request's
 *  Authorization header by app/api/[transport]/route.ts's withMcpAuth
 *  wrapper — never the server's master BACKEND_API_TOKEN
 *  (lib/backend-config.ts's getBackendConfig).
 *
 *  This is the one place in this app that deliberately does NOT use
 *  lib/backend-proxy.ts's proxyToBackend: every other app/api/* route
 *  forwards the master token because the browser reaching it is
 *  trusted via this app's own session/cookies. An MCP client is a
 *  different, less-trusted caller — it must be scoped to exactly its
 *  own agent token's product/merchant/read_only-or-read_write scope,
 *  which backend-go itself already enforces on every /v1/* handler
 *  (RequireWriteScope, AuthContext.ProductID/MerchantEntityID scoping).
 *  This file adds no authorization logic on top of that; it only
 *  forwards whatever token it was given and reports back whatever
 *  status/body backend-go returns, including 401/403.
 */
import { getBackendBaseUrl } from "@/lib/backend-config";

export class BackendUnconfiguredError extends Error {
  constructor() {
    super(
      "BACKEND_API_BASE_URL is not set on this deployment — there is no live backend-go instance for this MCP server to call.",
    );
  }
}

export interface BackendCallResult {
  status: number;
  body: unknown;
}

/** Issues one request to backend-go's /v1/* surface, authenticated as
 *  `token`. Reads the response as JSON when possible, falling back to
 *  `{ raw: <text> }` for a non-JSON body (backend-go's own error
 *  responses are always RFC 7807 problem+json, so that fallback should
 *  be rare). Never throws on a non-2xx backend response — every tool
 *  handler in app/api/[transport]/route.ts decides for itself how to
 *  turn a given status+body into an MCP tool result. */
export async function callBackend(
  token: string,
  method: string,
  path: string,
  options: { body?: unknown; idempotencyKey?: string } = {},
): Promise<BackendCallResult> {
  const baseUrl = getBackendBaseUrl();
  if (!baseUrl) {
    throw new BackendUnconfiguredError();
  }

  const url = new URL(path, `${baseUrl}/`);
  const headers = new Headers({ authorization: `Bearer ${token}` });
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (options.idempotencyKey) {
    headers.set("idempotency-key", options.idempotencyKey);
  }

  const response = await fetch(url, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    cache: "no-store",
  });

  const text = await response.text();
  if (!text) {
    return { status: response.status, body: null };
  }
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: { raw: text } };
  }
}
