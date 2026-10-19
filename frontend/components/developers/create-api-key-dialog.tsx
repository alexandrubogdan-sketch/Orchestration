"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  API_RESOURCES,
  scopesForPreset,
  type Access,
  type AccessMatrix,
  type AccessPreset,
} from "@/lib/api-keys";
import { cn } from "@/lib/utils";

const PRESETS: { id: AccessPreset; title: string; description: string }[] = [
  { id: "full", title: "Full access", description: "Everything, including creating other keys. Use for your main server." },
  { id: "read_only", title: "Read only", description: "Can list and look up data, can never move money." },
  { id: "custom", title: "Custom", description: "Pick read or write access per resource." },
];

const ACCESS_OPTIONS: Access[] = ["none", "read", "write"];
const ACCESS_LABEL: Record<Access, string> = { none: "None", read: "Read", write: "Write" };

export function CreateApiKeyDialog({
  onCreate,
  onClose,
}: {
  onCreate: (name: string, scopes: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [preset, setPreset] = useState<AccessPreset>("full");
  const [matrix, setMatrix] = useState<AccessMatrix>({ payments: "read", customers: "read", api_keys: "none" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scopes = scopesForPreset(preset, matrix);
  const canSubmit = name.trim().length > 0 && scopes.length > 0 && !submitting;

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await onCreate(name.trim(), scopes);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create API key</DialogTitle>
          <DialogDescription>Give the key only the access the system using it needs.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="api-key-name">Name</Label>
            <Input
              id="api-key-name"
              autoFocus
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Checkout backend"
            />
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-sm font-medium text-foreground">Access</legend>
            {PRESETS.map((option) => (
              <label
                key={option.id}
                className={cn(
                  "flex cursor-pointer gap-3 rounded-lg border px-3 py-2.5 transition-colors",
                  preset === option.id ? "border-primary bg-accent/40" : "border-border hover:bg-neutral-bg",
                )}
              >
                <input
                  type="radio"
                  name="api-key-access"
                  className="mt-1 accent-[var(--primary)]"
                  checked={preset === option.id}
                  onChange={() => setPreset(option.id)}
                />
                <span>
                  <span className="block text-sm font-medium text-foreground">{option.title}</span>
                  <span className="block text-xs text-muted-foreground">{option.description}</span>
                </span>
              </label>
            ))}
          </fieldset>

          {preset === "custom" ? (
            <div className="divide-y divide-border rounded-lg border border-border">
              {API_RESOURCES.map((resource) => (
                <div key={resource.id} className="flex items-center justify-between gap-4 px-3 py-2.5">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground">{resource.label}</div>
                    <div className="truncate text-xs text-muted-foreground">{resource.description}</div>
                  </div>
                  <div role="radiogroup" aria-label={`${resource.label} access`} className="flex shrink-0 rounded-md border border-border p-0.5">
                    {ACCESS_OPTIONS.map((access) => (
                      <button
                        key={access}
                        type="button"
                        role="radio"
                        aria-checked={matrix[resource.id] === access}
                        onClick={() => setMatrix((m) => ({ ...m, [resource.id]: access }))}
                        className={cn(
                          "rounded px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                          matrix[resource.id] === access
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {ACCESS_LABEL[access]}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {preset === "custom" && scopes.length === 0 ? (
            <p className="text-xs text-warning">Give the key access to at least one resource.</p>
          ) : null}
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={!canSubmit}>
            {submitting ? "Creating…" : "Create key"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
