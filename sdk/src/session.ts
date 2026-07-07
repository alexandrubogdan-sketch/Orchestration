import type { Appearance } from "./appearance";
import { CardElement } from "./elements/card-element";
import { ExpressCheckoutElement } from "./elements/express-checkout-element";
import { MockDriver } from "./drivers/mock-driver";
import { SolidgateDriver } from "./drivers/solidgate-driver";
import { StripeDriver } from "./drivers/stripe-driver";
import type { Driver } from "./drivers/types";
import { classifyPaymentState } from "./state-classification";
import {
  CheckoutHttpClient,
  type CheckoutSessionPublic,
  type ConfirmCheckoutResponse,
  type Money,
} from "./http";

export interface LoadCheckoutOptions {
  /** Base URL of the merchant's Alpha Payments API, e.g. "https://api.example.com". */
  apiBaseUrl: string;
  /** The checkout session id returned by the merchant's server from POST /v1/checkout-sessions. */
  sessionId: string;
  /** The checkout session's clientSecret, also from the merchant's server. */
  clientSecret: string;
  /**
   * ISO-3166-1 alpha-2 country code used for wallet (Apple/Google Pay)
   * express checkout requests. Defaults to "US" when omitted — override
   * this if your merchant account/storefront is based elsewhere.
   */
  expressCheckoutCountry?: string;
  /** Injectable fetch implementation, primarily for tests. */
  fetchImpl?: typeof fetch;
}

export interface CreateElementOptions {
  appearance?: Appearance;
}

export interface Payment {
  id: string;
  productId: string;
  customerId: string;
  amount: Money;
  state: string;
  citMit: string;
  createdAt: string;
  updatedAt: string;
}

export type ConfirmResult =
  | { status: "succeeded"; payment: Payment }
  | { status: "requires_action" }
  | { status: "error"; error: { message: string; code?: string } };

export interface ConfirmOptions {
  /**
   * The card element to tokenize. Optional in the vanilla API only
   * when exactly one CardElement is currently registered as "active"
   * for this session (see `CheckoutSession.confirm()`'s doc comment
   * and the React `<CardElement/>` component, which registers itself
   * automatically — this is what lets React's `checkout.confirm()`
   * be called with no arguments at all).
   */
  element?: CardElement;
  /**
   * Optional lifecycle hook fired immediately before this SDK
   * automatically drives a PSP action (typically 3DS). Merchants
   * never need this to make automatic 3DS work — it exists purely
   * for merchants who want to show custom UI (e.g. "Verifying your
   * card...") during the (usually sub-second) redirect/challenge.
   */
  onBeforeAction?: () => void;
}

function toPayment(response: ConfirmCheckoutResponse): Payment {
  return {
    id: response.id,
    productId: response.productId,
    customerId: response.customerId,
    amount: response.amount,
    state: response.state,
    citMit: response.citMit,
    createdAt: response.createdAt,
    updatedAt: response.updatedAt,
  };
}

function createDriver(psp: CheckoutSessionPublic["psp"]): Driver {
  switch (psp) {
    case "stripe":
      return new StripeDriver();
    case "solidgate":
      return new SolidgateDriver();
    case "mock":
      return new MockDriver();
  }
}

/**
 * A live checkout session: holds the PSP driver, the session's public
 * config, and exposes the merchant-facing createElement/confirm API.
 * Construct one via `loadCheckout()`, never directly.
 */
export class CheckoutSession {
  private readonly http: CheckoutHttpClient;
  private readonly driver: Driver;
  private readonly publicConfig: CheckoutSessionPublic;
  private readonly expressCheckoutCountry: string;
  private activeElement: CardElement | null = null;

  private constructor(
    http: CheckoutHttpClient,
    driver: Driver,
    publicConfig: CheckoutSessionPublic,
    expressCheckoutCountry: string,
  ) {
    this.http = http;
    this.driver = driver;
    this.publicConfig = publicConfig;
    this.expressCheckoutCountry = expressCheckoutCountry;
  }

  /** @internal — use loadCheckout() instead. */
  static async create(options: LoadCheckoutOptions): Promise<CheckoutSession> {
    const http = new CheckoutHttpClient({
      apiBaseUrl: options.apiBaseUrl,
      sessionId: options.sessionId,
      clientSecret: options.clientSecret,
      fetchImpl: options.fetchImpl,
    });

    const publicConfig = await http.getPublicConfig();
    const driver = createDriver(publicConfig.psp);
    await driver.init(publicConfig.publicConfig);

    return new CheckoutSession(
      http,
      driver,
      publicConfig,
      options.expressCheckoutCountry ?? "US",
    );
  }

  /** Current checkout amount, as returned by the backend's public config endpoint. */
  get amount(): Money {
    return this.publicConfig.amount;
  }

  /** Checkout session id this instance is scoped to. */
  get sessionId(): string {
    return this.publicConfig.id;
  }

