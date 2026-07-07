import type { Appearance } from "../appearance";
import type { CardElementChangeState, CardHandle, Driver } from "../drivers/types";

export type CardElementEventMap = {
  change: CardElementChangeState;
};

/**
 * Public-facing card element returned by `checkout.createElement("card", ...)`.
 * Thin wrapper around whatever `CardHandle` the active driver produces —
 * this is the layer that gives merchants the Stripe.js-shaped
 * `mount()` / `on("change", ...)` / `unmount()` API regardless of
 * which driver (stripe/mock/solidgate) is actually active.
 */
export class CardElement {
  readonly type = "card" as const;
  private handle: CardHandle | null = null;
  private mountedContainer: HTMLElement | null = null;
  private readonly changeListeners = new Set<(state: CardElementChangeState) => void>();
  private unsubscribeFromHandle: (() => void) | null = null;

  constructor(
    private readonly driver: Driver,
    private readonly appearance: Appearance | undefined,
  ) {}

  /**
   * Mounts the element into the given container, which may be a CSS
   * selector string (resolved via `document.querySelector`) or a
   * live DOM node — matching Stripe.js Element.mount()'s ergonomics.
   */
  mount(container: HTMLElement | string): void {
    const target = typeof container === "string" ? document.querySelector<HTMLElement>(container) : container;
    if (!target) {
      const description = typeof container === "string" ? container : "<HTMLElement>";
      throw new Error(`CardElement.mount(): could not resolve container "${description}".`);
    }
    if (this.handle) {
      this.unmount();
    }
    this.mountedContainer = target;
    this.handle = this.driver.mountCard(target, this.appearance);
    this.unsubscribeFromHandle = this.handle.onChange((state) => {
      for (const listener of this.changeListeners) {
        listener(state);
      }
    });
  }

  unmount(): void {
    this.unsubscribeFromHandle?.();
    this.unsubscribeFromHandle = null;
    this.handle?.unmount();
    this.handle = null;
    this.mountedContainer = null;
  }

  /** Subscribes to element events. Currently only `"change"` is emitted. */
  on<E extends keyof CardElementEventMap>(
    event: E,
    listener: (payload: CardElementEventMap[E]) => void,
  ): void {
    if (event === "change") {
      this.changeListeners.add(listener);
    }
  }

  off<E extends keyof CardElementEventMap>(
    event: E,
    listener: (payload: CardElementEventMap[E]) => void,
  ): void {
    if (event === "change") {
      this.changeListeners.delete(listener);
    }
  }

  /** @internal used by CheckoutSession.confirm() to reach the underlying driver handle. */
  getHandle(): CardHandle | null {
    return this.handle;
  }

  isMounted(): boolean {
    return this.handle !== null && this.mountedContainer !== null;
  }
}
