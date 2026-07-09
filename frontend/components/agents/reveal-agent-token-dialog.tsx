"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/docs/code-block";
import { Callout } from "@/components/docs/callout";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AgentToken } from "@/lib/agent-tokens";

/** Shown exactly once, immediately after POST /api/agent-tokens
 *  succeeds — token.token (the raw secret) is never returned by any
 *  other call, so this is the only chance to see/copy it. Also doubles
 *  as the setup guide: the exact JSON block Claude Desktop (or any
 *  other Streamable-HTTP-speaking MCP client) needs to connect. */
export function RevealAgentTokenDialog({ token, mcpUrl, onClose }: { token: AgentToken; mcpUrl: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  const configSnippet = JSON.stringify(
    {
      mcpServers: {
        "alpha-payments": {
          url: mcpUrl,
          headers: {
            Authorization: `Bearer ${token.token}`,
          },
        },
      },
    },
    null,
    2,
  );

  async function copyToken() {
    if (!token.token) return;
    await navigator.clipboard.writeText(token.token);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Agent token created</DialogTitle>
          <DialogDescription>
            Copy this now — Alpha Payments only stores its SHA-256 hash, so this is the only time
            the raw value is shown.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded-lg border border-border bg-neutral-bg px-3 py-2 text-xs">
              {token.token}
            </code>
            <Button type="button" variant="outline" size="icon" onClick={copyToken} title="Copy token">
              {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>

          <div>
            <div className="mb-1.5 text-sm font-medium">Connect Claude (or another MCP client)</div>
            <CodeBlock label="claude_desktop_config.json (or your MCP client's equivalent)">
              {configSnippet}
            </CodeBlock>
          </div>

          <Callout tone="info" title="Streamable HTTP">
            The endpoint speaks MCP&apos;s Streamable HTTP transport at{" "}
            <code className="rounded bg-neutral-bg px-1 py-0.5">{mcpUrl}</code>. If your client only
            supports stdio, bridge it with{" "}
            <code className="rounded bg-neutral-bg px-1 py-0.5">
              npx mcp-remote {mcpUrl} --header &quot;Authorization:Bearer {token.token}&quot;
            </code>
            .
          </Callout>
        </div>

        <DialogFooter>
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
