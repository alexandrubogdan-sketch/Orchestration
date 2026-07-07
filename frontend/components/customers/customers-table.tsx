"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { CreditCard, Smartphone, Landmark } from "lucide-react";
import { Input, Select } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import type { Customer } from "@/lib/types";
import { COUNTRIES } from "@/lib/countries";
import { formatDate } from "@/lib/utils";

const countryName = (code: string) => COUNTRIES.find((c) => c.code === code)?.name ?? code;

function PrimaryMethodBadge({ customer }: { customer: Customer }) {
  const method = customer.paymentMethods.find((m) => m.isActive) ?? customer.paymentMethods[0];
  if (!method) return <span className="text-xs text-muted-foreground">No payment method</span>;

  if (method.type === "card") {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm">
        <CreditCard className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="capitalize">{method.cardBrand}</span>
        <span className="font-mono text-xs text-muted-foreground">•••• {method.cardLast4}</span>
      </span>
    );
  }
  if (method.type === "wallet") {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm">
        <Smartphone className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="capitalize">{method.cardBrand?.replace("_", " ")}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      <Landmark className="h-3.5 w-3.5 text-muted-foreground" />
      Bank transfer
    </span>
  );
}

export function CustomersTable({ customers }: { customers: Customer[] }) {
  const [search, setSearch] = useState("");
  const [countryFilter, setCountryFilter] = useState<string>("all");

  const countries = useMemo(
    () => Array.from(new Set(customers.map((c) => c.country))).sort(),
    [customers],
  );

  const filtered = useMemo(() => {
    return customers.filter((c) => {
      if (countryFilter !== "all" && c.country !== countryFilter) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        if (
          !c.email.toLowerCase().includes(q) &&
          !c.id.toLowerCase().includes(q) &&
          !`${c.firstName} ${c.lastName}`.toLowerCase().includes(q) &&
          !(c.externalRef ?? "").toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [customers, search, countryFilter]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          placeholder="Search by email, customer id, or external ref"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <Select value={countryFilter} onChange={(e) => setCountryFilter(e.target.value)}>
          <option value="all">All locations</option>
          {countries.map((code) => (
            <option key={code} value={code}>
              {countryName(code)}
            </option>
          ))}
        </Select>
        <span className="ml-auto text-sm text-muted-foreground">
          {filtered.length} of {customers.length} customers
        </span>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        <Table>
          <THead>
            <TR>
              <TH>Customer</TH>
              <TH>Legal entity</TH>
              <TH>Location</TH>
              <TH>Payment method</TH>
              <TH>External ref</TH>
              <TH>Customer since</TH>
            </TR>
          </THead>
          <TBody>
            {filtered.slice(0, 100).map((customer) => (
              <TR key={customer.id}>
                <TD>
                  <Link
                    href={`/customers/${customer.id}`}
                    className="block font-medium text-accent-foreground hover:underline"
                  >
                    {customer.firstName} {customer.lastName}
                  </Link>
                  <span className="block text-xs text-muted-foreground">{customer.email}</span>
                  <span className="font-mono text-xs text-muted-foreground">{customer.id}</span>
                </TD>
                <TD className="text-sm text-muted-foreground">{customer.merchantEntity}</TD>
                <TD>
                  <Badge tone="neutral">{countryName(customer.country)}</Badge>
                </TD>
                <TD>
                  <PrimaryMethodBadge customer={customer} />
                  {customer.paymentMethods.length > 1 ? (
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      +{customer.paymentMethods.length - 1} more
                    </span>
                  ) : null}
                </TD>
                <TD className="font-mono text-xs text-muted-foreground">
                  {customer.externalRef ?? "—"}
                </TD>
                <TD className="text-sm text-muted-foreground">{formatDate(customer.createdAt)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
        {filtered.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            No customers match these filters.
          </div>
        ) : null}
      </div>
    </div>
  );
}
