"use client";

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

async function putJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "PUT",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseJsonResponse<T>(response);
}

export function problemMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { title?: string; detail?: string };
    return [parsed.title, parsed.detail].filter(Boolean).join(" — ") || text;
  } catch {
    return text;
  }
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new LiveApiError(response.status, problemMessage(text) || `Request failed with status ${response.status}`);
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

export interface LiveRetrySettings {
  dunningLadderHours: number[];
  maxAttemptsPerPayment: number;
  minSpacingSeconds: number;
  updatedAt: string;
}

export type LiveRetrySettingsInput = Omit<LiveRetrySettings, "updatedAt">;

export async function fetchLiveRetrySettings(): Promise<LiveRetrySettings> {
  return getJson<LiveRetrySettings>("/api/retry-settings");
}

export async function putLiveRetrySettings(
  input: LiveRetrySettingsInput,
): Promise<LiveRetrySettings> {
  return putJson<LiveRetrySettings>("/api/retry-settings", input);
}
