/**
 * @alphapayments/checkout-sdk — browser-embeddable checkout SDK for
 * Alpha Payments. See README.md for the full integration guide.
 *
 * Quick start:
 *
 *   import { loadCheckout } from "@alphapayments/checkout-sdk";
 *
 *   const checkout = await loadCheckout({
 *     apiBaseUrl: "https://api.example.com",
 *     sessionId: session.id,
 *     clientSecret: session.clientSecret,
 *   });
 *
 *   const card = checkout.createElement("card");
 *   card.mount("#card-container");
 *
 * For React bindings, import from "@alphapayments/checkout-sdk/react" instead.
 */
export { loadCheckout, CheckoutSession } from "./session";
export type {
  LoadCheckoutOptions,
  CreateElementOptions,
  ConfirmOptions,
  ConfirmResult,
  Payment,
} from "./session";

export { CardElement } from "./elements/card-element";
export type { CardElementEventMap } from "./elements/card-element";

export { ExpressCheckoutElement } from "./elements/express-checkout-element";
export type { ExpressCheckoutEventMap } from "./elements/express-checkout-element";

export type { CardElementChangeState } from "./drivers/types";

export type { Appearance } from "./appearance";
export { DEFAULT_APPEARANCE } from "./appearance";

export {
  CheckoutSessionNotFoundError,
  CheckoutSessionClosedError,
  CheckoutApiError,
} from "./http";
export type {
  Money,
  PspName,
  CheckoutSessionStatus,
  PublicConfig,
  CheckoutSessionPublic,
} from "./http";

export { classifyPaymentState } from "./state-classification";
export type {
  PaymentStateClassification,
  ClassifyPaymentStateInput,
} from "./state-classification";
