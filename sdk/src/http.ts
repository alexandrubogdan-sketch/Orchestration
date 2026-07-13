/**
 * Thin fetch wrapper around the two PUBLIC, browser-callable endpoints
 * of the checkout-sessions backend contract. Notably absent:
 * `POST /v1/checkout-sessions` — that endpoint requires the merchant's
 * private Bearer key and is called from the merchant's OWN server,
 * never from this SDK (see README "Architecture" section).
 */

export interface Money {
  minorUnits: number;
  currency: string;
}

export type CheckoutSessionStatus = "open" | "consumed" | "expired";

export type PspName = "stripe" | "solidgate" | "mock";

export interface PublicConfig {
  psp: PspName;
  publishableKey: string;
  merchantIdentifier?: string;
}

/** Response body of `GET /checkout/{id}/public`. */
export interface CheckoutSessionPublic {
  id: string;
  amount: Money;
  status: CheckoutSessionStatus;
  expiresAt: string;
  psp: PspName;
  publicConfig: PublicConfig;
}

/** Request body of `POST /checkout/{id}/confirm`. */
export interface ConfirmCheckoutRequest {
  clientSecret: string;
  paymentMethodRef: string;
}

/** Response body of `POST /checkout/{id}/confirm` (200). */
export interface ConfirmCheckoutResponse {
  id: string;
  productId: string;
  customerId: string;
  amount: Money;
  state: string;
  citMit: string;
  createdAt: string;
  updatedAt: string;
  /**
   * The PSP's OWN client secret (e.g. a Stripe PaymentIntent
   * client_secret) — NOT the checkout session's clientSecret. Present
   * only when the PSP requires further client-side action (3DS).
   */
  clientSecret?: string;
}

/** Thrown when the backend returns 404 for a public endpoint call. */
export class CheckoutSessionNotFoundError extends Error {
  readonly code = "checkout_session_not_found";

  constructor(sessionId: string) {
    super(`Checkout session "${sessionId}" was not found.`);
    this.name = "CheckoutSessionNotFoundError";
  }
}

/**
 * Thrown when the backend returns 410 — the session exists but is no
 * longer open (already consumed by a successful confirm, or expired).
 */
export class CheckoutSessionClosedError extends Error {
  readonly code = "checkout_session_closed";

  constructor(sessionId: string) {
    super(`Checkout session "${sessionId}" is no longer open (expired or already consumed).`);
    this.name = "CheckoutSessionClosedError";
  }
}

/** Thrown for any other non-2xx response from a public endpoint. */
export class CheckoutApiError extends Error {
  readonly code = "checkout_api_error";
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "CheckoutApiError";
    this.status = status;
  }
}

export interface CheckoutHttpClientOptions {
  apiBaseUrl: string;
  sessionId: string;
  clientSecret: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Minimal fetch client scoped to a single checkout session. Holds no
 * credentials beyond the session's own clientSecret (see README
 * "Security model") and never touches localStorage/sessionStorage/
 * cookies — the clientSecret only ever lives in memory for the
 * lifetime of the page.
 */
export class CheckoutHttpClient {
  private readonly apiBaseUrl: string;
  private readonly sessionId: string;
  private readonly clientSecret: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CheckoutHttpClientOptions) {
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, "");
    this.sessionId = options.sessionId;
    this.clientSecret = options.clientSecret;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Stripe integration audit (2026-07-12), Task #321e: the clientSecret
   * is sent via the X-Checkout-Session-Secret header, not the URL query
   * string. A query-string secret leaks into server access logs,
   * browser history, and Referer headers on any subsequent navigation
   * or subresource request off this page — a header does not. The
   * backend (checkout_sessions.go's handleGetPublicCheckoutSession)
   * checks this header first and only falls back to the legacy
   * ?clientSecret= query param for backward compatibility with older
   * SDK builds, so this is safe to roll out independently.
   */
  async getPublicConfig(): Promise<CheckoutSessionPublic> {
    const url = `${this.apiBaseUrl}/checkout/${encodeURIComponent(this.sessionId)}/public`;
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Checkout-Session-Secret": this.clientSecret,
      },
    });
    await this.throwIfError(response);
    return (await response.json()) as CheckoutSessionPublic;
  }

  async confirm(paymentMethodRef: string): Promise<ConfirmCheckoutResponse> {
    const url = `${this.apiBaseUrl}/checkout/${encodeURIComponent(this.sessionId)}/confirm`;
    const body: ConfirmCheckoutRequest = {
      clientSecret: this.clientSecret,
      paymentMethodRef,
    };
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    await this.throwIfError(response);
    return (await response.json()) as ConfirmCheckoutResponse;
  }

  private async throwIfError(response: Response): Promise<void> {
    if (response.ok) {
      return;
    }
    if (response.status === 404) {
      throw new CheckoutSessionNotFoundError(this.sessionId);
    }
    if (response.status === 410) {
      throw new CheckoutSessionClosedError(this.sessionId);
    }
    let message = `Request failed with status ${response.status}`;
    try {
      const text = await response.text();
      if (text) {
        message = text;
      }
    } catch {
      // Ignore body-read failures; fall back to the generic message.
    }
    throw new CheckoutApiError(response.status, message);
  }
}
