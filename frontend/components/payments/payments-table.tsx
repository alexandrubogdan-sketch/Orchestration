"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Input, Select } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { PaymentStateBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import type { Payment, PaymentState } from "@/lib/types";
import { PAYMENT_STATES } from "@/lib/types";
import { formatDateTime, formatMoney } from "@/lib/utils";

export function PaymentsTable({ payments }: { payments: Payment[] }) {
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState<PaymentState | "all">("all");
  const [pspFilter, setPspFilter] = useState<string>("all");

  const pspAccounts = useMemo(
    () => Array.from(new Set(payments.map((p) => p.pspAccount))).sort(),
    [payments],
  );

  const filtered = useMemo(() => {
    return payments.filter((p) => {
      if (stateFilter !== "all" && p.state !== stateFilter) return false;
      if (pspFilter !== "all" && p.pspAccount !== pspFilter) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        if (!p.customerEmail.toLowerCase().includes(q) && !p.id.toLowerCase().includes(q)) {
          return false;
        }
      }
      return true;
    });
  }, [payments, search, stateFilter, pspFilter]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          placeholder="Search by customer email or payment id"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <Select
          value={stateFilter}
          onChange={(e) => setStateFilter(e.target.value as PaymentState | "all")}
        >
          <option value="all">All statuses</option>
          {PAYMENT_STATES.map((s) => (
            <option key={s} value={s}>
              {s.replace(/_/g, " ")}
            </option>
          ))}
        </Select>
        <Select value={pspFilter} onChange={(e) => setPspFilter(e.target.value)}>
          <option value="all">All PSP accounts</option>
          {pspAccounts.map((psp) => (
            <option key={psp} value={psp}>
              {psp}
            </option>
          ))}
        </Select>
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
              <TH>PSP account</TH>
              <TH>Type</TH>
              <TH className="text-right">Amount</TH>
              <TH>Status</TH>
              <TH>Created</TH>
            </TR>
          </THead>
          <TBody>
            {filtered.slice(0, 100).map((payment) => (
              <TR key={payment.id}>
                <TD>
                  <Link href={`/payments/${payment.id}`} className="font-mono text-xs text-accent-foreground hover:underline">
                    {payment.id}
                  </Link>
                </TD>
                <TD className="text-sm">
                  <Link
                    href={`/customers/${payment.customerId}`}
                    className="text-accent-foreground hover:underline"
                  >
                    {payment.customerEmail}
                  </Link>
                </TD>
                <TD className="text-sm text-muted-foreground">{payment.product}</TD>
                <TD className="text-sm text-muted-foreground">{payment.pspAccount}</TD>
                <TD>
                  <Badge tone={payment.citMit === "mit" ? "info" : "neutral"}>
                    {payment.citMit.toUpperCase()}
                  </Badge>
                </TD>
                <TD className="text-right font-medium">
                  {formatMoney(payment.amountMinorUnits, payment.currency)}
                </TD>
                <TD>
                  <PaymentStateBadge state={payment.state} />
                </TD>
                <TD className="text-sm text-muted-foreground">{formatDateTime(payment.createdAt)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
        {filtered.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">No payments match these filters.</div>
        ) : null}
      </div>
    </div>
  );
}
