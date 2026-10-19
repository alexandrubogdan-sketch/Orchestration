import type { Appearance } from "../appearance";
import type { PublicConfig } from "../http";

export interface CardElementChangeState {
  complete: boolean;

  empty: boolean;

  error?: string;
}

export interface CardHandle {
  unmount(): void;

  onChange(listener: (state: CardElementChangeState) => void): () => void;

  getState(): CardElementChangeState;
}

export type TokenizeResult =
  | { paymentMethodRef: string; error?: undefined }
  | { paymentMethodRef?: undefined; error: string };

export interface ConfirmActionResult {
  success: boolean;
  error?: string;
}

export interface Driver {
  init(publicConfig: PublicConfig): Promise<void>;

  mountCard(
    container: HTMLElement,
    appearance: Appearance | undefined,
  ): CardHandle;

  tokenize(cardHandle: CardHandle): Promise<TokenizeResult>;

  supportsExpressCheckout(): boolean;

  confirmAction(pspClientSecret: string): Promise<ConfirmActionResult>;
}
