import { describe, expect, it } from "vitest";
import { attachCardInputs, computeChangeState } from "../src/elements/card-inputs";

describe("attachCardInputs + computeChangeState", () => {
  it("starts empty", () => {
    const container = document.createElement("div");
    const elements = attachCardInputs(container, undefined);
    expect(computeChangeState(elements)).toEqual({ complete: false, empty: true });
  });

  it("reports complete: true once a valid card/expiry/cvc are entered", () => {
    const container = document.createElement("div");
    const elements = attachCardInputs(container, undefined);

    elements.numberInput.value = "4242 4242 4242 4242";
    elements.expiryInput.value = "09/30";
    elements.cvcInput.value = "123";

    expect(computeChangeState(elements)).toEqual({ complete: true, empty: false });
  });

  it("reports a validation error for an invalid card number", () => {
    const container = document.createElement("div");
    const elements = attachCardInputs(container, undefined);

    elements.numberInput.value = "4242 4242 4242 4241"; // bad checksum
    elements.expiryInput.value = "09/30";
    elements.cvcInput.value = "123";

    const state = computeChangeState(elements);
    expect(state.complete).toBe(false);
    expect(state.error).toBe("Card number is invalid.");
    expect(elements.numberInput.dataset.invalid).toBe("true");
  });

  it("reports a validation error for an expired card", () => {
    const container = document.createElement("div");
    const elements = attachCardInputs(container, undefined);

    elements.numberInput.value = "4242 4242 4242 4242";
    elements.expiryInput.value = "01/20";
    elements.cvcInput.value = "123";

    const state = computeChangeState(elements);
    expect(state.complete).toBe(false);
    expect(state.error).toBe("Expiry date is invalid or in the past.");
  });

  it("reports a validation error for a bad CVC", () => {
    const container = document.createElement("div");
    const elements = attachCardInputs(container, undefined);

    elements.numberInput.value = "4242 4242 4242 4242";
    elements.expiryInput.value = "09/30";
    elements.cvcInput.value = "12";

    const state = computeChangeState(elements);
    expect(state.complete).toBe(false);
    expect(state.error).toBe("Security code is invalid.");
  });

  it("attaches a closed shadow root to the container", () => {
    const container = document.createElement("div");
    attachCardInputs(container, undefined);
    const hostNode = container.firstElementChild as HTMLElement;
    expect(hostNode.shadowRoot).toBeNull();
  });
});
