/**
 * Mock driver — a fully self-contained fake PSP integration, mirroring
 * the backend's own `mock` adapter (payment-orchestrator-go's
 * internal/adapters/mock). Used for local development, demos, and
 * integration tests that don't need a live PSP account.
 *
 * Renders real card/expiry/CVC inputs inside a closed Shadow DOM
 * (see elements/card-inputs.ts), validates them client-side (Luhn,
 * expiry, CVC length), and "tokenizes" to a deterministic-looking but
 * random fake ref — never a real PSP token, never sent anywhere but
 * this SDK's own confirm() call.
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

class MockCardHandle implements CardHandle {
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

  getRawValues(): { number: string; expiry: string; cvc: string } {
    return {
      number: this.elements.numberInput.value,
      expiry: this.elements.expiryInput.value,
      cvc: this.elements.cvcInput.value,
    };
  }
}

export class MockDriver implements Driver {
  init(_publicConfig: PublicConfig): Promise<void> {
    // No real setup needed — nothing to load, no network calls.
    return Promise.resolve();
  }

  mountCard(container: HTMLElement, appearance: Appearance | undefined): CardHandle {
    return new MockCardHandle(container, appearance);
  }

  tokenize(cardHandle: CardHandle): Promise<TokenizeResult> {
    const state = cardHandle.getState();
    if (!state.complete) {
      return Promise.resolve({ error: state.error ?? "Card details are incomplete." });
    }
    return Promise.resolve({ paymentMethodRef: randomToken("pm_mock") });
  }

  supportsExpressCheckout(): boolean {
    return false;
  }

  confirmAction(_pspClientSecret: string): Promise<ConfirmActionResult> {
    // The mock backend never actually issues a real challenge, but we
    // implement this so `driveAction`-style flows can still be
    // exercised end-to-end against the mock PSP in tests/demos.
    return Promise.resolve({ success: true });
  }
}
