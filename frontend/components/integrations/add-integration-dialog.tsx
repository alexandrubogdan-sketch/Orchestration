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
import { PROCESSOR_LABELS, PROCESSORS, type ProcessorId } from "@/lib/types";

/** Suggests "Stripe", then "Stripe 2", "Stripe 3", ... for each additional
 *  instance of the same processor — merchants commonly run several Stripe
 *  accounts (one per entity/region), so instances need a name to tell them
 *  apart in the Workflow builder's processor pickers. */
function suggestDisplayName(processor: ProcessorId, existingNames: string[]): string {
  const base = PROCESSOR_LABELS[processor];
  if (!existingNames.includes(base)) return base;
  let n = 2;
  while (existingNames.includes(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

export function AddIntegrationDialog({
  existingDisplayNames,
  onAdd,
  onClose,
}: {
  existingDisplayNames: string[];
  onAdd: (processor: ProcessorId, displayName: string) => void;
  onClose: () => void;
}) {
  const [processor, setProcessor] = useState<ProcessorId>(PROCESSORS[0]);
  const [displayName, setDisplayName] = useState(() =>
    suggestDisplayName(PROCESSORS[0], existingDisplayNames),
  );
  const [nameTouched, setNameTouched] = useState(false);

  function handleProcessorChange(next: ProcessorId) {
    setProcessor(next);
    if (!nameTouched) {
      setDisplayName(suggestDisplayName(next, existingDisplayNames));
    }
  }

  const trimmedName = displayName.trim();

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add integration</DialogTitle>
          <DialogDescription>
            You can add more than one instance of the same processor — e.g. separate Stripe
            accounts per merchant entity or region. You&apos;ll connect real credentials next.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="add-integration-processor">Processor</Label>
            <Select
              id="add-integration-processor"
              value={processor}
              onChange={(e) => handleProcessorChange(e.target.value as ProcessorId)}
            >
              {PROCESSORS.map((p) => (
                <option key={p} value={p}>
                  {PROCESSOR_LABELS[p]}
                </option>
              ))}
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="add-integration-name">Display name</Label>
            <Input
              id="add-integration-name"
              value={displayName}
              onChange={(e) => {
                setNameTouched(true);
                setDisplayName(e.target.value);
              }}
              placeholder="e.g. Stripe — EU entity"
            />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={trimmedName.length === 0}
            onClick={() => {
              onAdd(processor, trimmedName);
              onClose();
            }}
          >
            Add integration
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
