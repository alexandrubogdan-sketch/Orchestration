"use client";

import { Rocket } from "lucide-react";
import { Topbar } from "@/components/layout/topbar";
import { Button } from "@/components/ui/button";
import { CheckoutMethodsList } from "@/components/checkout/checkout-methods-list";
import { CheckoutConditions } from "@/components/checkout/checkout-conditions";
import { CheckoutPreview } from "@/components/checkout/checkout-preview";
import { useCheckoutStore, useIsCheckoutDirty } from "@/lib/checkout-store";

/**
 * Checkout configurator — modeled on a real orchestrator client's
 * Checkout module: a header with a Publish button (red unsaved-
 * changes dot while dirty) above a responsive 3-column layout
 * (methods list / conditions panel / live preview), matching that
 * client's own `grid-cols-[auto_1fr]` -> `[auto_2fr_2fr]` breakpoint
 * shape at `min-width: 1260px`.
 *
 * Every other page in this frontend renders against local Zustand
 * state + generated fixtures, never a live API (see lib/mock-data.ts's
 * top doc comment) — this page keeps that convention for its OWN
 * config state (lib/checkout-store.ts's methods/conditions, "Publish"
 * button). The one exception, and it's a deliberate one: the preview
 * column on the right genuinely drives this repo's own
 * `@alphapayments/checkout-sdk` package end-to-end (real card
 * validation, real confirm()/state-classification code paths) by
 * injecting a tiny in-memory fake `fetch` at the SDK's own
 * `fetchImpl` extension point instead of skipping the SDK entirely —
 * see components/checkout/checkout-preview.tsx's doc comment for
 * exactly why that's still "no real fetch() call" in spirit: nothing
 * here ever reaches an actual network socket.
 */
export default function CheckoutPage() {
  const isDirty = useIsCheckoutDirty();
  const isPublishing = useCheckoutStore((s) => s.isPublishing);
  const publish = useCheckoutStore((s) => s.publish);

  return (
    <>
      <Topbar
        title="Checkout"
        description="Configure which payment methods customers see, in what order, and how each one routes."
      />
      <div className="flex-1 overflow-y-auto p-8">
        <div className="mx-auto flex max-w-[1440px] flex-col gap-6">
          <div className="flex items-center justify-end">
            <div className="relative">
              <Button onClick={publish} disabled={isPublishing || !isDirty}>
                <Rocket className="size-4" />
                {isPublishing ? "Publishing…" : "Publish"}
              </Button>

              {isDirty && !isPublishing && (
                <span className="absolute -top-1 -right-1 size-2.5 rounded-full bg-red-500" />
              )}
            </div>
          </div>

          <div className="grid justify-center gap-6 md:grid-cols-[auto_1fr] [@media(min-width:1260px)]:grid-cols-[auto_2fr_2fr]">
            <CheckoutMethodsList />
            <CheckoutConditions />
            <CheckoutPreview />
          </div>
        </div>
      </div>
    </>
  );
}
