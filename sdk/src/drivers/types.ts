import type { Appearance } from "../appearance";
import type { PublicConfig } from "../http";

/**
 * Live state of a mounted card element, delivered via the `on("change", ...)`
 * listener (see elements/card-element.ts).
 */
export interface CardElementChangeState {
  /** True once card number + expiry + CVC all pass client-side validation. */
  complete: boolean;
  /** True while the field is empty. */
  empty: boolean;
  /** Human-readable validation error, or undefined if there is none. */
  error?: string;
}

/**
 * Handle returned by a driver's `mountCard()`, used by the rest of
 * the SDK to read current validation state and to tokenize on
 * confirm. Drivers implement this over whatever internal
 * representation they use (raw inputs for mock/solidgate, a real
 * Stripe Element for stripe-driver).
 */
export interface CardHandle {
  /** Removes the mounted DOM and releases any driver-side listeners. */
  unmount(): void;
  /** Subscribes to validation-state changes; returns an unsubscribe function. */
  onChange(listener: (state: CardElementChangeState) => void): () => void;
  /** Latest known validation state, mirrors what onChange delivers. */
  getState(): CardElementChangeState;
}

export type TokenizeResult =
  | { paymentMethodRef: string; error?: undefined }
  | { paymentMethodRef?: undefined; error: string };

export interface ConfirmActionResult {
  success: boolean;
  error?: string;
}

/**
 * Every PSP integration (stripe / solidgate / mock) implements this
 * interface. `CheckoutSession` talks to the active driver only
 * through this contract, so swapping PSPs is a config-time decision
 * (`publicConfig.psp`), never a call-site change.
 */
export interface Driver {
  /** One-time setup — e.g. loading a PSP's SDK script, constructing its client. */
  init(publicConfig: PublicConfig): Promise<void>;

  /** Mounts a card entry UI into `container` and returns a handle to it. */
  mountCard(container: HTMLElement, appearance: Appearance | undefined): CardHandle;

  /** Converts the currently entered card details into an opaque PSP token/ref. */
  tokenize(cardHandle: CardHandle): Promise<TokenizeResult>;

  /** Whether this driver can render an express-checkout (wallet) button. */
  supportsExpressCheckout(): boolean;

  /**
   * Drives whatever client-side action the PSP requires (typically
   * 3DS) using the PSP's OWN client secret (distinct from the
   * checkout session's clientSecret). Only called when the driver
   * reports it can handle the action — see confirmAction's callers in
   * session.ts for the exact "requires_action" fallback conditions.
   */
  confirmAction(pspClientSecret: string): Promise<ConfirmActionResult>;
}
