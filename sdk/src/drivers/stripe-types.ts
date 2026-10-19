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
  create(
    type: "card",
    options?: { style?: Record<string, unknown> },
  ): StripeCardElement;
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
  on(
    event: "paymentmethod",
    handler: (event: {
      paymentMethod: { id: string };
      complete: (status: "success" | "fail") => void;
    }) => void,
  ): void;
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

export type StripeConstructor = (publishableKey: string) => StripeClient;

declare global {
  interface Window {
    Stripe?: StripeConstructor;
  }
}
