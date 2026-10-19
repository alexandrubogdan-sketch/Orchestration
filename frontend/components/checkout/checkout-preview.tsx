"use client";

import { useEffect, useRef, useState } from "react";
import { loadCheckout, type CheckoutSession } from "@alphapayments/checkout-sdk";
import { useCheckoutStore } from "@/lib/checkout-store";
import { useEnvironmentStore } from "@/lib/environment-store";
import { CHECKOUT_METHOD_LABELS, type CheckoutMethod } from "@/lib/types";
import { cn } from "@/lib/utils";
import { problemMessage } from "@/lib/live-api";

const MOCK_SESSION_ID = "cs_sandbox_preview";
const MOCK_CLIENT_SECRET = "cs_secret_sandbox_preview";
const MOCK_API_BASE_URL = "https://sandbox.internal.invalid";
const PREVIEW_AMOUNT = { minorUnits: 4999, currency: "usd" };

const LIVE_PREVIEW_CUSTOMER_EMAIL = "checkout-preview@progresspartners.net";

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

async function createLiveCheckoutSession(): Promise<{ id: string; clientSecret: string }> {
  const response = await fetch("/api/checkout-sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      customerEmail: LIVE_PREVIEW_CUSTOMER_EMAIL,
      amount: PREVIEW_AMOUNT,
      citMit: "cit",
    }),
  });
  if (!response.ok) {
    const message = problemMessage(await response.text());
    throw new Error(message || `Request failed with status ${response.status}`);
  }
  const data = (await response.json()) as { id: string; clientSecret: string };
  return data;
}

type WalletStatus = "idle" | "processing" | "succeeded" | "error";

