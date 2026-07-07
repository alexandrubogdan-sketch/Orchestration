"use client";

import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRetrySettingsStore } from "@/lib/retry-settings-store";

/**
 * The dunning ladder as an editable ordered list of "wait N hours, then
 * retry" steps — add/remove/reorder, matching the Plans price-rows
 * editor's own row-editing UX (components/plans/plan-form.tsx: one row
 * per entry, an Input per editable field, a trailing Trash2 remove
 * button, an "Add X" button below the list with the same Plus-icon +
 * outline-button styling) rather than inventing a new list-editing
 * pattern for this one page.
 *
 * Reordering has no equivalent in the Plans price-rows editor (price
 * rows are unordered — order doesn't matter there), so the up/down
 * arrow buttons are new here, but ARE the same interaction the
 * workflow canvas's own node chain relies on implicitly (nodes[1..] run
 * in array order) — surfaced explicitly here since a dunning ladder's
 * order is the entire point of the feature (24h then 72h then 168h is
 * a materially different policy than 168h then 72h then 24h).
 */
export function DunningLadderEditor() {
  const ladder = useRetrySettingsStore((s) => s.policy.ladder);
  const addLadderStep = useRetrySettingsStore((s) => s.addLadderStep);
  const updateLadderStep = useRetrySettingsStore((s) => s.updateLadderStep);
  const removeLadderStep = useRetrySettingsStore((s) => s.removeLadderStep);
  const moveLadderStep = useRetrySettingsStore((s) => s.moveLadderStep);

  return (
    <div className="flex flex-col gap-2">
      {ladder.map((step, index) => (
        <div key={step.id} className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-xs font-medium text-muted-foreground">
            Step {index + 1}
          </span>
          <span className="text-xs text-muted-foreground">Wait</span>
          <Input
            type="number"
            min={0}
            value={step.waitHours}
            onChange={(e) => updateLadderStep(step.id, Number.parseInt(e.target.value, 10) || 0)}
            className="w-24"
            aria-label={`Step ${index + 1} wait hours`}
          />
          <span className="text-xs text-muted-foreground">hours, then retry</span>

          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => moveLadderStep(step.id, "up")}
              disabled={index === 0}
              className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
              title="Move step earlier"
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => moveLadderStep(step.id, "down")}
              disabled={index === ladder.length - 1}
              className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
              title="Move step later"
            >
              <ArrowDown className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => removeLadderStep(step.id)}
              disabled={ladder.length <= 1}
              className="rounded p-1 text-muted-foreground transition-colors hover:text-danger disabled:pointer-events-none disabled:opacity-30"
              title="Remove step"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ))}

      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={addLadderStep}
        disabled={ladder.length >= 10}
        className="self-start"
      >
        <Plus className="h-3.5 w-3.5" /> Add step
      </Button>
      {ladder.length >= 10 ? (
        <span className="text-xs text-muted-foreground">Maximum of 10 steps.</span>
      ) : null}
    </div>
  );
}
