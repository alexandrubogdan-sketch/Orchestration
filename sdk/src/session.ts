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
  apiBaseUrl: string;

  sessionId: string;

  clientSecret: string;

  expressCheckoutCountry?: string;

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
  element?: CardElement;

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

  get amount(): Money {
    return this.publicConfig.amount;
  }

  get sessionId(): string {
    return this.publicConfig.id;
  }

  createElement(type: "card", options?: CreateElementOptions): CardElement;
  createElement(
    type: "expressCheckout",
    options?: CreateElementOptions,
  ): ExpressCheckoutElement;
  createElement(
    type: "card" | "expressCheckout",
    options?: CreateElementOptions,
  ): CardElement | ExpressCheckoutElement {
    if (type === "card") {
      const element = new CardElement(this.driver, options?.appearance);

      this.activeElement = element;
      return element;
    }
    return new ExpressCheckoutElement(
      this.driver,
      this.publicConfig.amount,
      this.expressCheckoutCountry,
    );
  }

  registerActiveElement(element: CardElement | null): void {
    this.activeElement = element;
  }

  async confirm(options: ConfirmOptions = {}): Promise<ConfirmResult> {
    const element = options.element ?? this.activeElement;
    if (!element) {
      return {
        status: "error",
        error: {
          message:
            "No card element to confirm: pass { element } explicitly, or mount a <CardElement/> first.",
          code: "no_element",
        },
      };
    }

    const handle = element.getHandle();
    if (!handle) {
      return {
        status: "error",
        error: {
          message: "The card element must be mounted before calling confirm().",
          code: "element_not_mounted",
        },
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
          message:
            err instanceof Error
              ? err.message
              : "Network error while confirming payment.",
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
      return { status: "requires_action" };
    }

    const pspClientSecret = response.clientSecret;
    if (!pspClientSecret) {
      return { status: "requires_action" };
    }

    options.onBeforeAction?.();

    const actionResult = await this.driver.confirmAction(pspClientSecret);
    if (!actionResult.success) {
      return {
        status: "error",
        error: {
          message: actionResult.error ?? "Additional authentication failed.",
          code: "action_failed",
        },
      };
    }

    try {
      const recheck = await this.http.confirm(paymentMethodRef);
      return this.resolveConfirmResponse(recheck, paymentMethodRef, options);
    } catch (err) {
      return {
        status: "error",
        error: {
          message:
            err instanceof Error
              ? err.message
              : "Network error while finalizing payment after authentication.",
          code: err instanceof Error ? err.name : "network_error",
        },
      };
    }
  }
}

export async function loadCheckout(
  options: LoadCheckoutOptions,
): Promise<CheckoutSession> {
  return CheckoutSession.create(options);
}
