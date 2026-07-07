"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Braces } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyToClipboardButton } from "@/components/ui/copy-to-clipboard-button";
import { cn } from "@/lib/utils";
import type { Customer } from "@/lib/types";

/**
 * Raw JSON payload of the full Customer record — split into three
 * clearly separate objects instead of one flat blob, matching how a
 * real API response would group these concerns:
 *
 *  - `customer`   — identity/profile fields (name, email, address,
 *                    legal entity, external ref, etc.)
 *  - `subscription` — this customer's link to a Plan (see the Plans
 *                    catalog): plan id/name, status, creation date.
 *  - `paymentMethods` — an array (a customer can have 1-3 saved
 *                    methods) of display-safe card metadata only:
 *                    brand, last4, expiry, active flag, PSP account.
 *                    Never a PAN/CVV (Non-negotiable #8, see
 *                    lib/types.ts's CustomerPaymentMethod doc comment).
 *
 * This is a developer-facing "view the underlying record" panel, the
 * same idea as a PSP dashboard's "view raw object" button on a
 * customer record — useful for anyone wiring this demo's mock data
 * into a real API client later, since it shows the exact shape (and
 * grouping) to expect.
 */
export function CustomerPayloadViewer({
  customer,
  className,
}: {
  customer: Customer;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(true);

  const { subscription, paymentMethods, ...customerFields } = customer;

  const customerJson = JSON.stringify(customerFields, null, 2);
  const subscriptionJson = JSON.stringify(subscription, null, 2);
  const paymentMethodsJson = JSON.stringify(paymentMethods, null, 2);
  const fullJson = JSON.stringify(
    { customer: customerFields, subscription, paymentMethods },
    null,
    2,
  );

  return (
    <Card className={className}>
      <CardHeader className="cursor-pointer select-none" onClick={() => setExpanded((v) => !v)}>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Braces className="h-4 w-4 text-muted-foreground" />
            Raw payload (JSON)
          </CardTitle>
          <div className="flex items-center gap-3">
            <CopyToClipboardButton text={fullJson} className="h-4 w-4" />
            {expanded ? (
              <ChevronUp className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            )}
          </div>
        </div>
      </CardHeader>
      {expanded ? (
        <CardContent className="flex flex-col gap-4">
          <PayloadSection title="customer" json={customerJson} />
          <PayloadSection title="subscription" json={subscriptionJson} />
          <PayloadSection title="paymentMethods" json={paymentMethodsJson} />

          <p className="text-xs text-muted-foreground">
            Three separate objects, exactly as a real API response would group them — display-safe
            card metadata only, never a PAN/CVV.
          </p>
        </CardContent>
      ) : null}
    </Card>
  );
}

function PayloadSection({ title, json }: { title: string; json: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <p className="font-mono text-xs font-semibold text-muted-foreground">{title}</p>
        <CopyToClipboardButton text={json} className="h-3.5 w-3.5" />
      </div>
      <pre
        className={cn(
          "max-h-[320px] overflow-auto rounded-lg border border-border bg-neutral-950 p-4",
          "font-mono text-xs leading-relaxed text-neutral-200",
        )}
      >
        {json}
      </pre>
    </div>
  );
}