export function CheckoutPreview() {
  const methods = useCheckoutStore((s) => s.methods);
  const environment = useEnvironmentStore((s) => s.environment);
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<CheckoutSession | null>(null);
  const liveSessionRef = useRef<{ id: string; clientSecret: string } | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorDetail, setErrorDetail] = useState<string>("");
  const [paymentStatus, setPaymentStatus] = useState<"idle" | "processing" | "succeeded" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [walletStatus, setWalletStatus] = useState<Record<string, WalletStatus>>({});
  const [walletErrors, setWalletErrors] = useState<Record<string, string>>({});

  const enabledMethods = methods.filter((m) => m.enabled);
  const orderedLabels = enabledMethods.map((m) => CHECKOUT_METHOD_LABELS[m.type]);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setErrorDetail("");

    async function boot() {
      if (environment === "live") {
        const session = await createLiveCheckoutSession();
        liveSessionRef.current = session;
        return loadCheckout({
          apiBaseUrl: `${window.location.origin}/api`,
          sessionId: session.id,
          clientSecret: session.clientSecret,
        });
      }
      return loadCheckout({
        apiBaseUrl: MOCK_API_BASE_URL,
        sessionId: MOCK_SESSION_ID,
        clientSecret: MOCK_CLIENT_SECRET,
        fetchImpl: buildFakeFetch(),
      });
    }

    boot()
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
      .catch((err: unknown) => {
        if (cancelled) return;
        setStatus("error");
        setErrorDetail(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [environment]);

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

  const payWithWallet = async (type: string) => {
    if (walletStatus[type] === "processing" || walletStatus[type] === "succeeded") return;
    const session = liveSessionRef.current;
    if (!session) {
      setWalletStatus((prev) => ({ ...prev, [type]: "error" }));
      setWalletErrors((prev) => ({ ...prev, [type]: "No live checkout session — see the error above the preview." }));
      return;
    }

    setWalletStatus((prev) => ({ ...prev, [type]: "processing" }));
    setWalletErrors((prev) => ({ ...prev, [type]: "" }));

    try {
      const response = await fetch(`/api/checkout/${encodeURIComponent(session.id)}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientSecret: session.clientSecret,
          paymentMethodRef: `pm_test_wallet_${type}`,
        }),
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `Request failed with status ${response.status}`);
      }
      setWalletStatus((prev) => ({ ...prev, [type]: "succeeded" }));
    } catch (err) {
      setWalletStatus((prev) => ({ ...prev, [type]: "error" }));
      setWalletErrors((prev) => ({
        ...prev,
        [type]: err instanceof Error ? err.message : String(err),
      }));
    }
  };

  const handleWalletClick = environment === "live" ? payWithWallet : simulateWalletPay;

  const hasAnyEnabled = enabledMethods.length > 0;

  return (
    <div className="relative flex h-fit max-w-[480px] flex-col items-center justify-center gap-4 rounded-lg bg-neutral-100 px-6 py-6 dark:bg-neutral-900 md:col-span-2 md:max-w-none [@media(min-width:1260px)]:col-span-1">
      <div className="flex w-full items-center justify-between gap-2">
        <p className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">Checkout preview</p>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
            environment === "live"
              ? "bg-red-500/15 text-red-600 dark:text-red-400"
              : "bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400",
          )}
        >
          {environment === "live" ? "Live — calls backend-go" : "Sandbox — mock only"}
        </span>
      </div>

      <p className="text-center text-xs text-muted-foreground">
        {orderedLabels.length > 0 ? `Showing: ${orderedLabels.join(", ")}` : "No payment methods enabled"}
      </p>

      <div className="flex w-full max-w-[440px] flex-col gap-3 rounded-lg border border-border bg-surface p-4">
        {status === "loading" && (
          <p className="text-sm text-muted-foreground">
            {environment === "live" ? "Creating a live checkout session…" : "Loading preview checkout…"}
          </p>
        )}
        {status === "error" && (
          <p className="text-sm text-danger">
            {environment === "live"
              ? `Could not create a live checkout session: ${errorDetail}`
              : "Could not load the preview checkout session."}
          </p>
        )}

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
                    {environment === "live"
                      ? "Card — Live mode. Submits to the real checkout session created above."
                      : "Card — sandbox mode. Use any 16-digit number that passes a Luhn check."}
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
                    <p className="text-xs text-success">
                      {environment === "live"
                        ? "Payment succeeded against the real backend."
                        : "Payment succeeded against the mock PSP driver."}
                    </p>
                  )}
                  {paymentStatus === "error" && <p className="text-xs text-danger">{errorMessage}</p>}
                </div>
              );
            }

            if (method.type === "paypal" || method.type === "apple_pay" || method.type === "google_pay") {
              return (
                <div key={method.id} className="flex flex-col gap-1">
                  <WalletButton
                    method={method}
                    status={walletStatus[method.type] ?? "idle"}
                    onClick={() => handleWalletClick(method.type)}
                  />
                  {walletStatus[method.type] === "error" && walletErrors[method.type] && (
                    <p className="text-xs text-danger">{walletErrors[method.type]}</p>
                  )}
                </div>
              );
            }

            return null;
          })
        )}
      </div>

      <p className="max-w-[440px] text-center text-[11px] leading-relaxed text-muted-foreground">
        {environment === "live"
          ? "PayPal/Apple Pay/Google Pay buttons call the real backend with a synthetic paymentMethodRef — this demo has no real wallet JS SDK to tokenize a card, but the confirm call itself is genuine."
          : "PayPal/Apple Pay/Google Pay buttons here simulate a tap-to-pay flow client-side — the SDK's mock driver has no wallet support yet, so these aren't real SDK-mounted elements like Card is."}
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

function AppleGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M16.7 12.7c0-1.9 1-3 2.8-3.7-.9-1.3-2.4-2-3.9-2-1.2 0-2.2.6-2.9.6-.7 0-1.7-.6-2.9-.6-2.4 0-4.9 2-4.9 5.6 0 2.2 1.5 6.9 3.6 6.9 1 0 1.6-.7 2.9-.7 1.2 0 1.7.7 2.9.7 1.9 0 3.6-3.6 3.6-4.8-.1 0-1.2-.5-1.2-2zM13.2 5.4c.6-.7 1-1.6.9-2.6-.9.1-1.9.6-2.5 1.3-.6.6-1 1.5-.9 2.5.9 0 1.9-.5 2.5-1.2z" />
    </svg>
  );
}
