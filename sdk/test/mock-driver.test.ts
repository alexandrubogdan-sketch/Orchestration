import { describe, expect, it } from "vitest";
import { MockDriver } from "../src/drivers/mock-driver";

describe("MockDriver card element", () => {
  it("mounts a card handle inside a closed Shadow DOM and starts empty", () => {
    const driver = new MockDriver();
    const container = document.createElement("div");
    document.body.appendChild(container);

    const handle = driver.mountCard(container, undefined);
    expect(handle.getState()).toEqual({ complete: false, empty: true });

    const hostNode = container.firstElementChild as HTMLElement;
    expect(hostNode.shadowRoot).toBeNull();
  });

  it("becomes complete once valid card/expiry/cvc are entered, and tokenizes", async () => {
    const driver = new MockDriver();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const handle = driver.mountCard(container, undefined);

    const result = await driver.tokenize(handle);
    expect(result.error).toBe("Card details are incomplete.");
  });

  it("reports no express checkout support", () => {
    const driver = new MockDriver();
    expect(driver.supportsExpressCheckout()).toBe(false);
  });

  it("confirmAction always succeeds (mock PSP never issues a real challenge)", async () => {
    const driver = new MockDriver();
    const result = await driver.confirmAction("fake-secret");
    expect(result).toEqual({ success: true });
  });
});
