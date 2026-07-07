import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { loadCheckout } from "../src/session";
import { CardElement } from "../src/elements/card-element";
import type { CardElementChangeState, Driver } from "../src/drivers/types";

/**
 * These tests exercise CheckoutSession.confirm()'s state-machine logic
 * end-to-end against a hand-rolled fake Driver (NOT the real
 * mock-driver.ts — we want full control over tokenize()/confirmAction()
 * return values here, independent of Luhn/expiry validation) plus a
 * mocked fetch standing in for the backend's two public endpoints.
 *
 * CheckoutSession.create()/loadCheckout() picks a driver internally
 * based on publicConfig.psp, with no injection seam exposed publicly
 * (deliberately — merchants should never need to swap drivers by
 * hand). To drive the state machine under test, we load a real
 * session against a "mock" psp (so it doesn't try to load Stripe.js),
 * then monkeypatch the session's private `driver` field to our fake
 * before calling confirm() — confirm() only ever reads `this.driver`,
 * so this is enough to fully control tokenize()/confirmAction()
 * behavior without reimplementing CheckoutSession's internals here.
 */

const PUBLIC_CONFIG_BODY = {
  id: "cs_1",
  amount: { minorUnits: 1000, currency: "usd" },
  status: "open",
  expiresAt: "2026-07-07T00:15:00Z",
  psp: "mock",
  publicConfig: { psp: "mock", publishableKey: "pk_test" },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

class FakeCardHandle {
  private state = { complete: true, empty: false };

  unmount(): void {}
  onChange(_listener: (state: CardElementChangeState) => void): () => void {
    return () => {};
  }
  getState(): CardElementChangeState {
    return this.state;
  }
}

interface FakeDriver extends Driver {
  tokenize: Mock;
  confirmAction: Mock;
}

function makeFakeDriver(overrides: Partial<Driver> = {}): FakeDriver {
  return {
    init: vi.fn().mockResolvedValue(undefined),
    mountCard: vi.fn().mockReturnValue(new FakeCardHandle()),
    tokenize: vi.fn().mockResolvedValue({ paymentMethodRef: "pm_fake_123" }),
    supportsExpressCheckout: vi.fn().mockReturnValue(false),
    confirmAction: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  } as FakeDriver;
}

interface SessionInternals {
  driver: Driver;
}

async function createSessionWithFakeDriver(driver: FakeDriver, fetchImpl: typeof fetch) {
  const session = await loadCheckout({
    apiBaseUrl: "https://api.example.com",
    sessionId: "cs_1",
    clientSecret: "secret_1",
    fetchImpl,
  });
  (session as unknown as SessionInternals).driver = driver;
  const element = new CardElement(driver, undefined);
  element.mount(document.createElement("div"));
  return { session, element };
}

describe("CheckoutSession.confirm", () => {
  let fetchImpl: Mock;

  beforeEach(() => {
    fetchImpl = vi.fn();
  });

  it("returns succeeded when the backend reports a captured state", async () => {
    fetchImpl
      .mockResolvedValueOnce(jsonResponse(200, PUBLIC_CONFIG_BODY))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: "pay_1",
          productId: "prod_1",
          customerId: "cust_1",
          amount: { minorUnits: 1000, currency: "usd" },
          state: "captured",
          citMit: "cit",
          createdAt: "2026-07-07T00:00:00Z",
          updatedAt: "2026-07-07T00:00:01Z",
        }),
      );

    const driver = makeFakeDriver();
    const { session, element } = await createSessionWithFakeDriver(driver, fetchImpl);

    const result = await session.confirm({ element });
    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      expect(result.payment.state).toBe("captured");
    }
  });

  it("returns error when the backend reports a declined state", async () => {
    fetchImpl
      .mockResolvedValueOnce(jsonResponse(200, PUBLIC_CONFIG_BODY))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: "pay_1",
          productId: "prod_1",
          customerId: "cust_1",
          amount: { minorUnits: 1000, currency: "usd" },
          state: "declined",
          citMit: "cit",
          createdAt: "2026-07-07T00:00:00Z",
          updatedAt: "2026-07-07T00:00:01Z",
        }),
      );

    const driver = makeFakeDriver();
    const { session, element } = await createSessionWithFakeDriver(driver, fetchImpl);

    const result = await session.confirm({ element });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe("declined");
    }
  });

  it("automatically drives 3DS then succeeds on re-confirm", async () => {
    fetchImpl
      .mockResolvedValueOnce(jsonResponse(200, PUBLIC_CONFIG_BODY))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: "pay_1",
          productId: "prod_1",
          customerId: "cust_1",
          amount: { minorUnits: 1000, currency: "usd" },
          state: "requires_action",
          citMit: "cit",
          createdAt: "2026-07-07T00:00:00Z",
          updatedAt: "2026-07-07T00:00:01Z",
          clientSecret: "pi_123_secret_abc",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: "pay_1",
          productId: "prod_1",
          customerId: "cust_1",
          amount: { minorUnits: 1000, currency: "usd" },
          state: "authorized",
          citMit: "cit",
          createdAt: "2026-07-07T00:00:00Z",
          updatedAt: "2026-07-07T00:00:02Z",
        }),
      );

    const driver = makeFakeDriver();
    const onBeforeAction = vi.fn();
    const { session, element } = await createSessionWithFakeDriver(driver, fetchImpl);

    const result = await session.confirm({ element, onBeforeAction });
    expect(onBeforeAction).toHaveBeenCalledOnce();
    expect(driver.confirmAction).toHaveBeenCalledWith("pi_123_secret_abc");
    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      expect(result.payment.state).toBe("authorized");
    }
    // Two confirm POSTs (initial + post-3DS re-confirm) plus one public GET.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("returns requires_action when the driver cannot drive the action", async () => {
    fetchImpl.mockResolvedValueOnce(jsonResponse(200, PUBLIC_CONFIG_BODY)).mockResolvedValueOnce(
      jsonResponse(200, {
        id: "pay_1",
        productId: "prod_1",
        customerId: "cust_1",
        amount: { minorUnits: 1000, currency: "usd" },
        state: "requires_action",
        citMit: "cit",
        createdAt: "2026-07-07T00:00:00Z",
        updatedAt: "2026-07-07T00:00:01Z",
        clientSecret: "pi_123_secret_abc",
      }),
    );

    const driver = makeFakeDriver({
      confirmAction: vi.fn().mockResolvedValue({ success: false, error: "User cancelled the challenge." }),
    });
    const { session, element } = await createSessionWithFakeDriver(driver, fetchImpl);

    const result = await session.confirm({ element });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toBe("User cancelled the challenge.");
      expect(result.error.code).toBe("action_failed");
    }
  });

  it("returns requires_action when state is non-terminal with no pspClientSecret", async () => {
    fetchImpl.mockResolvedValueOnce(jsonResponse(200, PUBLIC_CONFIG_BODY)).mockResolvedValueOnce(
      jsonResponse(200, {
        id: "pay_1",
        productId: "prod_1",
        customerId: "cust_1",
        amount: { minorUnits: 1000, currency: "usd" },
        state: "authorizing",
        citMit: "cit",
        createdAt: "2026-07-07T00:00:00Z",
        updatedAt: "2026-07-07T00:00:01Z",
      }),
    );

    const driver = makeFakeDriver();
    const { session, element } = await createSessionWithFakeDriver(driver, fetchImpl);

    const result = await session.confirm({ element });
    expect(result.status).toBe("requires_action");
  });

  it("returns a network-error result if the confirm request rejects", async () => {
    fetchImpl.mockResolvedValueOnce(jsonResponse(200, PUBLIC_CONFIG_BODY)).mockRejectedValueOnce(new Error("network down"));

    const driver = makeFakeDriver();
    const { session, element } = await createSessionWithFakeDriver(driver, fetchImpl);

    const result = await session.confirm({ element });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toBe("network down");
    }
  });

  it("returns a tokenization error without calling the backend confirm endpoint", async () => {
    fetchImpl.mockResolvedValueOnce(jsonResponse(200, PUBLIC_CONFIG_BODY));

    const driver = makeFakeDriver({
      tokenize: vi.fn().mockResolvedValue({ error: "Card number is invalid." }),
    });
    const { session, element } = await createSessionWithFakeDriver(driver, fetchImpl);

    const result = await session.confirm({ element });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe("tokenization_failed");
    }
    // Only the initial public-config GET, no confirm POST.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("confirms the registered active element when called with no arguments (React ergonomics)", async () => {
    fetchImpl
      .mockResolvedValueOnce(jsonResponse(200, PUBLIC_CONFIG_BODY))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: "pay_1",
          productId: "prod_1",
          customerId: "cust_1",
          amount: { minorUnits: 1000, currency: "usd" },
          state: "captured",
          citMit: "cit",
          createdAt: "2026-07-07T00:00:00Z",
          updatedAt: "2026-07-07T00:00:01Z",
        }),
      );

    const driver = makeFakeDriver();
    const { session, element } = await createSessionWithFakeDriver(driver, fetchImpl);
    session.registerActiveElement(element);

    const result = await session.confirm();
    expect(result.status).toBe("succeeded");
  });

  it("returns a no_element error when confirm() is called with no active element registered", async () => {
    fetchImpl.mockResolvedValueOnce(jsonResponse(200, PUBLIC_CONFIG_BODY));

    const driver = makeFakeDriver();
    const { session } = await createSessionWithFakeDriver(driver, fetchImpl);
    session.registerActiveElement(null);

    const result = await session.confirm();
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe("no_element");
    }
  });
});
