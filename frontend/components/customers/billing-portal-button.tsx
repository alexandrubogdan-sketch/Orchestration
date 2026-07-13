"use client";

import { useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";

/** "Manage billing" button (Stripe integration audit, 2026-07-12, Task
 *  #318) — POSTs to /api/customers/[id]/billing-portal-session (which
 *  proxies to backend-go's POST /v1/customers/{id}/billing-portal-
 *  session), then redirects the browser to the returned Stripe Billing
 *  Portal URL. Renders inline error text rather than a toast/modal —
 *  this repo has no global toast system wired up yet, and the two most
 *  likely failures (no live backend configured yet in Sandbox mode; this
 *  particular customer has no Stripe customer reference on file) are
 *  both perfectly explainable in a sentence next to the button itself.
 */
export function BillingPortalButton({ customerId }: { customerId: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/customers/${encodeURIComponent(customerId)}/billing-portal-session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ returnUrl: window.location.href }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.detail ?? body?.title ?? `Could not create a billing portal session (${res.status}).`);
        setLoading(false);
        return;
      }
      if (typeof body?.url === "string") {
        window.location.href = body.url;
        return;
      }
      setError("Backend did not return a billing portal URL.");
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="outline" size="sm" onClick={handleClick} disabled={loading}>
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}
        Manage billing
      </Button>
      {error ? <p className="max-w-[240px] text-right text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
