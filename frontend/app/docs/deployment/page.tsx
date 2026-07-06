import { DocsHeader } from "@/components/docs/docs-header";
import { Callout } from "@/components/docs/callout";
import { CodeBlock } from "@/components/docs/code-block";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default function DeploymentDocsPage() {
  return (
    <div>
      <DocsHeader
        eyebrow="Risk & operations"
        title="Deployment"
        description="Where each half of this system actually runs today, and the honest state of wiring them together."
      />

      <Callout tone="warning" title="The live dashboard is not talking to the live backend" className="mb-8">
        This app is deployed and reachable today, and the backend has infrastructure provisioned on
        Railway — but the dashboard you&apos;re looking at renders mock data from{" "}
        <code className="font-mono">lib/mock-data.ts</code> regardless of whether the backend is up. No page
        in this frontend makes an HTTP request to the backend API. Deploying both sides does not, by
        itself, connect them.
      </Callout>

      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold text-foreground">Frontend — Vercel</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          The Next.js dashboard is deployed on Vercel via GitHub auto-deploy: pushes to the repo&apos;s default
          branch trigger a new build and deploy automatically. Since every page is statically rendered
          from in-memory mock data with no server-side data fetching against an external API, this is a
          simple deploy with no environment-specific backend URL configured — there&apos;s nothing to point
          at yet.
        </p>
      </section>

      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold text-foreground">Backend — Railway</h2>
        <p className="mb-4 text-sm leading-relaxed text-muted-foreground">
          The backend is intended to run on Railway with managed Postgres and Redis, plus a self-hosted
          Hatchet-lite task queue for durable background work (webhook normalization/apply, settlement
          ingestion, dunning, nightly invariants, outbound webhook delivery). Provisioning status:
        </p>
        <div className="space-y-2">
          <StatusRow label="Railway Postgres + Redis provisioned" status="done" />
          <StatusRow label="Hatchet-lite service deployed on Railway" status="done" />
          <StatusRow label="Backend api + worker services deployed on Railway" status="in_progress" />
          <StatusRow label="DB migrations run against Railway Postgres" status="pending" />
          <StatusRow label="Hatchet client token bootstrapped and wired into api/worker" status="pending" />
          <StatusRow label="Live deployment verified end-to-end" status="pending" />
        </div>
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
          Locally, the same topology is defined in <code className="font-mono">docker-compose.yml</code>{" "}
          (project name <code className="font-mono">payment-orchestrator</code>):
        </p>
        <CodeBlock label="docker-compose.yml services" className="mt-3">{`postgres  — postgres:16, port 5432, healthcheck via pg_isready
redis     — redis:7, port 6379, healthcheck via redis-cli ping
hatchet   — ghcr.io/hatchet-dev/hatchet/hatchet-lite:latest
            dashboard :8888, grpc :7077, depends on postgres (healthy)
            needs a one-time "make hatchet-token" bootstrap into .env as HATCHET_CLIENT_TOKEN
api       — npm run dev:api,    depends on postgres/redis/hatchet (healthy), port 3000
worker    — npm run dev:worker, same deps, exposes :9464 (metrics only)`}</CodeBlock>
        <Callout tone="info" title="Never run end-to-end in this build environment" className="mt-4">
          The compose file itself carries a header comment stating it has not been run end-to-end — it was
          authored and validated for YAML correctness without a Docker daemon available in the build
          sandbox, cross-checked against Hatchet&apos;s published reference only. The observability stack
          (Prometheus/Grafana dashboards-as-code, per <code className="font-mono">
            docs/adr/0009-dashboards-and-alerting.md
          </code>
          ) is deliberately kept out of the default compose file and lives in an optional{" "}
          <code className="font-mono">docker-compose.observability.yml</code> overlay instead.
        </Callout>
      </section>

      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold text-foreground">Config &amp; secrets</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          The backend validates all configuration at boot via a Zod schema (
          <code className="font-mono">src/config/schema.ts</code>) and fails fast on anything missing or
          malformed — including a cross-field check that <code className="font-mono">
            STRIPE_SECRET_KEY
          </code>
          /<code className="font-mono">STRIPE_PUBLISHABLE_KEY</code> prefixes match the declared{" "}
          <code className="font-mono">STRIPE_MODE</code>. In dev/CI this is just a{" "}
          <code className="font-mono">.env</code> file; for a real production deployment,{" "}
          <code className="font-mono">docs/adr/0003-secrets-management.md</code> recommends a secrets
          manager (AWS Secrets Manager/Parameter Store, or Doppler/Vault) injected at boot before config
          loads, rather than plain container env vars — and notes there is currently no live-reload or
          zero-downtime key-rotation story; rotating a secret requires a rolling restart.
        </p>
      </section>

      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold text-foreground">What &quot;wiring it up&quot; actually means</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Mechanical — Dashboard &amp; Payments</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              These pages and their types (<code className="font-mono">lib/types.ts</code>) already match
              the backend&apos;s real shapes (<code className="font-mono">src/db/types.ts</code>,{" "}
              <code className="font-mono">src/domain/</code>). Wiring means replacing{" "}
              <code className="font-mono">getMockPayments()</code> calls with fetches against{" "}
              <code className="font-mono">GET /v1/payments</code>, using a per-product Bearer token (
              <code className="font-mono">src/api/auth.ts</code>; <code className="font-mono">
                scripts/seed.ts
              </code>{" "}
              prints one).
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Not mechanical — Plans, Integrations, Workflows</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              These were rebuilt to match PayNext&apos;s dashboard model, not this backend&apos;s schema. The
              backend has no plans-catalog table, no endpoint for storing processor credentials, and a
              routing-rules table that doesn&apos;t resemble a trigger/condition/action chain. See each page&apos;s
              own docs for the specific mismatches — this needs schema/API design work, not just a fetch
              call.
            </CardContent>
          </Card>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-foreground">No authentication on this dashboard</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          This frontend has no login screen. It&apos;s currently reachable as an internal tool without any
          gate in front of it. The backend&apos;s per-product API tokens (<code className="font-mono">
            src/api/auth.ts
          </code>
          , format <code className="font-mono">po_&lt;48 hex chars&gt;</code>, only the SHA-256 hash persisted)
          will eventually gate the real API calls this dashboard makes — but that only protects the API,
          not this UI. Add an auth layer here before this is reachable outside a trusted network.
        </p>
      </section>
    </div>
  );
}

function StatusRow({ label, status }: { label: string; status: "done" | "in_progress" | "pending" }) {
  const tone = status === "done" ? "success" : status === "in_progress" ? "warning" : "neutral";
  const text = status === "done" ? "Done" : status === "in_progress" ? "In progress" : "Pending";
  return (
    <div className="flex items-center justify-between rounded-lg border border-border px-4 py-2.5">
      <span className="text-sm text-foreground">{label}</span>
      <Badge tone={tone}>{text}</Badge>
    </div>
  );
}
