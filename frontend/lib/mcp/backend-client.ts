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
