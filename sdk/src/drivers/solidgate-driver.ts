/**
 * Solidgate driver.
 *
 * FLAGGED — THIS IS THE LEAST VERIFIED PART OF THE SDK. Unlike
 * stripe-driver.ts (built against Stripe.js's real, published,
 * well-documented client API), Solidgate's actual embeddable
 * tokenization widget/JS SDK was NOT independently researched for
 * this build. There was no reachable documentation or sandbox account
 * in this build environment to confirm Solidgate's real client-side
 * tokenization shape (script URL, constructor signature, field
 * mounting API, token response shape, or client-side 3DS handling).
 *
 * What follows is a FUNCTIONAL PLACEHOLDER: it reuses the mock
 * driver's exact UX shape (real card/expiry/CVC inputs rendered via
 * elements/card-inputs.ts, same client-side Luhn/expiry/CVC
 * validation) and produces a fake `pm_solidgate_<random>`-shaped
 * ref, so the rest of the SDK (session state machine, React bindings,
 * appearance system) can be built, wired, and tested end-to-end today
 * against a `psp: "solidgate"` checkout session. It is NOT a real
 * Solidgate integration and must not be presented to a merchant as
 * one. Before shipping a real Solidgate driver: get Solidgate's actual
 * client-side SDK docs/sandbox credentials, replace mountCard/tokenize
 * below with real calls into their SDK, and delete this comment block.
 *
 * (Mirrors the backend's own honesty convention — see
 * payment-orchestrator-go/internal/adapters/solidgate/solidgate.go's
 * header comment, which flags analogous gaps on the server side.)
 */
import { attachCardInputs, computeChangeState, type CardInputElements } from "../elements/card-inputs";
import type { Appearance } from "../appearance";
import type {
  CardElementChangeState,
  CardHandle,
  ConfirmActionResult,
  Driver,
  TokenizeResult,
} from "./types";
import type { PublicConfig } from "../http";

function randomToken(prefix: string): string {
  const bytes = new Uint8Array(12);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}`;
}

class SolidgateCardHandle implements CardHandle {
  private readonly elements: CardInputElements;
  private readonly listeners = new Set<(state: CardElementChangeState) => void>();
  private state: CardElementChangeState;

  constructor(container: HTMLElement, appearance: Appearance | undefined) {
    this.elements = attachCardInputs(container, appearance);
    this.state = computeChangeState(this.elements);

    const handleInput = (): void => {
      this.state = computeChangeState(this.elements);
      for (const listener of this.listeners) {
        listener(this.state);
      }
    };
    this.elements.numberInput.addEventListener("input", handleInput);
    this.elements.expiryInput.addEventListener("input", handleInput);
    this.elements.cvcInput.addEventListener("input", handleInput);
  }

  unmount(): void {
    this.elements.root.remove();
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

export class SolidgateDriver implements Driver {
  init(_publicConfig: PublicConfig): Promise<void> {
    // Placeholder: a real driver would load Solidgate's client SDK
    // script here and initialize it with publicConfig.publishableKey
    // / merchantIdentifier, analogous to stripe-driver.ts's script
    // injection.
    return Promise.resolve();
  }

  mountCard(container: HTMLElement, appearance: Appearance | undefined): CardHandle {
    return new SolidgateCardHandle(container, appearance);
  }

  tokenize(cardHandle: CardHandle): Promise<TokenizeResult> {
    const state = cardHandle.getState();
    if (!state.complete) {
      return Promise.resolve({ error: state.error ?? "Card details are incomplete." });
    }
    return Promise.resolve({ paymentMethodRef: randomToken("pm_solidgate") });
  }

  supportsExpressCheckout(): boolean {
    return false;
  }

  confirmAction(_pspClientSecret: string): Promise<ConfirmActionResult> {
    // Placeholder — a real driver would drive Solidgate's own 3DS
    // challenge flow using pspClientSecret here.
    return Promise.resolve({ success: true });
  }
}
