/**
 * Narrow local ambient types for the Stripe.js runtime, used ONLY at
 * the dynamic-script-load boundary in stripe-driver.ts.
 *
 * Why not just `import type { Stripe } from "@stripe/stripe-js"`:
 * `@stripe/stripe-js` IS listed as a devDependency (for exactly this
 * purpose — good types) but is an OPTIONAL peer dependency at
 * runtime, never bundled (see stripe-driver.ts's header comment for
 * why). Importing its types directly is safe (types are erased at
 * build time, so it doesn't create a runtime dependency), but this
 * file defines an intentionally narrower surface — just the handful
 * of methods/fields this driver actually calls — so:
 *   1. it's obvious at a glance exactly how much of Stripe.js's API
 *      surface this driver depends on, and
 *   2. if `@stripe/stripe-js` ever isn't installed as a devDependency
 *      in some downstream fork, this file alone (with zero external
 *      imports) is enough to keep the driver's `tsc --noEmit` clean.
 *
 * The actual runtime object comes from `window.Stripe(...)` after
 * https://js.stripe.com/v3 loads (injected by stripe-driver.ts), so
 * everything below is erased at compile time and never shipped.
 */

export interface StripeElementChangeEvent {
  complete: boolean;
  empty: boolean;
  error?: { message: string };
}

export interface StripeCardElement {
  mount(domElement: HTMLElement | string): void;
  unmount(): void;
  on(event: "change", handler: (event: StripeElementChangeEvent) => void): void;
}

export interface StripeElementsAppearance {
  variables?: Record<string, string>;
  rules?: Record<string, Record<string, string>>;
}

export interface StripeElements {
  create(type: "card", options?: { style?: Record<string, unknown> }): StripeCardElement;
}

export interface StripePaymentMethodResult {
  paymentMethod?: { id: string };
  error?: { message: string };
}

export interface StripePaymentIntentResult {
  paymentIntent?: { status: string };
  error?: { message: string };
}

export interface StripeCanMakePaymentResult {
  applePay?: boolean;
  googlePay?: boolean;
}

export interface StripePaymentRequest {
  canMakePayment(): Promise<StripeCanMakePaymentResult | null>;
  show(): void;
  on(event: "paymentmethod", handler: (event: { paymentMethod: { id: string }; complete: (status: "success" | "fail") => void }) => void): void;
}

export interface StripePaymentRequestOptions {
  country: string;
  currency: string;
  total: { label: string; amount: number };
}

export interface StripeClient {
  elements(options?: { appearance?: StripeElementsAppearance }): StripeElements;
  createPaymentMethod(options: {
    type: "card";
    card: StripeCardElement;
  }): Promise<StripePaymentMethodResult>;
  confirmCardPayment(clientSecret: string): Promise<StripePaymentIntentResult>;
  paymentRequest(options: StripePaymentRequestOptions): StripePaymentRequest;
}

/**
 * The only `any`-adjacent boundary in the driver: the global injected
 * by https://js.stripe.com/v3 isn't statically known to TypeScript,
 * so we declare it once, narrowly, here.
 */
export type StripeConstructor = (publishableKey: string) => StripeClient;

declare global {
  interface Window {
    Stripe?: StripeConstructor;
  }
}
