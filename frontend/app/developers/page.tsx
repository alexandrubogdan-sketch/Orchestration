"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BookOpen, KeyRound, Plus } from "lucide-react";

import { Topbar } from "@/components/layout/topbar";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { CopyToClipboardButton } from "@/components/ui/copy-to-clipboard-button";
import { CodeBlock } from "@/components/docs/code-block";
import { AccessSummary } from "@/components/developers/access-summary";
import { CreateApiKeyDialog } from "@/components/developers/create-api-key-dialog";
import { RevealApiKeyDialog } from "@/components/developers/reveal-api-key-dialog";
import { RevokeApiKeyDialog } from "@/components/developers/revoke-api-key-dialog";
import { useEnvironmentStore } from "@/lib/environment-store";
import { useSandboxKeys, type ApiKey } from "@/lib/api-keys";
import { problemMessage } from "@/lib/live-api";
import { formatDate, relativeTime } from "@/lib/utils";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/+$/, "") ?? null;

async function liveRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(problemMessage(text) || `Request failed with status ${response.status}`);
  return JSON.parse(text) as T;
}

export default function DevelopersPage() {
  const environment = useEnvironmentStore((s) => s.environment);
  const sandbox = useSandboxKeys();
  const [liveKeys, setLiveKeys] = useState<ApiKey[] | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [revealing, setRevealing] = useState<ApiKey | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);

  const isLive = environment === "live";

  const seedSandbox = sandbox.seed;

  useEffect(() => {
    if (!isLive) {
      seedSandbox();
      return;
    }
    let cancelled = false;
    liveRequest<{ data: ApiKey[] }>("/api/api-keys")
      .then((body) => {
        if (cancelled) return;
        setLiveError(null);
        setLiveKeys(body.data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLiveKeys([]);
        setLiveError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [isLive, seedSandbox]);

  const keys = (isLive ? liveKeys : sandbox.keys) ?? null;
  const activeKeys = keys?.filter((k) => !k.revokedAt) ?? [];
  const revokedKeys = keys?.filter((k) => k.revokedAt) ?? [];
  const visibleKeys = showRevoked ? [...activeKeys, ...revokedKeys] : activeKeys;

  async function createKey(name: string, scopes: string[]) {
    const created = isLive
      ? await liveRequest<ApiKey>("/api/api-keys", { method: "POST", body: JSON.stringify({ name, scopes }) })
      : sandbox.create(name, scopes);
    if (isLive) setLiveKeys((prev) => [created, ...(prev ?? [])]);
    setCreating(false);
    setRevealing(created);
  }

  async function revokeKey(key: ApiKey) {
    if (isLive) {
      const revoked = await liveRequest<ApiKey>(`/api/api-keys/${encodeURIComponent(key.id)}`, { method: "DELETE" });
      setLiveKeys((prev) => (prev ?? []).map((k) => (k.id === key.id ? revoked : k)));
    } else {
      sandbox.revoke(key.id);
    }
    setRevoking(null);
  }

  return (
    <>
      <Topbar title="Developers" description="API keys, base URLs and everything you need to call the API." />

      <div className="flex flex-col gap-6 p-8">
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div>
              <CardTitle>API keys</CardTitle>
              <CardDescription>
                Secret keys authenticate your servers. Each key only gets the access you give it.{" "}
                {isLive ? null : "Sandbox keys exist only in this browser session."}
              </CardDescription>
            </div>
            <Button onClick={() => setCreating(true)} disabled={isLive && liveError !== null && liveKeys?.length === 0}>
              <Plus />
              Create key
            </Button>
          </CardHeader>
          <CardContent>
            {liveError ? (
              <div className="mb-4 rounded-lg border border-danger/30 bg-danger-bg px-4 py-3 text-sm text-danger">
                {liveError}
              </div>
            ) : null}

            {keys === null ? (
              <p className="py-10 text-center text-sm text-muted-foreground">Loading keys…</p>
            ) : activeKeys.length === 0 && !liveError ? (
              <div className="flex flex-col items-center gap-3 py-12 text-center">
                <KeyRound className="h-6 w-6 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">No active keys. Create one to start calling the API.</p>
                <Button variant="outline" onClick={() => setCreating(true)}>
                  <Plus />
                  Create key
                </Button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <THead>
                    <TR>
                      <TH>Name</TH>
                      <TH>Key</TH>
                      <TH>Access</TH>
                      <TH>Created</TH>
                      <TH>Last used</TH>
                      <TH className="text-right">
                        <span className="sr-only">Actions</span>
                      </TH>
                    </TR>
                  </THead>
                  <TBody>
                    {visibleKeys.map((key) => (
                      <TR key={key.id} className={key.revokedAt ? "opacity-60" : undefined}>
                        <TD className="font-medium text-foreground">{key.name}</TD>
                        <TD>
                          <code className="font-mono text-xs text-muted-foreground">
                            {key.prefix ? `${key.prefix}••••••••` : "Legacy key"}
                          </code>
                        </TD>
                        <TD>
                          <AccessSummary scopes={key.scopes} />
                        </TD>
                        <TD className="whitespace-nowrap text-muted-foreground">{formatDate(key.createdAt)}</TD>
                        <TD className="whitespace-nowrap text-muted-foreground">
                          {key.lastUsedAt ? relativeTime(key.lastUsedAt) : "Never"}
                        </TD>
                        <TD className="text-right">
                          {key.revokedAt ? (
                            <Badge tone="neutral">Revoked</Badge>
                          ) : (
                            <Button variant="ghost" size="sm" className="text-danger" onClick={() => setRevoking(key)}>
                              Revoke
                            </Button>
                          )}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            )}

            {revokedKeys.length > 0 ? (
              <button
                type="button"
                onClick={() => setShowRevoked((v) => !v)}
                className="mt-3 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                {showRevoked ? "Hide" : "Show"} {revokedKeys.length} revoked {revokedKeys.length === 1 ? "key" : "keys"}
              </button>
            ) : null}
          </CardContent>
        </Card>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Base URL</CardTitle>
              <CardDescription>Every endpoint lives under this URL. Sandbox and live keys share it.</CardDescription>
            </CardHeader>
            <CardContent>
              {API_BASE_URL ? (
                <div className="flex items-center gap-3 rounded-lg border border-border px-3 py-2">
                  <code className="min-w-0 flex-1 truncate font-mono text-sm text-foreground">{API_BASE_URL}/v1</code>
                  <CopyToClipboardButton text={`${API_BASE_URL}/v1`} />
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Set <code className="font-mono text-foreground">NEXT_PUBLIC_API_BASE_URL</code> on this dashboard to
                  the deployed backend&apos;s address to show it here.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-4">
              <div>
                <CardTitle>Make your first call</CardTitle>
                <CardDescription>Lists your most recent payments.</CardDescription>
              </div>
              <Button asChild variant="outline" size="sm">
                <Link href="/docs/api">
                  <BookOpen />
                  API reference
                </Link>
              </Button>
            </CardHeader>
            <CardContent>
              <CodeBlock label="cURL">{`curl "${API_BASE_URL ?? "$ALPHA_API_URL"}/v1/payments?limit=5" \\
  -H "Authorization: Bearer $ALPHA_API_KEY"`}</CodeBlock>
            </CardContent>
          </Card>
        </div>
      </div>

      {creating ? <CreateApiKeyDialog onCreate={createKey} onClose={() => setCreating(false)} /> : null}
      {revealing ? <RevealApiKeyDialog apiKey={revealing} onClose={() => setRevealing(null)} /> : null}
      {revoking ? (
        <RevokeApiKeyDialog apiKey={revoking} onRevoke={() => revokeKey(revoking)} onClose={() => setRevoking(null)} />
      ) : null}
    </>
  );
}
