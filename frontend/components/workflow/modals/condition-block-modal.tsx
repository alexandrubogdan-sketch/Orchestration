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
  WORKFLOW_CONDITION_LABELS,
  WORKFLOW_CONDITION_PARAMETERS,
  WORKFLOW_OPERATORS,
  type WorkflowConditionBlock,
} from "@/lib/types";

/**
 * Edits a single Condition block — opened from that block's own
 * popover "Edit" action (see nodes.tsx's ConditionBlockCard), matching
 * the real client's move of condition config into a modal
 * (EModalType.CONDITION) instead of inline fields on the canvas card.
 */
export function ConditionBlockModal({
  block,
  onSave,
  onClose,
}: {
  block: WorkflowConditionBlock;
  onSave: (patch: { title: string; condition: WorkflowConditionBlock["condition"] }) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(block.title);
  const [condition, setCondition] = useState(block.condition);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit condition</DialogTitle>
          <DialogDescription>
            This block routes payments matching it down its own branch — give it a name so the
            canvas card stays readable once there are a few of these side by side.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="condition-title">Block title</Label>
            <Input id="condition-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="condition-parameter">Parameter</Label>
            <Select
              id="condition-parameter"
              value={condition.parameter}
              onChange={(e) => setCondition({ ...condition, parameter: e.target.value as never })}
            >
              {WORKFLOW_CONDITION_PARAMETERS.map((p) => (
                <option key={p} value={p}>
                  {WORKFLOW_CONDITION_LABELS[p]}
                </option>
              ))}
            </Select>
          </div>

          {condition.parameter === "metadata" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="condition-metadata-key">Metadata key (dot notation)</Label>
              <Input
                id="condition-metadata-key"
                value={condition.metadataKey ?? ""}
                placeholder="workflow.experiment_variant"
                onChange={(e) => setCondition({ ...condition, metadataKey: e.target.value })}
              />
            </div>
          ) : null}

          <div className="flex items-center gap-2">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="condition-operator">Operator</Label>
              <Select
                id="condition-operator"
                value={condition.operator}
                onChange={(e) => setCondition({ ...condition, operator: e.target.value as never })}
              >
                {WORKFLOW_OPERATORS.map((op) => (
                  <option key={op} value={op}>
                    {op.replace(/_/g, " ")}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-[1.5] flex-col gap-1.5">
              <Label htmlFor="condition-value">Value</Label>
              <Input
                id="condition-value"
                value={condition.value}
                placeholder="e.g. US or USD"
                onChange={(e) => setCondition({ ...condition, value: e.target.value })}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              onSave({ title, condition });
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
