"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Small inline copy-to-clipboard icon button — mirrors the id-display
 * pattern used for resource ids in tables (id shown truncated/muted, with
 * a copy affordance that appears on row hover). Falls back silently if
 * `navigator.clipboard` is unavailable (e.g. non-HTTPS/local dev edge
 * cases); this is a demo-data page, so there's no toast/analytics wiring.
 */
export function CopyToClipboardButton({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard API unavailable — no-op.
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={copied ? "Copied!" : "Copy to clipboard"}
      aria-label="Copy to clipboard"
      className={cn(
        "inline-flex h-4 w-4 items-center justify-center text-muted-foreground transition-colors hover:text-foreground",
        className,
      )}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}
