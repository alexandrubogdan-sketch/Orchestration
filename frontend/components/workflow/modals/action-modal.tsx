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
  PROCESSOR_LABELS,
  PROCESSORS,
  THREE_DS_LABELS,
  THREE_DS_MODES,
  WORKFLOW_ACTION_LABELS,
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
            <Label htmlFor="action-delay">Delay (seconds)</Label>
            <Input
              id="action-delay"
              type="number"
              min={0}
              value={draft.delaySeconds ?? 0}
              onChange={(e) => setDraft({ ...draft, delaySeconds: Number(e.target.value) })}
            />
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
