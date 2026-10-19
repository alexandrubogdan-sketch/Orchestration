"use client";

import { useMemo, useState } from "react";
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
import { cn } from "@/lib/utils";
import { PROCESSOR_CREDENTIAL_FIELDS, type Integration, type IntegrationMode } from "@/lib/types";

const DESCRIPTOR_MAX_LENGTH = 22;

export function ConnectDialog({
  integration,
  isEditing = false,
  onConnect,
  onClose,
}: {
  integration: Integration;

  isEditing?: boolean;
  onConnect: (
    mode: IntegrationMode,
    credentials: Record<string, string>,
    descriptor: string,
  ) => void;
  onClose: () => void;
}) {
  const fields = useMemo(() => PROCESSOR_CREDENTIAL_FIELDS[integration.processor], [integration.processor]);
  const [mode, setMode] = useState<IntegrationMode>(integration.mode ?? "sandbox");
  const [values, setValues] = useState<Record<string, string>>({});
  const [descriptor, setDescriptor] = useState(integration.descriptors?.[0] ?? "");

  const allFilled = fields.every((field) => (values[field.key] ?? "").trim().length > 0);

  const credentialsValid = isEditing || allFilled;
  const descriptorTooLong = descriptor.trim().length > DESCRIPTOR_MAX_LENGTH;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isEditing ? "Edit" : "Connect"} {integration.displayName}
          </DialogTitle>
          <DialogDescription>
            {isEditing
              ? "Leave a credential field blank to keep its current value. Mode and statement descriptor are always updated on save."
              : "This dashboard doesn't call a real backend yet — connecting stores masked previews locally only."}{" "}
            Field names match what the backend actually expects (see
            payment-orchestrator/src/config/schema.ts and docs/adr/0011-solidgate-second-psp.md).
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="integration-mode">Mode</Label>
            <Select
              id="integration-mode"
              value={mode}
              onChange={(e) => setMode(e.target.value as IntegrationMode)}
            >
              <option value="sandbox">Sandbox</option>
              <option value="production">Production</option>
            </Select>
          </div>

          {fields.map((field) => (
            <div key={field.key} className="flex flex-col gap-1.5">
              <Label htmlFor={`integration-field-${field.key}`}>{field.label}</Label>
              <Input
                id={`integration-field-${field.key}`}
                type={field.secret ? "password" : "text"}
                value={values[field.key] ?? ""}
                onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                placeholder={
                  isEditing
                    ? `Leave blank to keep current ${field.label.toLowerCase()}`
                    : field.placeholder
                }
              />
            </div>
          ))}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="integration-descriptor">Statement descriptor</Label>
            <Input
              id="integration-descriptor"
              value={descriptor}
              onChange={(e) => setDescriptor(e.target.value)}
              placeholder="e.g. MYSHOP* ORDER 123"
            />
            <span
              className={cn(
                "text-[11px]",
                descriptorTooLong ? "text-danger" : "text-muted-foreground",
              )}
            >
              {descriptor.trim().length}/{DESCRIPTOR_MAX_LENGTH} chars — appears on the customer&apos;s
              card statement (Stripe&apos;s dynamic descriptor suffix limit). Optional.
            </span>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!credentialsValid || descriptorTooLong}
            onClick={() => {
              onConnect(mode, values, descriptor.trim());
              onClose();
            }}
          >
            {isEditing ? "Save changes" : "Connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
