import type { Appearance } from "../appearance";
import type {
  CardElementChangeState,
  CardHandle,
  Driver,
} from "../drivers/types";

export type CardElementEventMap = {
  change: CardElementChangeState;
};

export class CardElement {
  readonly type = "card" as const;
  private handle: CardHandle | null = null;
  private mountedContainer: HTMLElement | null = null;
  private readonly changeListeners = new Set<
    (state: CardElementChangeState) => void
  >();
  private unsubscribeFromHandle: (() => void) | null = null;

  constructor(
    private readonly driver: Driver,
    private readonly appearance: Appearance | undefined,
  ) {}

  mount(container: HTMLElement | string): void {
    const target =
      typeof container === "string"
        ? document.querySelector<HTMLElement>(container)
        : container;
    if (!target) {
      const description =
        typeof container === "string" ? container : "<HTMLElement>";
      throw new Error(
        `CardElement.mount(): could not resolve container "${description}".`,
      );
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

  getHandle(): CardHandle | null {
    return this.handle;
  }

  isMounted(): boolean {
    return this.handle !== null && this.mountedContainer !== null;
  }
}
