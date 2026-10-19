"use client";

import { useEffect, useState } from "react";
import { Topbar } from "@/components/layout/topbar";
import { CustomersTable } from "@/components/customers/customers-table";
import { LiveCustomersTable } from "@/components/customers/live-customers-table";
import { useEnvironmentStore } from "@/lib/environment-store";
import { fetchLiveCustomers, type LiveCustomer } from "@/lib/live-api";
import { getMockCustomers } from "@/lib/mock-data";

export default function CustomersPage() {
  const environment = useEnvironmentStore((s) => s.environment);
  const [liveStatus, setLiveStatus] = useState<"loading" | "ready" | "error">("loading");
  const [liveError, setLiveError] = useState("");
  const [liveCustomers, setLiveCustomers] = useState<LiveCustomer[]>([]);

  useEffect(() => {
    if (environment !== "live") return;
    let cancelled = false;

    fetchLiveCustomers()
      .then((res) => {
        if (cancelled) return;
        setLiveCustomers(res.data);
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
        title="Customers"
        description={
          environment === "live"
            ? "Real customers from the live backend (backend-go)"
            : "Every customer that has attempted a payment, with their saved payment methods"
        }
      />
      <div className="flex-1 overflow-y-auto p-8">
        {environment === "sandbox" ? (
          <CustomersTable customers={getMockCustomers()} />
        ) : liveStatus === "loading" ? (
          <p className="text-sm text-muted-foreground">Loading customers from the live backend…</p>
        ) : liveStatus === "error" ? (
          <div className="rounded-lg border border-danger/30 bg-danger-bg p-4 text-sm text-danger">
            Could not load live customers: {liveError}
          </div>
        ) : (
          <LiveCustomersTable customers={liveCustomers} />
        )}
      </div>
    </>
  );
}
