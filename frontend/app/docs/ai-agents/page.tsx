import { DocsHeader } from "@/components/docs/docs-header";
import { Callout } from "@/components/docs/callout";
import { CodeBlock } from "@/components/docs/code-block";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";

const TOOLS: Array<{ name: string; scope: "read_only" | "read_write"; description: string }> = [
  { name: "list_payments", scope: "read_only", description: "List payments, optionally filtered by customer, state, or a creation-date range." },
  { name: "get_payment", scope: "read_only", description: "Full detail on one payment: attempt history and event timeline." },
  { name: "capture_payment", scope: "read_write", description: "Capture a previously authorized (manual capture) payment." },
  { name: "void_payment", scope: "read_write", description: "Void a payment that has not yet been captured/settled." },
  { name: "refund_payment", scope: "read_write", description: "Refund a settled payment, in full or in part." },
  { name: "list_customers", scope: "read_only", description: "List customers for the authenticated merchant." },
  { name: "list_customer_payment_methods", scope: "read_only", description: "A customer's active saved payment methods (card brand/last4, type)." },
  { name: "list_subscriptions", scope: "read_only", description: "List subscriptions, optionally filtered by customer." },
  { name: "get_subscription", scope: "read_only", description: "One subscription's full detail: billing amount, interval, cancellation status." },
  { name: "cancel_subscription", scope: "read_write", description: "Cancel a subscription, with an optional free-text reason." },
];

