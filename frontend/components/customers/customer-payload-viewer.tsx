"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Braces } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyToClipboardButton } from "@/components/ui/copy-to-clipboard-button";
import { cn } from "@/lib/utils";
import type { Customer } from "@/lib/types";

/**
 * Raw JSON payload of the full Customer object — every field this mock
 * data model carries (name, email, address, payment-method tokens with
 * display-safe card metadata like last4/brand/expiry, legal entity,
 * etc.), exactly as `getMockCustomerById()` returns it. This is a
 * developer-facing "view the underlying record" panel, the same idea as
 * a PSP dashboard's "view raw object" button on a customer record —
 * useful for anyone wiring this demo's mock data into a real API client
 * later, since it shows the exact shape to expect.
 *
 * No PAN/CVV ever appears here (Non-negotiable #8, see lib/types.ts's
 * CustomerPaymentMethod doc comment) — card fields are strictly the
 * display-safe subset (brand, last4, expiry) a PSP token vault would
 * actually return alongside a payment-method reference.
 */
export function CustomerPayloadViewer({
  customer,
  className,
}: {
  customer: Customer;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(true);
  const json = JSON.stringify(customer, null, 2);

  return (
    <Card className={className}>
      <CardHeader
        className="cursor-pointer select-none"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Braces className="h-4 w-4 text-muted-foreground" />
            Raw payload (JSON)
          </CardTitle>
          <div className="flex items-center gap-3">
            <CopyToClipboardButton text={json} className="h-4 w-4" />
            {expanded ? (
              <ChevronUp className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            )}
          </div>
        </div>
      </CardHeader>
      {expanded ? (
        <CardContent>
          <pre
            className={cn(
              "max-h-[520px] overflow-auto rounded-lg border border-border bg-neutral-950 p-4",
              "font-mono text-xs leading-relaxed text-neutral-200",
            )}
          >
            {json}
          </pre>
          <p className="mt-2 text-xs text-muted-foreground">
            This is the full <code className="font-mono">Customer</code> object from{" "}
            <code className="font-mono">lib/mock-data.ts</code> — display-safe card metadata only,
            never a PAN/CVV.
          </p>
        </CardContent>
      ) : null}
    </Card>
  );
}
