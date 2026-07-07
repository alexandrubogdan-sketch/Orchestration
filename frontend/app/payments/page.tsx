"use client";

import { useEffect, useState } from "react";
import { Topbar } from "@/components/layout/topbar";
import { PaymentsTable } from "@/components/payments/payments-table";
import { LivePaymentsTable } from "@/components/payments/live-payments-table";
import { useEnvironmentStore } from "@/lib/environment-store";
import { fetchLivePayments, type LivePayment } from "@/lib/live-api";
import { getMockPayments } from "@/lib/mock-data";

/** Client component (was a Server Component) so it can read the
 *  sidebar's Sandbox/Live toggle (lib/environment-store.ts is
 *  client-only Zustand state) and, in Live mode, fetch real data from
 *  this app's own /api/payments proxy instead of lib/mock-data.ts.
 *  Sandbox behavior is byte-for-byte what this page did before the
 *  toggle existed. */
export default function PaymentsPage() {
  const environment = useEnvironmentStore((s) => s.environment);
  const [liveStatus, setLiveStatus] = useState<"loading" | "ready" | "error">("loading");
  const [liveError, setLiveError] = useState("");
  const [livePayments, setLivePayments] = useState<LivePayment[]>([]);

  useEffect(() => {
    if (environment !== "live") return;
    let cancelled = false;

    // Deliberately no synchronous setLiveStatus("loading") here — the
    // first activation already starts from that initial state, and
    // re-fetches after a mode flip keep showing the previous
    // ready/error result until this new fetch resolves rather than
    // flashing back to a loading state (a corner case: back-to-back
    // Sandbox -> Live -> Sandbox -> Live toggling).
    fetchLivePayments()
      .then((res) => {
        if (cancelled) return;
        setLivePayments(res.data);
        setLiveStatus("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLiveError(err instanceof Error ? err.message : String(err));
        setLiveStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [environment]);

  return (
    <>
      <Topbar
        title="Payments"
        description={
          environment === "live"
            ? "Real payments from the live backend (backend-go)"
            : "Every payment across all products and PSP accounts"
        }
      />
      <div className="flex-1 overflow-y-auto p-8">
        {environment === "sandbox" ? (
          <PaymentsTable payments={getMockPayments()} />
        ) : liveStatus === "loading" ? (
          <p className="text-sm text-muted-foreground">Loading payments from the live backend…</p>
        ) : liveStatus === "error" ? (
          <div className="rounded-lg border border-danger/30 bg-danger-bg p-4 text-sm text-danger">
            Could not load live payments: {liveError}
          </div>
        ) : (
          <LivePaymentsTable payments={livePayments} />
        )}
      </div>
    </>
  );
}
