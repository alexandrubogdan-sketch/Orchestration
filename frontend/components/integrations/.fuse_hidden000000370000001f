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
import { PROCESSOR_CREDENTIAL_FIELDS, type Integration, type IntegrationMode } from "@/lib/types";

export function ConnectDialog({
  integration,
  onConnect,
  onClose,
}: {
  integration: Integration;
  onConnect: (mode: IntegrationMode, credentials: Record<string, string>) => void;
  onClose: () => void;
}) {
  const fields = useMemo(() => PROCESSOR_CREDENTIAL_FIELDS[integration.processor], [integration.processor]);
  const [mode, setMode] = useState<IntegrationMode>("sandbox");
  const [values, setValues] = useState<Record<string, string>>({});

  const allFilled = fields.every((field) => (values[field.key] ?? "").trim().length > 0);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect {integration.displayName}</DialogTitle>
          <DialogDescription>
            This dashboard doesn&apos;t call a real backend yet — connecting stores masked
            previews locally only. Field names match what the backend actually expects (see
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
                placeholder={field.placeholder}
              />
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!allFilled}
            onClick={() => {
              onConnect(mode, values);
              onClose();
            }}
          >
            Connect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
