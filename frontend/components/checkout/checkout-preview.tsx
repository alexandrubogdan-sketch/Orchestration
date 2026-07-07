"use client";

import { useEffect, useRef, useState } from "react";
import { loadCheckout, type CheckoutSession } from "@alphapayments/checkout-sdk";
import { useCheckoutStore } from "@/lib/checkout-store";
import { useEnvironmentStore } from "@/lib/environment-store";
import { CHECKOUT_METHOD_LABELS, type CheckoutMethod } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Live preview column — mirrors the real client's
 * checkout-preview.component.tsx shape (a neutral-100 card with a
 * title, mounting a real embeddable checkout instance into a fixed
 * container id), genuinely wired to THIS repo's own
 * `@alphapayments/checkout-sdk` package (payment-orchestrator-sdk).
 *
 * Sandbox vs Live (sidebar toggle, lib/environment-store.ts):
 *
 * - Sandbox (default): the original, unchanged behavior. No real
 *   network call — `loadCheckout()`'s two HTTP round trips
 *   (GET .../public, POST .../confirm) go through an injectable
 *   in-memory `fetchImpl` (buildFakeFetch below) that answers both
 *   itself, using the SDK's "mock" PSP driver (real Luhn/expiry/CVC
 *   validation, fake tokens, zero network traffic). Wallet buttons
 *   (PayPal/Apple Pay/Google Pay) run a local setTimeout-based
 *   "processing -> succeeded" simulation — see simulateWalletPay.
 * - Live: creates a REAL checkout session (POST /api/checkout-sessions
 *   — this app's own server-side proxy, see lib/backend-proxy.ts,
 *   which holds the backend-go Bearer token so the browser never
 *   sees it), then loads the SDK against that real session with
 *   `apiBaseUrl` pointed at this app's own `/api` proxy routes (no
 *   fetchImpl override — genuinely goes over the network this time).
 *   Wallet buttons POST straight to /api/checkout/{id}/confirm with a
 *   clearly-labeled synthetic paymentMethodRef (see payWithWallet) —
 *   there's no real Apple Pay/Google Pay/PayPal JS SDK wired into this
 *   demo to produce a genuinely wallet-tokenized reference, but the
 *   backend call itself is 100% real, which is exactly what was
 *   broken before this toggle existed (every checkout method silently
 *   never reaching backend-go, regardless of which sidebar mode was
 *   selected — there was no Live mode at all).
 *
 * Until backend-go is actually deployed (see
 * payment-orchestrator-go/MIGRATION_NOTES.md — that module has never
 * been compiled, and Railway access to run it is still pending), Live
 * mode's own proxy routes return a 503 ("Live backend is not
 * configured") or a network error — surfaced here as a clear inline
 * error state, never silently downgraded to Sandbox's fake behavior.
 */

const MOCK_SESSION_ID = "cs_sandbox_preview";
const MOCK_CLIENT_SECRET = "cs_secret_sandbox_preview";
const MOCK_API_BASE_URL = "https://sandbox.internal.invalid";
const PREVIEW_AMOUNT = { minorUnits: 4999, currency: "usd" };
/** Live mode has no real merchant checkout flow feeding this preview
 *  column a real customer — this is the one synthetic identity Live
 *  mode's checkout-session creation call uses, clearly namespaced so
 *  it's obviously not a real customer if it ever shows up in a real
 *  Customers list. */
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

/** POSTs to this app's own /api/checkout-sessions proxy (holds the
 *  backend-go Bearer token server-side) to create a REAL checkout
 *  session — the Live-mode analogue of buildFakeFetch's "/public"
 *  branch above, except this one actually creates a row in backend-go
 *  rather than fabricating a response. Throws with a readable message
 *  on any failure (503 not-configured, network error, backend 4xx/5xx)
 *  rather than returning something the caller might mistake for
 *  success. */
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
    const detail = await response.text();
    let message = detail;
    try {
      const parsed = JSON.parse(detail) as { title?: string; detail?: string };
      message = [parsed.title, parsed.detail].filter(Boolean).join(" — ") || detail;
    } catch {
      // Not JSON — use the raw text as-is.
    }
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
          // No fetchImpl override here — this is the whole point of
          // Live mode: these two calls go over the real network, to
          // this app's own /api/checkout/[id]/public and
          // /api/checkout/[id]/confirm proxy routes, which forward to
          // backend-go.
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
    // Re-runs whenever the sidebar's Sandbox/Live toggle flips, so
    // switching modes tears down the old session/element and boots a
    // fresh one against the newly-selected backend rather than
    // continuing to drive a stale session created against the other
    // mode.
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

  /** Live-mode wallet tap: calls this app's real
   *  /api/checkout/[id]/confirm proxy directly (not through the SDK —
   *  CheckoutSession.confirm() is card-element-only; there's no real
   *  Apple Pay/Google Pay/PayPal JS SDK wired into this demo to
   *  produce a genuinely wallet-tokenized paymentMethodRef the way the
   *  SDK's driver.tokenize() does for Card). The paymentMethodRef sent
   *  is a clearly-labeled synthetic value — everything ELSE about this
   *  call is real: it hits backend-go's actual
   *  POST /checkout/{id}/confirm route, through the Bearer-token-free,
   *  client-secret-authenticated path that route actually expects. */
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
