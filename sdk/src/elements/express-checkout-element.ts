import type { Driver } from "../drivers/types";
import { StripeDriver } from "../drivers/stripe-driver";
import type { Money } from "../http";

export type ExpressCheckoutEventMap = {
  ready: { available: boolean };

  paymentmethod: { paymentMethodRef: string };
};

export class ExpressCheckoutElement {
  readonly type = "expressCheckout" as const;
  private container: HTMLElement | null = null;
  private button: HTMLButtonElement | null = null;
  private readonly listeners = new Map<
    string,
    Set<(payload: unknown) => void>
  >();

  constructor(
    private readonly driver: Driver,
    private readonly amount: Money,
    private readonly countryCode: string,
  ) {}

  on<E extends keyof ExpressCheckoutEventMap>(
    event: E,
    listener: (payload: ExpressCheckoutEventMap[E]) => void,
  ): void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener as (payload: unknown) => void);
    this.listeners.set(event, set);
  }

  private emit<E extends keyof ExpressCheckoutEventMap>(
    event: E,
    payload: ExpressCheckoutEventMap[E],
  ): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of set) {
      listener(payload);
    }
  }

  async mount(container: HTMLElement | string): Promise<void> {
    const target =
      typeof container === "string"
        ? document.querySelector<HTMLElement>(container)
        : container;
    if (!target) {
      const description =
        typeof container === "string" ? container : "<HTMLElement>";
      throw new Error(
        `ExpressCheckoutElement.mount(): could not resolve container "${description}".`,
      );
    }
    this.container = target;

    if (
      !this.driver.supportsExpressCheckout() ||
      !(this.driver instanceof StripeDriver)
    ) {
      this.emit("ready", { available: false });
      return;
    }

    const paymentRequest = this.driver.createPaymentRequest({
      country: this.countryCode,
      currency: this.amount.currency.toLowerCase(),
      amountMinorUnits: this.amount.minorUnits,
      label: "Total",
    });

    const canMakePayment = await paymentRequest.canMakePayment();
    if (!canMakePayment) {
      this.emit("ready", { available: false });
      return;
    }

    this.emit("ready", { available: true });

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Pay with wallet";
    button.setAttribute("aria-label", "Express checkout");
    button.addEventListener("click", () => {
      paymentRequest.show();
    });
    this.button = button;
    target.appendChild(button);

    paymentRequest.on("paymentmethod", (event) => {
      this.emit("paymentmethod", { paymentMethodRef: event.paymentMethod.id });
      event.complete("success");
    });
  }

  unmount(): void {
    this.button?.remove();
    this.button = null;
    this.container = null;
  }

  isMounted(): boolean {
    return this.button !== null;
  }
}
