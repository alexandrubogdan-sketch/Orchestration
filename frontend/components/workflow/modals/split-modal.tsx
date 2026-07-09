"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { WorkflowSplitBranch } from "@/lib/types";

function randomId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Manages a Split node's branches — add/rename/remove/reweight. The
 * real client edits Split branches through a modal too (EModalType.
 * SPLIT) rather than inline on the canvas card, which only ever
 * displays each branch's label + percentage + progress bar
 * (split-node-content.component.tsx).
 */
export function SplitModal({
  branches,
  onSave,
  onClose,
}: {
  branches: WorkflowSplitBranch[];
  onSave: (branches: WorkflowSplitBranch[]) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<WorkflowSplitBranch[]>(branches);

  const total = draft.reduce((sum, b) => sum + (Number.isFinite(b.value) ? b.value : 0), 0);
  const isBalanced = total === 100;

  function updateBranch(id: string, patch: Partial<WorkflowSplitBranch>) {
    setDraft((prev) => prev.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  }

  function addBranch() {
    setDraft((prev) => [...prev, { id: randomId("branch"), label: `Branch ${prev.length + 1}`, value: 0 }]);
  }

  function removeBranch(id: string) {
    setDraft((prev) => prev.filter((b) => b.id !== id));
  }

  function rebalanceEvenly() {
    setDraft((prev) => {
      const evenShare = Math.floor(100 / prev.length);
      const remainder = 100 - evenShare * prev.length;
      return prev.map((b, i) => ({ ...b, value: i === prev.length - 1 ? evenShare + remainder : evenShare }));
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Configure split</DialogTitle>
          <DialogDescription>Branch percentages must add up to 100%.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          {draft.map((branch) => (
            <div key={branch.id} className="flex items-end gap-2">
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor={`branch-label-${branch.id}`}>Label</Label>
                <Input
                  id={`branch-label-${branch.id}`}
                  value={branch.label}
                  onChange={(e) => updateBranch(branch.id, { label: e.target.value })}
                />
              </div>
              <div className="flex w-24 flex-col gap-1.5">
                <Label htmlFor={`branch-value-${branch.id}`}>Percent</Label>
                <Input
                  id={`branch-value-${branch.id}`}
                  type="number"
                  min={0}
                  max={100}
                  value={branch.value}
                  onChange={(e) => updateBranch(branch.id, { value: Number(e.target.value) })}
                />
              </div>
              <Button
                type="button"
                variant="outline"
                size="icon"
                disabled={draft.length <= 2}
                onClick={() => removeBranch(branch.id)}
                title="Remove branch"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}

          <div className="flex items-center justify-between pt-1">
            <Button type="button" variant="outline" size="sm" onClick={addBranch}>
              <Plus className="h-3.5 w-3.5" /> Add branch
            </Button>
            <div className="flex items-center gap-2">
              <span className={cn("text-xs font-medium", isBalanced ? "text-success" : "text-danger")}>
                Total: {total}%
              </span>
              <Button type="button" variant="ghost" size="sm" onClick={rebalanceEvenly}>
                Rebalance evenly
              </Button>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!isBalanced || draft.length < 2}
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
