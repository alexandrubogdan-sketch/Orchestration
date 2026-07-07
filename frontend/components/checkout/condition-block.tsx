"use client";

import { useState } from "react";
import { GripVertical, Pencil, Trash2 } from "lucide-react";
import {
  CHECKOUT_CONDITION_MATCH_LABELS,
  PROCESSOR_LABELS,
  type CheckoutConditionBlock,
  type CheckoutConditionMatchType,
} from "@/lib/types";
import { COUNTRIES } from "@/lib/countries";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { ProcessorSplitEditor } from "./processor-split-editor";

/**
 * One reorderable routing rule row under a card-like method's
 * conditions panel — collapsed view shows the condition summary +
 * edit/delete actions (mirroring the real client's
 * conditions-block.component.tsx), expand-in-place to edit the
 * country match + processor splits rather than opening a separate
 * modal (this app has no modal primitive equivalent to the real
 * client's CheckoutModalComponent yet, and inline editing keeps the
 * whole page usable without one).
 */
export function ConditionBlockRow({
  block,
  index,
  onUpdate,
  onDelete,
  dragHandleProps,
}: {
  block: CheckoutConditionBlock;
  index: number;
  onUpdate: (patch: Partial<Omit<CheckoutConditionBlock, "id">>) => void;
  onDelete: () => void;
  dragHandleProps?: Record<string, unknown>;
}) {
  const [isEditing, setIsEditing] = useState(false);

  const summary =
    block.countries.length > 0
      ? `Customer country ${CHECKOUT_CONDITION_MATCH_LABELS[block.countryMatchType].toLowerCase()} ${block.countries.join(", ")}`
      : "No countries selected yet";

  const splitSummary = block.splits.map((s) => `${PROCESSOR_LABELS[s.processor]} ${s.sharePercent}%`).join(" / ");

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <GripVertical
            size={18}
            {...dragHandleProps}
            className="mt-0.5 shrink-0 cursor-grab text-neutral-400 active:cursor-grabbing dark:text-neutral-500"
          />
          <div>
            <p className="text-sm font-medium">Condition {index + 1}</p>
            <p className="text-xs text-muted-foreground">{summary}</p>
            <p className="text-xs text-muted-foreground">{splitSummary || "No processor split configured"}</p>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="icon" onClick={() => setIsEditing((v) => !v)} aria-label="Edit condition">
            <Pencil className="size-4" />
          </Button>
          <Button type="button" variant="ghost" size="icon" onClick={onDelete} aria-label="Delete condition">
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      {isEditing && (
        <div className="flex flex-col gap-3 border-t border-border pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={block.countryMatchType}
              onChange={(e) => onUpdate({ countryMatchType: e.target.value as CheckoutConditionMatchType })}
              className="w-40"
            >
              {Object.entries(CHECKOUT_CONDITION_MATCH_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>

            <select
              multiple
              value={block.countries}
              onChange={(e) =>
                onUpdate({ countries: Array.from(e.target.selectedOptions, (opt) => opt.value) })
              }
              className="h-24 min-w-[180px] flex-1 rounded-lg border border-border bg-surface px-2 py-1 text-sm outline-none focus:border-accent focus:ring-1 focus:ring-accent"
            >
              {COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <ProcessorSplitEditor splits={block.splits} onChange={(splits) => onUpdate({ splits })} isFirstRequired={false} />
        </div>
      )}
    </div>
  );
}
