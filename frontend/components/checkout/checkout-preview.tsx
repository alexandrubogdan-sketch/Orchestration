"use client";

import { useEffect, useRef, useState } from "react";
import { loadCheckout, type CheckoutSession } from "@alphapayments/checkout-sdk";
import { useCheckoutStore } from "@/lib/checkout-store";
import { CHECKOUT_METHOD_LABELS } from "@/lib/types";

/**
 * Live preview column — mirrors the real client's
 * checkout-preview.component.tsx shape (a neutral-100 card with a
 * title, mounting a real embeddable checkout instance into a fixed
 * container id), but genuinely wired to THIS repo's own
 * `@alphapayments/checkout-sdk` package (payment-orchestrator-sdk)
 * rather than a vendor SDK or a static screenshot.
 *
 * No real network call: this whole frontend's established convention
 * (see lib/mock-data.ts's top doc comment) is that nothing here calls
 * a live backend. `loadCheckout()`'s only network calls are
 * `GET /checkout/{id}/public` (session config) and
 * `POST /checkout/{id}/confirm` — both go through the injectable
 * `fetchImpl` option (see payment-orchestrator-sdk/src/session.ts),
 * so a tiny in-memory fake `fetch` below answers both endpoints
 * itself, entirely client-side, using the "mock" PSP driver
 * (payment-orchestrator-sdk/src/drivers/mock-driver.ts — a real card
 * element with real Luhn/expiry/CVC validation, fake tokens, zero
 * network traffic by the driver itself). This is still the REAL SDK
 * code path end-to-end (loadCheckout -> CheckoutSession ->
 * createElement("card") -> confirm() -> classifyPaymentState()) —
 * only the two HTTP round trips are faked, exactly the seam the SDK
 * exposes `fetchImpl` for (its own README lists it as "primarily for
 * tests," which this is a legitimate extension of: a sandboxed demo
 * with no backend at all).
 *
 * The div id is intentionally generic ("checkout-preview-mount"),
 * renamed away from the real client's vendor-specific mount id.
 */

const MOCK_SESSION_ID = "cs_sandbox_preview";
const MOCK_CLIENT_SECRET = "cs_secret_sandbox_preview";
const MOCK_API_BASE_URL = "https://sandbox.internal.invalid";
const PREVIEW_AMOUNT = { minorUnits: 4999, currency: "usd" };

function buildFakeFetch(): typeof fetch {
  let consumed = false;

  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("/public")) {
      const body = {
        id: MOCK_SESSION_ID,
        amount: PREVIEW_AMOUNT,
        status: "open" as const,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        psp: "mock" as const,
        publicConfig: { psp: "mock" as const, publishableKey: "pk_mock_sandbox" },
      };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url.includes("/confirm")) {
      // Simulate a successful confirmation on the first confirm() call
      // per mount (matches the mock driver's own "no real challenge"
      // behavior) — good enough for demoing the full quick-start flow
      // end-to-end (card entry -> confirm -> succeeded) without a
      // backend, without ever pretending a real charge occurred.
      consumed = true;
      const body = {
        id: MOCK_SESSION_ID,
        productId: "prod_sandbox_preview",
        customerId: "cust_sandbox_preview",
        amount: PREVIEW_AMOUNT,
        state: consumed ? "captured" : "created",
        citMit: "cit",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ message: "Unhandled sandbox preview route" }), { status: 404 });
  };
}

export function CheckoutPreview() {
  const methods = useCheckoutStore((s) => s.methods);
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<CheckoutSession | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [paymentStatus, setPaymentStatus] = useState<"idle" | "processing" | "succeeded" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string>("");

  const enabledMethods = methods.filter((m) => m.enabled);
  const orderedLabels = enabledMethods.map((m) => CHECKOUT_METHOD_LABELS[m.type]);

  useEffect(() => {
    let cancelled = false;

    loadCheckout({
      apiBaseUrl: MOCK_API_BASE_URL,
      sessionId: MOCK_SESSION_ID,
      clientSecret: MOCK_CLIENT_SECRET,
      fetchImpl: buildFakeFetch(),
    })
      .then((session) => {
        if (cancelled) return;
        sessionRef.current = session;
        setStatus("ready");

        if (containerRef.current) {
          const card = session.createElement("card", {
            appearance: { colorPrimary: "#6366f1", borderRadius: "10px" },
          });
          card.mount(containerRef.current);
          session.registerActiveElement(card);
        }
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });

    return () => {
      cancelled = true;
    };
    // Intentionally runs once per mount — the preview column re-derives
    // its "enabled methods" summary text reactively from the store
    // below, but the mounted card element itself only needs the mock
    // session created once; only Card is ever enabled/disabled
    // against a live element in this simplified sandbox model since
    // the mock driver only supports a card element (no wallet
    // express-checkout support — see mock-driver.ts's
    // supportsExpressCheckout()).
  }, []);

  const handlePay = async () => {
    const session = sessionRef.current;
    if (!session) return;
    setPaymentStatus("processing");
    setErrorMessage("");

    const result = await session.confirm();
    if (result.status === "succeeded") {
      setPaymentStatus("succeeded");
    } else if (result.status === "error") {
      setPaymentStatus("error");
      setErrorMessage(result.error.message);
    } else {
      setPaymentStatus("idle");
    }
  };

  const cardEnabled = enabledMethods.some((m) => m.type === "card");

  return (
    <div className="relative flex h-fit max-w-[480px] flex-col items-center justify-center gap-4 rounded-lg bg-neutral-100 px-6 py-6 dark:bg-neutral-900 md:col-span-2 md:max-w-none [@media(min-width:1260px)]:col-span-1">
      <p className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">Checkout preview</p>

      <p className="text-center text-xs text-muted-foreground">
        {orderedLabels.length > 0 ? `Showing: ${orderedLabels.join(", ")}` : "No payment methods enabled"}
      </p>

      <div className="w-full max-w-[440px] rounded-lg border border-border bg-surface p-4">
        {status === "loading" && <p className="text-sm text-muted-foreground">Loading preview checkout…</p>}
        {status === "error" && <p className="text-sm text-danger">Could not load the preview checkout session.</p>}

        {cardEnabled ? (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">
              Card — sandbox mode. Use any 16-digit number that passes a Luhn check.
            </p>
            <div id="checkout-preview-mount" ref={containerRef} />

            <button
              type="button"
              onClick={handlePay}
              disabled={status !== "ready" || paymentStatus === "processing" || paymentStatus === "succeeded"}
              className="mt-1 inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
            >
              {paymentStatus === "processing"
                ? "Processing…"
                : paymentStatus === "succeeded"
                  ? "Paid"
                  : `Pay $${(PREVIEW_AMOUNT.minorUnits / 100).toFixed(2)}`}
            </button>

            {paymentStatus === "succeeded" && (
              <p className="text-xs text-success">Payment succeeded against the mock PSP driver.</p>
            )}
            {paymentStatus === "error" && <p className="text-xs text-danger">{errorMessage}</p>}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Card is the only method this sandbox preview can render (the mock PSP driver has no wallet/APM
            support) — enable Card in the methods list to see a live checkout instance here.
          </p>
        )}
      </div>
    </div>
  );
}
