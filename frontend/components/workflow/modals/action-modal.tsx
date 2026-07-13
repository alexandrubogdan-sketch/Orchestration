"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  delayComponentsToSeconds,
  delaySecondsToComponents,
  PROCESSOR_LABELS,
  PROCESSORS,
  THREE_DS_LABELS,
  THREE_DS_MODES,
  WORKFLOW_ACTION_LABELS,
  type DelayComponents,
  type WorkflowAction,
} from "@/lib/types";

/**
 * Configures a single Action node — opened from the node's own
 * popover "Configure" action, matching the real client's move of
 * action config into a modal instead of inline fields on the canvas
 * card (see action-node-content.component.tsx, which likewise only
 * renders extra content for authorize/delay/set-metadata and nothing
 * for capture/decline — mirrored below by settle_payment/block_payment
 * needing no fields at all).
 */
export function ActionModal({
  action,
  onSave,
  onClose,
}: {
  action: WorkflowAction;
  onSave: (patch: Partial<WorkflowAction>) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(action);

  // Days/Hours/Minutes are all editable at once (per user feedback —
  // a single unit dropdown meant "1 day, 12 hours" needed a unit
  // switch mid-edit). Seeded once from the action's current
  // delaySeconds; every keystroke below recomputes delaySeconds from
  // whichever field changed plus the other two's last-known values.
  const [delayComponents, setDelayComponents] = useState<DelayComponents>(() =>
    delaySecondsToComponents(action.delaySeconds ?? 60),
  );

  function updateDelay(patch: Partial<DelayComponents>): void {
    const next = { ...delayComponents, ...patch };
    setDelayComponents(next);
    setDraft({ ...draft, delaySeconds: delayComponentsToSeconds(next) });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Configure — {WORKFLOW_ACTION_LABELS[action.type]}</DialogTitle>
          <DialogDescription>
            {action.type === "settle_payment" || action.type === "block_payment"
              ? "This action runs as-is — no configuration needed."
              : "Changes apply as soon as you save."}
          </DialogDescription>
        </DialogHeader>

        {action.type === "authorize_payment" ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="action-processor">Processor</Label>
              <Select
                id="action-processor"
                value={draft.processor}
                onChange={(e) => setDraft({ ...draft, processor: e.target.value as never })}
              >
                {PROCESSORS.map((p) => (
                  <option key={p} value={p}>
                    {PROCESSOR_LABELS[p]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="action-fallback">Fallback processor</Label>
              <Select
                id="action-fallback"
                value={draft.fallbackProcessor ?? "none"}
                onChange={(e) => setDraft({ ...draft, fallbackProcessor: e.target.value as never })}
              >
                <option value="none">None</option>
                {PROCESSORS.map((p) => (
                  <option key={p} value={p}>
                    {PROCESSOR_LABELS[p]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="action-3ds">3D Secure</Label>
              <Select
                id="action-3ds"
                value={draft.threeDsMode}
                onChange={(e) => setDraft({ ...draft, threeDsMode: e.target.value as never })}
              >
                {THREE_DS_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {THREE_DS_LABELS[mode]}
                  </option>
                ))}
              </Select>
            </div>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={draft.useCitProcessor ?? false}
                onChange={(e) => setDraft({ ...draft, useCitProcessor: e.target.checked })}
              />
              Use CIT processor for MITs
            </label>
          </div>
        ) : null}

        {action.type === "set_metadata" ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="action-metadata-key">Key</Label>
              <Input
                id="action-metadata-key"
                value={draft.metadataKey ?? ""}
                onChange={(e) => setDraft({ ...draft, metadataKey: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="action-metadata-value">Value</Label>
              <Input
                id="action-metadata-value"
                value={draft.metadataValue ?? ""}
                onChange={(e) => setDraft({ ...draft, metadataValue: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="action-metadata-destination">Destination</Label>
              <Select
                id="action-metadata-destination"
                value={draft.metadataDestination}
                onChange={(e) => setDraft({ ...draft, metadataDestination: e.target.value as never })}
              >
                <option value="payment">Payment</option>
                <option value="customer">Customer</option>
                <option value="both">Both</option>
              </Select>
            </div>
          </div>
        ) : null}

        {action.type === "delay" ? (
          <div className="flex flex-col gap-1.5">
            <Label>Delay</Label>
            <div className="flex gap-2">
              <div className="flex flex-1 flex-col gap-1">
                <Input
                  id="action-delay-days"
                  type="number"
                  min={0}
                  value={delayComponents.days}
                  onChange={(e) => updateDelay({ days: Number(e.target.value) })}
                />
                <Label htmlFor="action-delay-days" className="text-center text-xs font-normal text-muted-foreground">
                  Days
                </Label>
              </div>
              <div className="flex flex-1 flex-col gap-1">
                <Input
                  id="action-delay-hours"
                  type="number"
                  min={0}
                  max={23}
                  value={delayComponents.hours}
                  onChange={(e) => updateDelay({ hours: Number(e.target.value) })}
                />
                <Label htmlFor="action-delay-hours" className="text-center text-xs font-normal text-muted-foreground">
                  Hours
                </Label>
              </div>
              <div className="flex flex-1 flex-col gap-1">
                <Input
                  id="action-delay-minutes"
                  type="number"
                  min={0}
                  max={59}
                  value={delayComponents.minutes}
                  onChange={(e) => updateDelay({ minutes: Number(e.target.value) })}
                />
                <Label
                  htmlFor="action-delay-minutes"
                  className="text-center text-xs font-normal text-muted-foreground"
                >
                  Minutes
                </Label>
              </div>
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              onSave(draft);
              onClose();
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