  createElement(type: "card", options?: CreateElementOptions): CardElement;
  createElement(type: "expressCheckout", options?: CreateElementOptions): ExpressCheckoutElement;
  createElement(
    type: "card" | "expressCheckout",
    options?: CreateElementOptions,
  ): CardElement | ExpressCheckoutElement {
    if (type === "card") {
      const element = new CardElement(this.driver, options?.appearance);
      // Registering as the "active" element lets confirm() be called
      // with no `element` argument — see registerActiveElement()'s
      // doc comment. The most-recently-created CardElement wins,
      // which matches the common case of a single card element per
      // checkout page (exactly the React <CardElement/> ergonomics
      // this exists for).
      this.activeElement = element;
      return element;
    }
    return new ExpressCheckoutElement(this.driver, this.publicConfig.amount, this.expressCheckoutCountry);
  }

  /**
   * @internal Used by the React `<CardElement/>` component to register
   * itself as the implicit element for `checkout.confirm()` calls that
   * omit `element` (matching the spec's `await checkout.confirm()`
   * usage with no arguments). Not part of the public vanilla API surface
   * — vanilla integrations should keep passing `{ element }` explicitly.
   */
  registerActiveElement(element: CardElement | null): void {
    this.activeElement = element;
  }

  /**
   * Tokenizes the given element and confirms the checkout session.
   *
   * Automatic 3DS: if the backend's confirm response indicates the
   * PSP needs further client-side action (a non-terminal state paired
   * with a PSP clientSecret), this method automatically calls the
   * active driver's `confirmAction()` with that secret and re-derives
   * the final outcome from the result — the merchant integrator does
   * not need to do anything extra for this to work.
   *
   * `requires_action` is only ever returned when the action genuinely
   * cannot be automated:
   *   - the active driver has no way to drive the action (in
   *     practice: any driver whose `confirmAction` legitimately can't
   *     proceed without more merchant-side context), or
   *   - `driver.confirmAction()` itself reports failure in a way that
   *     isn't a hard decline (e.g. the user abandoned/cancelled a 3DS
   *     challenge), or
   *   - the backend reports a non-terminal, non-failure state with NO
   *     PSP clientSecret to act on (nothing for the SDK to drive).
   */
  async confirm(options: ConfirmOptions = {}): Promise<ConfirmResult> {
    const element = options.element ?? this.activeElement;
    if (!element) {
      return {
        status: "error",
        error: {
          message: "No card element to confirm: pass { element } explicitly, or mount a <CardElement/> first.",
          code: "no_element",
        },
      };
    }

    const handle = element.getHandle();
    if (!handle) {
      return {
        status: "error",
        error: { message: "The card element must be mounted before calling confirm().", code: "element_not_mounted" },
      };
    }

    const tokenizeResult = await this.driver.tokenize(handle);
    if (tokenizeResult.error !== undefined) {
      return {
        status: "error",
        error: { message: tokenizeResult.error, code: "tokenization_failed" },
      };
    }
    const paymentMethodRef = tokenizeResult.paymentMethodRef;

    try {
      const response = await this.http.confirm(paymentMethodRef);
      return this.resolveConfirmResponse(response, paymentMethodRef, options);
    } catch (err) {
      return {
        status: "error",
        error: {
          message: err instanceof Error ? err.message : "Network error while confirming payment.",
          code: err instanceof Error ? err.name : "network_error",
        },
      };
    }
  }

  private async resolveConfirmResponse(
    response: ConfirmCheckoutResponse,
    paymentMethodRef: string,
    options: ConfirmOptions,
  ): Promise<ConfirmResult> {
    const classification = classifyPaymentState({
      state: response.state,
      pspClientSecret: response.clientSecret,
    });

    if (classification === "success") {
      return { status: "succeeded", payment: toPayment(response) };
    }

    if (classification === "hard_failure") {
      return {
        status: "error",
        error: { message: `Payment ${response.state}.`, code: response.state },
      };
    }

    if (classification === "pending") {
      // Non-terminal state, but nothing for us to drive — genuinely
      // needs the merchant's own handling.
      return { status: "requires_action" };
    }

    // classification === "drive_action": attempt fully-automatic 3DS.
    const pspClientSecret = response.clientSecret;
    if (!pspClientSecret) {
      // Should be unreachable given classifyPaymentState's contract,
      // but keep the fallback honest rather than throwing.
      return { status: "requires_action" };
    }

    options.onBeforeAction?.();

    const actionResult = await this.driver.confirmAction(pspClientSecret);
    if (!actionResult.success) {
      return {
        status: "error",
        error: { message: actionResult.error ?? "Additional authentication failed.", code: "action_failed" },
      };
    }

    // Re-confirm with the backend using the SAME paymentMethodRef.
    // Per the contract, confirm is idempotent per session — retrying
    // it (now that the PSP-side action has completed) is safe and
    // lets the backend report the PSP's final post-action state
    // without double-charging.
    try {
      const recheck = await this.http.confirm(paymentMethodRef);
      return this.resolveConfirmResponse(recheck, paymentMethodRef, options);
    } catch (err) {
      return {
        status: "error",
        error: {
          message: err instanceof Error ? err.message : "Network error while finalizing payment after authentication.",
          code: err instanceof Error ? err.name : "network_error",
        },
      };
    }
  }
}

/**
 * Loads a checkout session: fetches its public config, initializes
 * the appropriate PSP driver, and returns a ready-to-use
 * `CheckoutSession`. This is the SDK's single entry point.
 */
export async function loadCheckout(options: LoadCheckoutOptions): Promise<CheckoutSession> {
  return CheckoutSession.create(options);
}