export default function AiAgentsDocsPage() {
  return (
    <div>
      <DocsHeader
        eyebrow="Configuration"
        title="AI Agents (MCP)"
        description="A live Model Context Protocol server that lets Claude — or any other MCP-speaking client — research and act on this merchant's own payments, customers, and subscriptions."
      />

      <Callout tone="info" title="A real backend, not a demo" className="mb-8">
        Every tool call below is a genuine authenticated request to backend-go&apos;s <code className="font-mono">/v1/*</code>{" "}
        API — the same routes the rest of this dashboard and the Checkout SDK use. There is no separate mock path for
        MCP: a read/write agent token can really capture, void, refund, or cancel.
      </Callout>

      <section className="mb-10">
        <h2 id="architecture" className="mb-3 text-lg font-semibold text-foreground">How it fits together</h2>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          <code className="font-mono">app/api/[transport]/route.ts</code> is the MCP server itself — built on
          Vercel&apos;s <code className="font-mono">mcp-handler</code> package on top of{" "}
          <code className="font-mono">@modelcontextprotocol/sdk</code>, speaking the MCP spec&apos;s Streamable HTTP
          transport in stateless mode (one request in, one JSON-RPC response out — no session to keep warm between
          calls, which matches a Vercel serverless function&apos;s own lifecycle). The live endpoint is:
        </p>
        <CodeBlock label="MCP endpoint">POST https://&lt;your-deployment&gt;/api/mcp</CodeBlock>
        <p className="mt-4 mb-3 text-sm leading-relaxed text-muted-foreground">
          Every tool call carries the MCP client&apos;s own Bearer agent token straight through to backend-go — this
          route does not hold or inject the dashboard&apos;s master API token the way every other{" "}
          <code className="font-mono">app/api/*</code> proxy route does (see{" "}
          <code className="font-mono">lib/mcp/backend-client.ts</code>). backend-go is the only place that ever
          decides whether a token is valid and what it&apos;s allowed to do:
        </p>
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
          <li>
            <strong className="text-foreground">MCP client → this route.</strong> A tool call arrives with{" "}
            <code className="font-mono">Authorization: Bearer &lt;agent token&gt;</code>.
          </li>
          <li>
            <strong className="text-foreground">This route → backend-go.</strong> The same Bearer token is forwarded
            unchanged to the relevant <code className="font-mono">/v1/*</code> route.
          </li>
          <li>
            <strong className="text-foreground">backend-go decides.</strong> Its existing auth middleware resolves
            the token to a product/merchant entity and a scope (<code className="font-mono">read_only</code> /{" "}
            <code className="font-mono">read_write</code>); every mutating handler additionally calls{" "}
            <code className="font-mono">RequireWriteScope</code>, which 403s a read_only token before touching
            anything.
          </li>
          <li>
            <strong className="text-foreground">Result flows back verbatim.</strong> A 401/403/404 from backend-go
            becomes an <code className="font-mono">isError</code> tool result with backend-go&apos;s own RFC 7807
            problem+json body inlined, so the calling model sees exactly why a call failed.
          </li>
        </ol>
      </section>

      <section className="mb-10">
        <h2 id="agent-tokens" className="mb-3 text-lg font-semibold text-foreground">Agent tokens</h2>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          Create and revoke tokens from{" "}
          <a href="/agents" className="font-medium text-accent-foreground underline underline-offset-2">
            the AI Agents page
          </a>
          . Under the hood this reuses the exact same <code className="font-mono">api_tokens</code> table and
          Bearer-auth mechanism every other API token already goes through — an agent token is distinguished only by{" "}
          <code className="font-mono">kind = &apos;mcp_agent&apos;</code>, and is scoped by:
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Badge tone="accent" className="font-mono normal-case">read_write</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Can call every tool below, including capture/void/refund/cancel. Give this to an agent that&apos;s
              actually meant to resolve support requests, not just look things up.
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Badge tone="info" className="font-mono normal-case">read_only</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Can list/inspect freely, but every mutating tool call gets a 403 from backend-go&apos;s{" "}
              <code className="font-mono">RequireWriteScope</code>. Give this to a research or triage agent that
              should never take action on its own.
            </CardContent>
          </Card>
        </div>
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
          The raw token is shown exactly once, at creation — only its SHA-256 hash is ever persisted, matching every
          other token in this system (including the original bootstrap API token). A lost token means issuing a new
          one and revoking the old; there is no recovery.
        </p>
      </section>

      <section className="mb-10">
        <h2 id="connect" className="mb-3 text-lg font-semibold text-foreground">Connect a client</h2>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          Most MCP clients, including Claude Desktop, speak Streamable HTTP natively — point them at the endpoint
          with the agent token as a Bearer header:
        </p>
        <CodeBlock label="claude_desktop_config.json">{`{
  "mcpServers": {
    "alpha-payments": {
      "url": "https://<your-deployment>/api/mcp",
      "headers": {
        "Authorization": "Bearer <your-agent-token>"
      }
    }
  }
}`}</CodeBlock>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          For a stdio-only client, bridge it with{" "}
          <a
            href="https://www.npmjs.com/package/mcp-remote"
            className="font-medium text-accent-foreground underline underline-offset-2"
          >
            mcp-remote
          </a>
          , which forwards a custom header via <code className="font-mono">--header</code>:
        </p>
        <CodeBlock label="shell">{`npx mcp-remote https://<your-deployment>/api/mcp \\
  --header "Authorization:Bearer <your-agent-token>"`}</CodeBlock>
      </section>

      <section className="mb-10">
        <h2 id="tools" className="mb-3 text-lg font-semibold text-foreground">Tools</h2>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          Ten tools, registered in <code className="font-mono">app/api/[transport]/route.ts</code>. This is the
          intended shape for a customer-service agent: research with the read_only tools, then resolve with
          <code className="font-mono">refund_payment</code> or <code className="font-mono">cancel_subscription</code>.
        </p>
        <Table>
          <THead>
            <TR>
              <TH>Tool</TH>
              <TH>Scope</TH>
              <TH>What it does</TH>
            </TR>
          </THead>
          <TBody>
            {TOOLS.map((tool) => (
              <TR key={tool.name}>
                <TD>
                  <code className="font-mono text-xs">{tool.name}</code>
                </TD>
                <TD>
                  <Badge tone={tool.scope === "read_write" ? "accent" : "info"} className="font-mono normal-case">
                    {tool.scope}
                  </Badge>
                </TD>
                <TD className="text-sm text-muted-foreground">{tool.description}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </section>

      <Callout tone="tip" title="Idempotency, handled for you">
        <code className="font-mono">capture_payment</code>, <code className="font-mono">void_payment</code>, and{" "}
        <code className="font-mono">refund_payment</code> all call backend-go routes that require an{" "}
        <code className="font-mono">Idempotency-Key</code> header. The MCP server generates a fresh one for every
        call — a model retrying a failed tool call gets a clean second attempt rather than an idempotency conflict,
        and there is no key for the calling model to manage.
      </Callout>

      <section className="mt-10">
        <h2 id="known-gaps" className="mb-3 text-lg font-semibold text-foreground">Known gaps</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Auth here is a static Bearer token, not the MCP spec&apos;s OAuth 2.1 authorization flow — appropriate for
          a merchant issuing tokens to its own agents from its own dashboard, but not a fit for a public,
          multi-tenant MCP directory where a third party&apos;s client would need to complete a consent flow. There
          is also no per-tool-call audit trail distinct from backend-go&apos;s existing request logging — a call
          from an MCP agent looks the same in the logs as any other Bearer-authenticated API call, distinguished only
          by which token was used.
        </p>
      </section>
    </div>
  );
}
