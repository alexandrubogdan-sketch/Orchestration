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

/** Stripe's documented limit for a dynamic statement-descriptor *suffix*
 *  (appended to the account's static Dashboard-configured prefix) — see
 *  lib/types.ts's Integration.descriptors doc comment and the matching
 *  DB-level CHECK constraint in payment-orchestrator-go/db/migrations/
 *  1735777500000_psp-account-statement-descriptor.up.sql. */
const DESCRIPTOR_MAX_LENGTH = 22;

/**
 * Connect *and* Edit dialog for a processor integration. The same form
 * backs both flows (`isEditing` just flips copy/validation) so the mode
 * and statement-descriptor fields live in exactly one place rather than
 * being duplicated across a separate edit dialog.
 *
 * Edit mode intentionally leaves blank credential fields alone instead of
 * requiring every secret to be retyped — see lib/integration-store.ts's
 * `updateIntegration`/`buildCredentialPreviews`, which merge a blank input
 * with the existing masked preview rather than clearing it. Only the mode
 * and descriptor are always applied on save, which is the whole point of
 * Edit existing (as opposed to Disconnect + Connect again).
 */
export function ConnectDialog({
  integration,
  isEditing = false,
  onConnect,
  onClose,
}: {
  integration: Integration;
  /** True when opened from the Integrations page's "Edit" action on an
   *  already-connected integration, rather than "Connect". */
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
  // Connecting for the first time still requires every credential field;
  // editing doesn't, since a blank field means "keep the current value."
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
