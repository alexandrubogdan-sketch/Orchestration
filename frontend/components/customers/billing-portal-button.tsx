"use client";

import { useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";

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
