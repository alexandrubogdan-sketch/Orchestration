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
import { Input, Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AgentToken } from "@/lib/agent-tokens";

/** Create dialog for a new MCP agent token — description + scope only;
 *  product/merchant scoping comes from the server-side proxy's own
 *  master token (see app/api/agent-tokens/route.ts), never from this
 *  form, so a caller can't request a token for someone else's product. */
export function CreateAgentTokenDialog({
  onCreated,
  onClose,
}: {
  onCreated: (token: AgentToken) => void;
  onClose: () => void;
}) {
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState<"read_only" | "read_write">("read_write");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/agent-tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description: description.trim() || undefined, scope }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.detail || body.title || `Request failed (${res.status})`);
        return;
      }
      onCreated(body as AgentToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New agent token</DialogTitle>
          <DialogDescription>
            Issues a fresh Bearer token an MCP client (Claude, or any other MCP-speaking agent) can
            use to call this merchant&apos;s payments data through the MCP server. The raw value is
            shown once, immediately after creation — it cannot be recovered afterward.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="agent-token-description">Description</Label>
            <Input
              id="agent-token-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Support team refund/cancel agent"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="agent-token-scope">Scope</Label>
            <Select id="agent-token-scope" value={scope} onChange={(e) => setScope(e.target.value as "read_only" | "read_write")}>
              <option value="read_write">Read/write — can capture, void, refund, and cancel</option>
              <option value="read_only">Read only — can list/inspect, cannot take action</option>
            </Select>
            <span className="text-[11px] text-muted-foreground">
              A read_only token gets a clear 403 from every mutating tool (refund_payment,
              cancel_subscription, capture_payment, void_payment) — pick this for an agent that should
              only research, never act.
            </span>
          </div>

          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="button" onClick={handleCreate} disabled={submitting}>
            {submitting ? "Creating…" : "Create token"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
