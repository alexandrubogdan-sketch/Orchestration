"use client";

import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRetrySettingsStore } from "@/lib/retry-settings-store";

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
