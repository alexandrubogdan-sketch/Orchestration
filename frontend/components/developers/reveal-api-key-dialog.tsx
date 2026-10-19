"use client";

import { KeyRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CopyToClipboardButton } from "@/components/ui/copy-to-clipboard-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ApiKey } from "@/lib/api-keys";

export function RevealApiKeyDialog({ apiKey, onClose }: { apiKey: ApiKey; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-primary" />
            Copy your key now
          </DialogTitle>
          <DialogDescription>
            This is the only time the full key for &ldquo;{apiKey.name}&rdquo; is shown. Store it in your
            secrets manager. If you lose it, revoke it and create a new one.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 rounded-lg border border-border bg-neutral-bg px-3 py-2.5">
          <code className="min-w-0 flex-1 break-all font-mono text-sm text-foreground">{apiKey.secret}</code>
          <CopyToClipboardButton text={apiKey.secret ?? ""} />
        </div>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            I&apos;ve saved it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
