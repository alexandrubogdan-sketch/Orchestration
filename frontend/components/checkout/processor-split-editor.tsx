"use client";

import { Trash2 } from "lucide-react";
import { PROCESSOR_LABELS, PROCESSORS, type CheckoutProcessorSplit, type ProcessorId } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * A small "route X% to processor Y" split editor, reused by both a
 * condition block's own routing splits and the catch-all merchant
 * split section — the real client's ConditionsMerchantSplitComponent
 * plays the same dual role there.
 */
export function ProcessorSplitEditor({
  splits,
  onChange,
  isFirstRequired = true,
}: {
  splits: CheckoutProcessorSplit[];
  onChange: (splits: CheckoutProcessorSplit[]) => void;
  /** The merchant-split section always needs at least one row (it's
   *  the catch-all); condition blocks allow removing down to zero. */
  isFirstRequired?: boolean;
}) {
  const total = splits.reduce((sum, s) => sum + s.sharePercent, 0);

  return (
    <div className="flex flex-col gap-2">
      {splits.map((split, index) => (
        <div key={split.id} className="flex items-center gap-2">
          <Select
            value={split.processor}
            onChange={(e) =>
              onChange(
                splits.map((s) => (s.id === split.id ? { ...s, processor: e.target.value as ProcessorId } : s)),
              )
            }
            className="flex-1"
          >
            {PROCESSORS.map((p) => (
              <option key={p} value={p}>
                {PROCESSOR_LABELS[p]}
              </option>
            ))}
          </Select>

          <div className="flex items-center gap-1">
            <Input
              type="number"
              min={0}
              max={100}
              value={split.sharePercent}
              onChange={(e) =>
                onChange(
                  splits.map((s) =>
                    s.id === split.id ? { ...s, sharePercent: Number.parseInt(e.target.value, 10) || 0 } : s,
                  ),
                )
              }
              className="w-20"
            />
            <span className="text-sm text-muted-foreground">%</span>
          </div>

          {(!isFirstRequired || index > 0) && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => onChange(splits.filter((s) => s.id !== split.id))}
              aria-label="Remove split"
            >
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>
      ))}

      <div className="flex items-center justify-between">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            onChange([
              ...splits,
              { id: `split_${Math.random().toString(36).slice(2, 8)}`, processor: "stripe", sharePercent: 0 },
            ])
          }
        >
          Add processor split
        </Button>

        <span className={cn("text-xs", total === 100 ? "text-muted-foreground" : "text-danger")}>
          {total}% allocated
        </span>
      </div>
    </div>
  );
}
