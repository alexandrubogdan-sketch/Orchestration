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
import type { ApiKey } from "@/lib/api-keys";

export function RevokeApiKeyDialog({
  apiKey,
  onRevoke,
  onClose,
}: {
  apiKey: ApiKey;
  onRevoke: () => Promise<void>;
  onClose: () => void;
}) {
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function revoke() {
    setRevoking(true);
    try {
      await onRevoke();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRevoking(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Revoke &ldquo;{apiKey.name}&rdquo;?</DialogTitle>
          <DialogDescription>
            Every request using this key starts failing with 401 immediately. This can&apos;t be undone.
          </DialogDescription>
        </DialogHeader>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={revoking}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={revoke} disabled={revoking}>
            {revoking ? "Revoking…" : "Revoke key"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
