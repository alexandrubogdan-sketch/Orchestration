"use client";

import { useEffect, useRef, useState } from "react";
import { loadCheckout, type CheckoutSession } from "@alphapayments/checkout-sdk";
import { useCheckoutStore } from "@/lib/checkout-store";
import { CHECKOUT_METHOD_LABELS, type CheckoutMethod } from "@/lib/types";
import { cn } from "@/lib/utils";

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
 * PayPal / Apple Pay / Google Pay: the SDK's `mock` driver has no
 * express-checkout/wallet support (see mock-driver.ts's
 * supportsExpressCheckout() — always false), so these three don't get
 * a real SDK-mounted element the way Card does. Instead this preview
 * renders its own lightweight, brand-colored button per enabled
 * method (not an exact reproduction of the official button assets —
 * a simplified same-color/same-wordmark stand-in built for this demo)
 * and drives the same local "processing -> succeeded" simulation Card
 * uses, so the preview genuinely reacts to clicking each button
 * instead of only ever showing Card. Cash App/Venmo never render here
 * because Cash App can never be enabled (see
 * lib/mock-data.ts#getInitialCheckoutMethods) and Venmo no longer
 * exists as a method at all.
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

type WalletStatus = "idle" | "processing" | "succeeded";

export function CheckoutPreview() {
  const methods = useCheckoutStore((s) => s.methods);
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<CheckoutSession | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [paymentStatus, setPaymentStatus] = useState<"idle" | "processing" | "succeeded" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [walletStatus, setWalletStatus] = useState<Record<string, WalletStatus>>({});

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
    // session created once; only Card is ever enabled/disabled against
    // a live SDK element in this simplified sandbox model (see the
    // wallet-button doc comment above for how PayPal/Apple Pay/Google
    // Pay are simulated instead).
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

  const simulateWalletPay = (type: string) => {
    if (walletStatus[type] === "processing" || walletStatus[type] === "succeeded") return;
    setWalletStatus((prev) => ({ ...prev, [type]: "processing" }));
    window.setTimeout(() => {
      setWalletStatus((prev) => ({ ...prev, [type]: "succeeded" }));
    }, 900);
  };

  const hasAnyEnabled = enabledMethods.length > 0;

  return (
    <div className="relative flex h-fit max-w-[480px] flex-col items-center justify-center gap-4 rounded-lg bg-neutral-100 px-6 py-6 dark:bg-neutral-900 md:col-span-2 md:max-w-none [@media(min-width:1260px)]:col-span-1">
      <p className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">Checkout preview</p>

      <p className="text-center text-xs text-muted-foreground">
        {orderedLabels.length > 0 ? `Showing: ${orderedLabels.join(", ")}` : "No payment methods enabled"}
      </p>

      <div className="flex w-full max-w-[440px] flex-col gap-3 rounded-lg border border-border bg-surface p-4">
        {status === "loading" && <p className="text-sm text-muted-foreground">Loading preview checkout…</p>}
        {status === "error" && <p className="text-sm text-danger">Could not load the preview checkout session.</p>}

        {!hasAnyEnabled ? (
          <p className="text-sm text-muted-foreground">
            No payment methods enabled — enable one in the methods list to see it rendered here.
          </p>
        ) : (
          enabledMethods.map((method) => {
            if (method.type === "card") {
              return (
                <div key={method.id} className="flex flex-col gap-3">
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
              );
            }

            if (method.type === "paypal" || method.type === "apple_pay" || method.type === "google_pay") {
              return (
                <WalletButton
                  key={method.id}
                  method={method}
                  status={walletStatus[method.type] ?? "idle"}
                  onClick={() => simulateWalletPay(method.type)}
                />
              );
            }

            return null;
          })
        )}
      </div>

      <p className="max-w-[440px] text-center text-[11px] leading-relaxed text-muted-foreground">
        PayPal/Apple Pay/Google Pay buttons here simulate a tap-to-pay flow client-side — the
        SDK&apos;s mock driver has no wallet support yet, so these aren&apos;t real SDK-mounted elements
        like Card is.
      </p>
    </div>
  );
}

function WalletButton({
  method,
  status,
  onClick,
}: {
  method: CheckoutMethod;
  status: WalletStatus;
  onClick: () => void;
}) {
  if (status === "succeeded") {
    return (
      <div className="flex h-11 w-full items-center justify-center rounded-md border border-success/30 bg-success-bg text-sm font-medium text-success">
        Paid with {CHECKOUT_METHOD_LABELS[method.type]}
      </div>
    );
  }

  if (method.type === "paypal") {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={status === "processing"}
        className="flex h-11 w-full items-center justify-center gap-1.5 rounded-md bg-[#FFC439] text-base font-bold tracking-tight text-[#003087] transition-opacity hover:opacity-90 disabled:opacity-70"
      >
        {status === "processing" ? (
          <span className="text-sm font-medium">Processing…</span>
        ) : (
          <>
            <span className="text-[#003087]">Pay</span>
            <span className="text-[#009cde]">Pal</span>
          </>
        )}
      </button>
    );
  }

  if (method.type === "apple_pay") {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={status === "processing"}
        className="flex h-11 w-full items-center justify-center gap-1.5 rounded-md bg-black text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-70"
      >
        {status === "processing" ? (
          "Processing…"
        ) : (
          <>
            <AppleGlyph className="h-4 w-4 fill-white" />
            <span className="text-base">Pay</span>
          </>
        )}
      </button>
    );
  }

  if (method.type === "google_pay") {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={status === "processing"}
        className={cn(
          "flex h-11 w-full items-center justify-center gap-1.5 rounded-md border border-neutral-300 bg-white text-sm font-medium text-neutral-800",
          "transition-opacity hover:opacity-90 disabled:opacity-70 dark:border-neutral-700",
        )}
      >
        {status === "processing" ? (
          "Processing…"
        ) : (
          <>
            <span className="font-semibold">
              <span className="text-[#4285F4]">G</span>
              <span className="text-[#EA4335]">o</span>
              <span className="text-[#FBBC05]">o</span>
              <span className="text-[#4285F4]">g</span>
              <span className="text-[#34A853]">l</span>
              <span className="text-[#EA4335]">e</span>
            </span>
            <span className="text-base">Pay</span>
          </>
        )}
      </button>
    );
  }

  return null;
}

/** Minimal custom-drawn apple silhouette (not the official trademarked
 *  glyph) — good enough for a demo button, avoids embedding Apple's
 *  actual icon asset. */
function AppleGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M16.7 12.7c0-1.9 1-3 2.8-3.7-.9-1.3-2.4-2-3.9-2-1.2 0-2.2.6-2.9.6-.7 0-1.7-.6-2.9-.6-2.4 0-4.9 2-4.9 5.6 0 2.2 1.5 6.9 3.6 6.9 1 0 1.6-.7 2.9-.7 1.2 0 1.7.7 2.9.7 1.9 0 3.6-3.6 3.6-4.8-.1 0-1.2-.5-1.2-2zM13.2 5.4c.6-.7 1-1.6.9-2.6-.9.1-1.9.6-2.5 1.3-.6.6-1 1.5-.9 2.5.9 0 1.9-.5 2.5-1.2z" />
    </svg>
  );
}
