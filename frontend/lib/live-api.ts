"use client";

/** Client-side fetch helpers for Live mode — talk to this app's own
 *  /api/* proxy routes (lib/backend-proxy.ts), which hold the
 *  backend-go Bearer token server-side and forward to the real
 *  backend. Deliberately separate from lib/mock-data.ts's shapes
 *  (Payment/Customer in lib/types.ts): those are this demo's rich,
 *  fictional mock model; the types below mirror backend-go's actual
 *  DTOs exactly (payment-orchestrator-go/internal/api/payments.go's
 *  PaymentDTO, customers.go's CustomerDTO) — narrower, and NOT
 *  interchangeable with the mock types. Sandbox mode never imports
 *  this file. */

export class LiveApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "LiveApiError";
    this.status = status;
  }
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  return parseJsonResponse<T>(response);
}

/** Same request/error handling as getJson, for the one Live-mode route
 *  that writes instead of reads (PUT /api/retry-settings) — kept as its
 *  own function rather than a generic method-taking helper since every
 *  other Live-mode call in this app today is a GET; see
 *  fetchLiveRetrySettings/putLiveRetrySettings, the two call sites. */
async function putJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "PUT",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseJsonResponse<T>(response);
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    let message = text || `Request failed with status ${response.status}`;
    try {
      const parsed = JSON.parse(text) as { title?: string; detail?: string };
      message = [parsed.title, parsed.detail].filter(Boolean).join(" — ") || message;
    } catch {
      // Not JSON — use the raw text as-is.
    }
    throw new LiveApiError(response.status, message);
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export interface LiveMoney {
  minorUnits: number;
  currency: string;
}

export interface LivePaginationDTO {
  hasMore: boolean;
  nextCursor: string | null;
}

/** Mirrors payments.go's PaymentDTO exactly. */
export interface LivePayment {
  id: string;
  productId: string;
  customerId: string;
  amount: LiveMoney;
  state: string;
  citMit: string;
  createdAt: string;
  updatedAt: string;
  clientSecret?: string;
}

export interface LivePaymentsResponse {
  data: LivePayment[];
  pagination: LivePaginationDTO;
}

/** Mirrors customers.go's CustomerDTO exactly — see that file's top
 *  doc comment for exactly why this is narrower than the mock
 *  Customer type (no name/address/subscription columns exist in the
 *  `customers` table yet). */
export interface LiveCustomer {
  id: string;
  externalRef?: string;
  email?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LiveCustomersResponse {
  data: LiveCustomer[];
  pagination: LivePaginationDTO;
}

export async function fetchLivePayments(): Promise<LivePaymentsResponse> {
  return getJson<LivePaymentsResponse>("/api/payments");
}

export async function fetchLiveCustomers(): Promise<LiveCustomersResponse> {
  return getJson<LiveCustomersResponse>("/api/customers");
}

/** Mirrors retry_settings.go's RetrySettingsDTO exactly — the shape
 *  both GET and PUT /v1/retry-settings return (PUT echoes back the
 *  row it just upserted). Unlike LivePayment/LiveCustomer this is a
 *  singleton, not a paginated list — there is exactly one retry-settings
 *  row per merchant entity. */
export interface LiveRetrySettings {
  dunningLadderHours: number[];
  maxAttemptsPerPayment: number;
  minSpacingSeconds: number;
  updatedAt: string;
}

/** The three fields PUT /v1/retry-settings accepts — mirrors
 *  retry_settings.go's UpsertRetrySettingsRequest exactly (no
 *  updatedAt/merchantEntityId: those are server-assigned). */
export type LiveRetrySettingsInput = Omit<LiveRetrySettings, "updatedAt">;

export async function fetchLiveRetrySettings(): Promise<LiveRetrySettings> {
  return getJson<LiveRetrySettings>("/api/retry-settings");
}

export async function putLiveRetrySettings(
  input: LiveRetrySettingsInput,
): Promise<LiveRetrySettings> {
  return putJson<LiveRetrySettings>("/api/retry-settings", input);
}
