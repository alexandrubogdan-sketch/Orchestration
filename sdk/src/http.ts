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

export interface CheckoutSessionPublic {
  id: string;
  amount: Money;
  status: CheckoutSessionStatus;
  expiresAt: string;
  psp: PspName;
  publicConfig: PublicConfig;
}

export interface ConfirmCheckoutRequest {
  clientSecret: string;
  paymentMethodRef: string;
}

export interface ConfirmCheckoutResponse {
  id: string;
  productId: string;
  customerId: string;
  amount: Money;
  state: string;
  citMit: string;
  createdAt: string;
  updatedAt: string;

  clientSecret?: string;
}

export class CheckoutSessionNotFoundError extends Error {
  readonly code = "checkout_session_not_found";

  constructor(sessionId: string) {
    super(`Checkout session "${sessionId}" was not found.`);
    this.name = "CheckoutSessionNotFoundError";
  }
}

export class CheckoutSessionClosedError extends Error {
  readonly code = "checkout_session_closed";

  constructor(sessionId: string) {
    super(
      `Checkout session "${sessionId}" is no longer open (expired or already consumed).`,
    );
    this.name = "CheckoutSessionClosedError";
  }
}

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

  fetchImpl?: typeof fetch;
}

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
    const text = await response.text().catch(() => '');
    if (text) {
      message = text;
    }
    throw new CheckoutApiError(response.status, message);
  }
}
