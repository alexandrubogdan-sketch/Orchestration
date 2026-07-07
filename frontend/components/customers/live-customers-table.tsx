"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import type { LiveCustomer } from "@/lib/live-api";
import { formatDate } from "@/lib/utils";

/** Live-mode customers table — deliberately a separate, narrower
 *  component from components/customers/customers-table.tsx rather
 *  than reusing it: that table's Customer type requires
 *  firstName/lastName/country/address/subscription/paymentMethods,
 *  none of which the real backend's CustomerDTO returns (the
 *  `customers` table has no such columns — see
 *  payment-orchestrator-go/internal/api/customers.go's top doc
 *  comment). Renders exactly id/email/externalRef/createdAt, and says
 *  so plainly rather than padding the table with fabricated columns. */
export function LiveCustomersTable({ customers }: { customers: LiveCustomer[] }) {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter(
      (c) =>
        c.id.toLowerCase().includes(q) ||
        (c.email ?? "").toLowerCase().includes(q) ||
        (c.externalRef ?? "").toLowerCase().includes(q),
    );
  }, [customers, search]);

  return (
    <div className="flex flex-col gap-4">
      <p className="rounded-lg border border-border bg-neutral-bg px-3 py-2 text-xs text-muted-foreground">
        Live mode shows only what the backend actually stores today — id, email, external ref, and
        timestamps. Name, address, and subscription columns don&apos;t exist in the live schema yet
        (Sandbox&apos;s richer table is mock data).
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          placeholder="Search by email, customer id, or external ref"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <span className="ml-auto text-sm text-muted-foreground">
          {filtered.length} of {customers.length} customers
        </span>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        <Table>
          <THead>
            <TR>
              <TH>Customer id</TH>
              <TH>Email</TH>
              <TH>External ref</TH>
              <TH>Created</TH>
            </TR>
          </THead>
          <TBody>
            {filtered.map((customer) => (
              <TR key={customer.id}>
                <TD>
                  <Link
                    href={`/customers/${customer.id}`}
                    className="font-mono text-xs text-accent-foreground hover:underline"
                  >
                    {customer.id}
                  </Link>
                </TD>
                <TD className="text-sm">{customer.email ?? "—"}</TD>
                <TD className="font-mono text-xs text-muted-foreground">{customer.externalRef ?? "—"}</TD>
                <TD className="text-sm text-muted-foreground">{formatDate(customer.createdAt)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
        {filtered.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            {customers.length === 0 ? "No customers yet on the live backend." : "No customers match this search."}
          </div>
        ) : null}
      </div>
    </div>
  );
}
