import { describe, expect, it, vi } from "vitest";
import {
  CheckoutApiError,
  CheckoutHttpClient,
  CheckoutSessionClosedError,
  CheckoutSessionNotFoundError,
} from "../src/http";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

describe("CheckoutHttpClient.getPublicConfig", () => {
  it("returns the parsed body on success", async () => {
    const publicConfig = {
      id: "cs_1",
      amount: { minorUnits: 1000, currency: "usd" },
      status: "open",
      expiresAt: "2026-07-07T00:15:00Z",
      psp: "mock",
      publicConfig: { psp: "mock", publishableKey: "pk_test" },
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, publicConfig));
    const client = new CheckoutHttpClient({
      apiBaseUrl: "https://api.example.com",
      sessionId: "cs_1",
      clientSecret: "secret_1",
      fetchImpl,
    });

    const result = await client.getPublicConfig();
    expect(result).toEqual(publicConfig);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.example.com/checkout/cs_1/public?clientSecret=secret_1",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("throws CheckoutSessionNotFoundError on 404", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse(404, "not found"));
    const client = new CheckoutHttpClient({
      apiBaseUrl: "https://api.example.com",
      sessionId: "cs_missing",
      clientSecret: "secret",
      fetchImpl,
    });

    await expect(client.getPublicConfig()).rejects.toBeInstanceOf(CheckoutSessionNotFoundError);
  });

  it("throws CheckoutSessionClosedError on 410", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse(410, "gone"));
    const client = new CheckoutHttpClient({
      apiBaseUrl: "https://api.example.com",
      sessionId: "cs_closed",
      clientSecret: "secret",
      fetchImpl,
    });

    await expect(client.getPublicConfig()).rejects.toBeInstanceOf(CheckoutSessionClosedError);
  });

  it("throws a generic CheckoutApiError for other failure statuses", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse(500, "boom"));
    const client = new CheckoutHttpClient({
      apiBaseUrl: "https://api.example.com",
      sessionId: "cs_1",
      clientSecret: "secret",
      fetchImpl,
    });

    const error = await client.getPublicConfig().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CheckoutApiError);
    expect((error as CheckoutApiError).status).toBe(500);
  });
});

describe("CheckoutHttpClient.confirm", () => {
  it("posts clientSecret + paymentMethodRef and returns the parsed body", async () => {
    const confirmResponse = {
      id: "pay_1",
      productId: "prod_1",
      customerId: "cust_1",
      amount: { minorUnits: 1000, currency: "usd" },
      state: "captured",
      citMit: "cit",
      createdAt: "2026-07-07T00:00:00Z",
      updatedAt: "2026-07-07T00:00:01Z",
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, confirmResponse));
    const client = new CheckoutHttpClient({
      apiBaseUrl: "https://api.example.com",
      sessionId: "cs_1",
      clientSecret: "secret_1",
      fetchImpl,
    });

    const result = await client.confirm("pm_mock_abc");
    expect(result).toEqual(confirmResponse);

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      clientSecret: "secret_1",
      paymentMethodRef: "pm_mock_abc",
    });
  });

  it("throws CheckoutSessionClosedError on 410 (already consumed)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse(410, "already consumed"));
    const client = new CheckoutHttpClient({
      apiBaseUrl: "https://api.example.com",
      sessionId: "cs_1",
      clientSecret: "secret_1",
      fetchImpl,
    });

    await expect(client.confirm("pm_mock_abc")).rejects.toBeInstanceOf(CheckoutSessionClosedError);
  });
});
