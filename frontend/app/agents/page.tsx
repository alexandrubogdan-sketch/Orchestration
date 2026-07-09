"use client";

import { useEffect, useState } from "react";
import { Bot, KeyRound, Plus, Trash2 } from "lucide-react";

import { Topbar } from "@/components/layout/topbar";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { CodeBlock } from "@/components/docs/code-block";
import { Callout } from "@/components/docs/callout";
import { CreateAgentTokenDialog } from "@/components/agents/create-agent-token-dialog";
import { RevealAgentTokenDialog } from "@/components/agents/reveal-agent-token-dialog";
import type { AgentToken } from "@/lib/agent-tokens";
import { formatDate, relativeTime } from "@/lib/utils";

const SCOPE_BADGE_TONE: Record<AgentToken["scope"], BadgeTone> = {
  read_write: "accent",
  read_only: "info",
};

const SCOPE_LABEL: Record<AgentToken["scope"], string> = {
  read_write: "Read/write",
  read_only: "Read only",
};

export default function AgentsPage() {
  const [tokens, setTokens] = useState<AgentToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [revealing, setRevealing] = useState<AgentToken | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  // Lazy initializer (not an effect) so this is correct from the very
  // first client render with no extra setState-after-mount round trip —
  // on the server it falls back to a placeholder that's never actually
  // shown to a user (this whole page is a "use client" component).
  const [mcpUrl] = useState(() =>
    typeof window !== "undefined" ? `${window.location.origin}/api/mcp` : "/api/mcp",
  );

  useEffect(() => {
    let cancelled = false;

    // Deliberately no synchronous setLoading(true)/setBackendError(null)
    // here — the initial useState values above already are (true, null),
    // and this effect only ever runs once (empty deps), matching
    // app/payments/page.tsx's own established convention for the same
    // lint rule (react-hooks/set-state-in-effect).
    fetch("/api/agent-tokens")
      .then(async (res) => {
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setBackendError(body.detail || body.title || `Request failed (${res.status})`);
          setTokens([]);
          return;
        }
        setTokens(body as AgentToken[]);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setBackendError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function revokeToken(id: string) {
    setRevokingId(id);
    try {
      const res = await fetch(`/api/agent-tokens/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (res.ok || res.status === 204) {
        setTokens((prev) => prev.filter((t) => t.id !== id));
      }
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <>
      <Topbar
        title="AI Agents"
        description="Connect Alpha Payments to Claude or any other MCP client, and issue the tokens that scope what it can do"
      />
      <div className="flex-1 overflow-y-auto p-8">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base text-foreground">
                <Bot className="h-4 w-4" /> Model Context Protocol server
              </CardTitle>
              <CardDescription>
                Alpha Payments exposes a live MCP server so an AI agent can research payments,
                customers, and subscriptions, and — with a read/write token — capture, void, refund a
                payment or cancel a subscription on your behalf. Every action still runs through the
                exact same authorization and idempotency rules as this dashboard.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CodeBlock label="MCP endpoint (Streamable HTTP)">{mcpUrl}</CodeBlock>
              <p className="mt-3 text-sm text-muted-foreground">
                Create an agent token below, then add it to your MCP client&apos;s config as a Bearer
                header — see{" "}
                <a href="/docs/ai-agents" className="text-accent underline">
                  the AI Agents docs page
                </a>{" "}
                for the full setup guide and the complete tool list.
              </p>
            </CardContent>
          </Card>

          {backendError ? (
            <Callout tone="warning" title="Could not load agent tokens">
              {backendError}
            </Callout>
          ) : null}

          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle className="text-base text-foreground">Agent tokens</CardTitle>
                <CardDescription>Bearer tokens scoped to this product, for MCP clients only.</CardDescription>
              </div>
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus className="h-3.5 w-3.5" /> New agent token
              </Button>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <THead>
                  <TR>
                    <TH>Description</TH>
                    <TH>Scope</TH>
                    <TH>Created</TH>
                    <TH>Last used</TH>
                    <TH></TH>
                  </TR>
                </THead>
                <TBody>
                  {tokens.map((token) => (
                    <TR key={token.id}>
                      <TD>
                        <div className="flex items-center gap-2.5">
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-bg text-muted-foreground">
                            <KeyRound className="h-4 w-4" />
                          </div>
                          <span className="font-medium">{token.description}</span>
                        </div>
                      </TD>
                      <TD>
                        <Badge tone={SCOPE_BADGE_TONE[token.scope]}>{SCOPE_LABEL[token.scope]}</Badge>
                      </TD>
                      <TD className="text-sm text-muted-foreground">{formatDate(token.createdAt)}</TD>
                      <TD className="text-sm text-muted-foreground">
                        {token.lastUsedAt ? relativeTime(token.lastUsedAt) : "Never"}
                      </TD>
                      <TD>
                        <button
                          onClick={() => revokeToken(token.id)}
                          disabled={revokingId === token.id}
                          title="Revoke token"
                          className="text-muted-foreground transition-colors hover:text-danger disabled:opacity-50"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
              {!loading && tokens.length === 0 && !backendError ? (
                <div className="p-8 text-center text-sm text-muted-foreground">
                  No agent tokens yet — create one to connect an MCP client.
                </div>
              ) : null}
              {loading ? (
                <div className="p-8 text-center text-sm text-muted-foreground">Loading…</div>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>

      {creating ? (
        <CreateAgentTokenDialog
          onCreated={(token) => {
            setCreating(false);
            setTokens((prev) => [{ ...token, token: undefined }, ...prev]);
            setRevealing(token);
          }}
          onClose={() => setCreating(false)}
        />
      ) : null}

      {revealing ? (
        <RevealAgentTokenDialog token={revealing} mcpUrl={mcpUrl} onClose={() => setRevealing(null)} />
      ) : null}
    </>
  );
}
