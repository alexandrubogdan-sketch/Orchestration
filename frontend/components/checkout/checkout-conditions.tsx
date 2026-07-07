"use client";

import { Reorder } from "framer-motion";
import { Plus } from "lucide-react";
import {
  CHECKOUT_METHODS_WITH_PROCESSOR_ROUTING,
  CHECKOUT_METHOD_COUNTRY_LOCKS,
} from "@/lib/types";
import { useCheckoutStore, useSelectedCheckoutMethod } from "@/lib/checkout-store";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { ConditionBlockRow } from "./condition-block";
import { ProcessorSplitEditor } from "./processor-split-editor";

const METHOD_DESCRIPTIONS: Record<string, string> = {
  card: "Route card payments to a processor, or split traffic across multiple processors based on conditions like customer country.",
  paypal: "Let customers pay with their PayPal balance, bank account, or linked card via PayPal's own checkout flow.",
  apple_pay: "One-tap checkout for customers on Safari/iOS using a card already stored in their Apple Wallet.",
  google_pay: "One-tap checkout for customers on Chrome/Android using a card already stored in their Google account.",
  cash_app: "US-only wallet payments via Cash App — settles in USD. Not implemented yet, so this method is permanently disabled.",
};

/**
 * Conditions panel for the currently-selected method — mirrors the
 * real client's checkout-conditions.component.tsx: a Card with the
 * method name in the title, an enable/disable Switch (green when on),
 * a one-line description, then either a simple inline note (for
 * methods without processor routing) or the reorderable condition
 * blocks + "Add condition" + catch-all merchant-split UI (for `card`,
 * this app's only CHECKOUT_METHODS_WITH_PROCESSOR_ROUTING entry).
 */
export function CheckoutConditions() {
  const method = useSelectedCheckoutMethod();
  const toggleMethodEnabled = useCheckoutStore((s) => s.toggleMethodEnabled);
  const addConditionBlock = useCheckoutStore((s) => s.addConditionBlock);
  const updateConditionBlock = useCheckoutStore((s) => s.updateConditionBlock);
  const removeConditionBlock = useCheckoutStore((s) => s.removeConditionBlock);
  const reorderConditionBlocks = useCheckoutStore((s) => s.reorderConditionBlocks);
  const updateMerchantSplit = useCheckoutStore((s) => s.updateMerchantSplit);

  if (!method) {
    return (
      <Card className="flex h-fit max-h-[80vh] min-h-[10vh] w-full max-w-[480px] flex-col gap-4 p-4 shadow-none md:max-w-none">
        <p className="text-sm text-muted-foreground">Select a method to configure its conditions.</p>
      </Card>
    );
  }

  const hasProcessorRouting = CHECKOUT_METHODS_WITH_PROCESSOR_ROUTING.includes(method.type);
  const countryLock = CHECKOUT_METHOD_COUNTRY_LOCKS[method.type];

  return (
    <Card className="flex h-fit max-h-[80vh] min-h-[10vh] w-full max-w-[480px] flex-col gap-4 overflow-y-auto p-4 shadow-none md:max-w-none">
      <p className="text-lg font-semibold">Conditions for {method.label}</p>

      <div className="flex flex-col gap-2 text-muted-foreground">
        <div className="flex w-fit items-center gap-2">
          <Switch
            id={method.id}
            checked={method.enabled}
            onCheckedChange={() => toggleMethodEnabled(method.id)}
            disabled={method.locked}
            className="data-[state=checked]:bg-green-500 dark:data-[state=checked]:bg-green-400"
          />
          <Label htmlFor={method.id}>{method.enabled ? "Enabled" : "Disabled"}</Label>
          {method.locked && (
            <span className="text-xs">
              {method.enabled ? "(always on — can’t be disabled)" : "(not available yet)"}
            </span>
          )}
        </div>

        <p className="pt-2 text-sm">{METHOD_DESCRIPTIONS[method.type]}</p>

        {countryLock && (
          <p className="text-xs">
            Requires customer country {countryLock.country} and currency {countryLock.currency} — enabling this
            method outside that scope will flag it invalid in the methods list.
          </p>
        )}
      </div>

      {!hasProcessorRouting ? (
        <p className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
          This method routes through its own connected integration — no per-condition processor split is
          available for it in this configurator.
        </p>
      ) : (
        <div className="grid gap-3">
          {method.conditionBlocks.length > 0 && (
            <Reorder.Group
              axis="y"
              values={method.conditionBlocks}
              onReorder={(reordered) => reorderConditionBlocks(method.id, reordered.map((b) => b.id))}
              className="grid gap-3"
            >
              {method.conditionBlocks.map((block, index) => (
                <Reorder.Item key={block.id} value={block}>
                  <ConditionBlockRow
                    block={block}
                    index={index}
                    onUpdate={(patch) => updateConditionBlock(method.id, block.id, patch)}
                    onDelete={() => removeConditionBlock(method.id, block.id)}
                  />
                </Reorder.Item>
              ))}
            </Reorder.Group>
          )}

          <Button type="button" variant="outline" size="sm" onClick={() => addConditionBlock(method.id)}>
            <Plus className="size-4" /> Add condition
          </Button>

          <div className="grid gap-2">
            <p className="text-sm font-medium text-muted-foreground">All other conditions</p>
            <p className="text-xs text-muted-foreground">
              The catch-all split applied when none of the conditions above match.
            </p>
            <ProcessorSplitEditor
              splits={method.merchantSplit}
              onChange={(splits) => updateMerchantSplit(method.id, splits)}
            />
          </div>
        </div>
      )}
    </Card>
  );
}
