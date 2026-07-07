/**
 * Real Stripe.js integration.
 *
 * IMPORTANT — why this driver dynamically injects a <script
 * src="https://js.stripe.com/v3"> tag instead of importing/bundling
 * @stripe/stripe-js's runtime: Stripe's own documentation requires
 * loading stripe.js directly from https://js.stripe.com so that
 * Stripe can ship security patches to every integration
 * instantaneously and so Stripe can fingerprint/monitor the script
 * for fraud signals. Self-hosting or bundling stripe.js is explicitly
 * against Stripe's terms of use AND breaks PCI SAQ A eligibility for
 * any merchant using this SDK — SAQ A's reduced scope depends on the
 * cardholder-data-handling script being loaded fresh from Stripe's
 * own origin on every page load, not vendored into a merchant's
 * bundle. See https://docs.stripe.com/security/guide and
 * https://docs.stripe.com/js/including for the canonical statements
 * of this requirement. This is why @stripe/stripe-js is listed as an
 * OPTIONAL peerDependency (types only, see stripe-types.ts) rather
 * than a regular dependency: we want its TypeScript types without
 * ever pulling its runtime into this package's bundle.
 */
import { toStripeAppearance, type Appearance } from "../appearance";
import type { PublicConfig } from "../http";
import type {
  CardElementChangeState,
  CardHandle,
  ConfirmActionResult,
  Driver,
  TokenizeResult,
} from "./types";
import type {
  StripeCardElement,
  StripeClient,
  StripePaymentRequest,
} from "./stripe-types";

const STRIPE_JS_URL = "https://js.stripe.com/v3";

let stripeScriptLoadPromise: Promise<void> | null = null;

/**
 * Injects the Stripe.js <script> tag exactly once per page (even
 * across multiple loadCheckout() calls) and resolves once
 * `window.Stripe` is available.
 */
function loadStripeScript(): Promise<void> {
  if (typeof window !== "undefined" && window.Stripe) {
    return Promise.resolve();
  }
  if (stripeScriptLoadPromise) {
    return stripeScriptLoadPromise;
  }

  stripeScriptLoadPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${STRIPE_JS_URL}"]`,
    );
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Failed to load Stripe.js")));
      if (window.Stripe) {
        resolve();
      }
      return;
    }

    const script = document.createElement("script");
    script.src = STRIPE_JS_URL;
    script.async = true;
    script.addEventListener("load", () => resolve());
    script.addEventListener("error", () => reject(new Error("Failed to load Stripe.js")));
    document.head.appendChild(script);
  });

  return stripeScriptLoadPromise;
}

class StripeCardHandle implements CardHandle {
  private readonly listeners = new Set<(state: CardElementChangeState) => void>();
  private state: CardElementChangeState = { complete: false, empty: true };
  readonly element: StripeCardElement;
  private readonly mountPoint: HTMLElement;

  constructor(elements: ReturnType<StripeClient["elements"]>, container: HTMLElement) {
    this.mountPoint = document.createElement("div");
    container.appendChild(this.mountPoint);
    this.element = elements.create("card");
    this.element.mount(this.mountPoint);
    this.element.on("change", (event) => {
      this.state = {
        complete: event.complete,
        empty: event.empty,
        error: event.error?.message,
      };
      for (const listener of this.listeners) {
        listener(this.state);
      }
    });
  }

  unmount(): void {
    this.element.unmount();
    this.mountPoint.remove();
    this.listeners.clear();
  }

  onChange(listener: (state: CardElementChangeState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): CardElementChangeState {
    return this.state;
  }
}

export class StripeDriver implements Driver {
  private stripe: StripeClient | null = null;
  private elements: ReturnType<StripeClient["elements"]> | null = null;
  private appearance: Appearance | undefined;
  private lastPaymentRequest: StripePaymentRequest | null = null;

  async init(publicConfig: PublicConfig): Promise<void> {
    await loadStripeScript();
    const StripeCtor = window.Stripe;
    if (!StripeCtor) {
      throw new Error("Stripe.js failed to load: window.Stripe is unavailable.");
    }
    this.stripe = StripeCtor(publicConfig.publishableKey);
  }

  private ensureStripe(): StripeClient {
    if (!this.stripe) {
      throw new Error("StripeDriver.init() must complete before mounting elements.");
    }
    return this.stripe;
  }

  private ensureElements(appearance: Appearance | undefined): ReturnType<StripeClient["elements"]> {
    const stripe = this.ensureStripe();
    if (!this.elements || this.appearance !== appearance) {
      this.appearance = appearance;
      this.elements = stripe.elements({ appearance: toStripeAppearance(appearance) });
    }
    return this.elements;
  }

  mountCard(container: HTMLElement, appearance: Appearance | undefined): CardHandle {
    const elements = this.ensureElements(appearance);
    return new StripeCardHandle(elements, container);
  }

  async tokenize(cardHandle: CardHandle): Promise<TokenizeResult> {
    const stripe = this.ensureStripe();
    if (!(cardHandle instanceof StripeCardHandle)) {
      return { error: "This card element was not created by the Stripe driver." };
    }
    const result = await stripe.createPaymentMethod({
      type: "card",
      card: cardHandle.element,
    });
    if (result.error || !result.paymentMethod) {
      return { error: result.error?.message ?? "Card tokenization failed." };
    }
    return { paymentMethodRef: result.paymentMethod.id };
  }

  supportsExpressCheckout(): boolean {
    return true;
  }

  async confirmAction(pspClientSecret: string): Promise<ConfirmActionResult> {
    const stripe = this.ensureStripe();
    const result = await stripe.confirmCardPayment(pspClientSecret);
    if (result.error) {
      return { success: false, error: result.error.message };
    }
    return { success: true };
  }

  /**
   * Stripe-specific express-checkout support, used by
   * elements/express-checkout-element.ts. Not part of the generic
   * Driver interface because PaymentRequest construction needs
   * amount/currency/country, which the generic Driver contract
   * doesn't carry.
   */
  createPaymentRequest(options: {
    country: string;
    currency: string;
    amountMinorUnits: number;
    label: string;
  }): StripePaymentRequest {
    const stripe = this.ensureStripe();
    const paymentRequest = stripe.paymentRequest({
      country: options.country,
      currency: options.currency,
      total: { label: options.label, amount: options.amountMinorUnits },
    });
    this.lastPaymentRequest = paymentRequest;
    return paymentRequest;
  }

  getLastPaymentRequest(): StripePaymentRequest | null {
    return this.lastPaymentRequest;
  }
}
