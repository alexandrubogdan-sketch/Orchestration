"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Braces } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyToClipboardButton } from "@/components/ui/copy-to-clipboard-button";
import { cn } from "@/lib/utils";
import type { Customer } from "@/lib/types";

export function CustomerPayloadViewer({
  customer,
  className,
}: {
  customer: Customer;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(true);

  const { subscription, paymentMethods, ...customerFields } = customer;

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
          <p className="text-xs text-muted-foreground">
            Single combined payload — display-safe card metadata only, never a PAN/CVV.
          </p>
          <pre
            className={cn(
              "max-h-[320px] overflow-auto rounded-lg border border-border bg-neutral-950 p-4",
              "font-mono text-xs leading-relaxed text-neutral-200",
            )}
          >
            {fullJson}
          </pre>
        </CardContent>
      ) : null}
    </Card>
  );
}
