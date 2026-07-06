"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Integration } from "@/lib/types";

export function ConnectDialog({
  integration,
  onConnect,
  onClose,
}: {
  integration: Integration;
  onConnect: (apiKey: string) => void;
  onClose: () => void;
}) {
  const [apiKey, setApiKey] = useState("");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-8">
      <div className="w-full max-w-md rounded-xl bg-surface shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold">Connect {integration.displayName}</h2>
          <button onClick={onClose} className="text-muted hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-col gap-3 p-5">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Secret API key</span>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={integration.processor === "stripe" ? "sk_live_..." : "api_sk_..."}
            />
          </label>
          <p className="text-xs text-muted">
            This dashboard doesn&apos;t call a real backend yet — connecting stores a masked key
            preview locally only. See the frontend README for what a real Dashboard →
            Integrations flow needs.
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button size="sm" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={apiKey.trim().length === 0}
            onClick={() => {
              onConnect(apiKey);
              onClose();
            }}
          >
            Connect
          </Button>
        </div>
      </div>
    </div>
  );
}
