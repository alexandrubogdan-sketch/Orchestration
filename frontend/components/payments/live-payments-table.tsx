"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { PaymentStateBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import type { LivePayment } from "@/lib/live-api";
import { PAYMENT_STATES, type PaymentState } from "@/lib/types";
import { formatDateTime, formatMoney } from "@/lib/utils";

const KNOWN_STATES = new Set<string>(PAYMENT_STATES);

/** Live-mode payments table — deliberately a separate, narrower
 *  component from components/payments/payments-table.tsx rather than
 *  reusing it: that table's Payment type requires fields
 *  (merchantEntity, product, customerEmail, pspAccount) the real
 *  backend's PaymentDTO doesn't return. Renders exactly what
 *  GET /v1/payments actually gives back — raw customerId/productId,
 *  no enrichment — rather than fabricating the missing columns. */
export function LivePaymentsTable({ payments }: { payments: LivePayment[] }) {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return payments;
    return payments.filter(
      (p) => p.id.toLowerCase().includes(q) || p.customerId.toLowerCase().includes(q),
    );
  }, [payments, search]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          placeholder="Search by payment id or customer id"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <span className="ml-auto text-sm text-muted-foreground">
          {filtered.length} of {payments.length} payments
        </span>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        <Table>
          <THead>
            <TR>
              <TH>Payment</TH>
              <TH>Customer</TH>
              <TH>Product</TH>
              <TH>Type</TH>
              <TH className="text-right">Amount</TH>
              <TH>Status</TH>
              <TH>Created</TH>
            </TR>
          </THead>
          <TBody>
            {filtered.map((payment) => (
              <TR key={payment.id}>
                <TD>
                  <Link href={`/payments/${payment.id}`} className="font-mono text-xs text-accent-foreground hover:underline">
                    {payment.id}
                  </Link>
                </TD>
                <TD>
                  <Link
                    href={`/customers/${payment.customerId}`}
                    className="font-mono text-xs text-accent-foreground hover:underline"
                  >
                    {payment.customerId}
                  </Link>
                </TD>
                <TD className="font-mono text-xs text-muted-foreground">{payment.productId}</TD>
                <TD>
                  <Badge tone={payment.citMit === "mit" ? "info" : "neutral"}>{payment.citMit.toUpperCase()}</Badge>
                </TD>
                <TD className="text-right font-medium">
                  {formatMoney(payment.amount.minorUnits, payment.amount.currency)}
                </TD>
                <TD>
                  {KNOWN_STATES.has(payment.state) ? (
                    <PaymentStateBadge state={payment.state as PaymentState} />
                  ) : (
                    <Badge tone="neutral">{payment.state}</Badge>
                  )}
                </TD>
                <TD className="text-sm text-muted-foreground">{formatDateTime(payment.createdAt)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
        {filtered.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            {payments.length === 0 ? "No payments yet on the live backend." : "No payments match this search."}
          </div>
        ) : null}
      </div>
    </div>
  );
}
