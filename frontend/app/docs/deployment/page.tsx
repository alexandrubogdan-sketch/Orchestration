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
        <h2 id="frontend-vercel" className="mb-3 text-lg font-semibold text-foreground">Frontend — Vercel</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          The Next.js dashboard is deployed on Vercel via GitHub auto-deploy: pushes to the repo&apos;s default
          branch trigger a new build and deploy automatically. Since every page is statically rendered
          from in-memory mock data with no server-side data fetching against an external API, this is a
          simple deploy with no environment-specific backend URL configured — there&apos;s nothing to point
          at yet.
        </p>
      </section>

      <section className="mb-10">
        <h2 id="backend-railway" className="mb-3 text-lg font-semibold text-foreground">Backend — Railway</h2>
        <p className="mb-2 text-sm leading-relaxed text-muted-foreground">
          The backend runs on Railway with managed Postgres and Redis, plus a self-hosted Hatchet-lite task
          queue for durable background work — webhook normalization/apply, settlement ingestion, dunning,
          nightly invariants, and outbound webhook delivery.
        </p>
        <p className="mb-4 text-sm leading-relaxed text-muted-foreground">Provisioning status:</p>
        <div className="space-y-2">
          <StatusRow label="Railway Postgres + Redis provisioned" status="done" />
          <StatusRow label="Hatchet-lite service deployed on Railway" status="done" />
          <StatusRow label="Backend api + worker services deployed on Railway" status="done" />
          <StatusRow label="DB migrations run against Railway Postgres" status="done" />
          <StatusRow label="Hatchet client token bootstrapped and wired into api/worker" status="done" />
          <StatusRow label="Live deployment verified end-to-end" status="done" />
        </div>
        <Callout tone="warning" title="The Go rewrite happened after that deployment work" className="mt-4">
          The backend was subsequently rewritten from Fastify/TypeScript to Go (
          <code className="font-mono">payment-orchestrator-go/</code>) — same Postgres schema, same
          milestone structure, same Hatchet-based worker pattern, ported behind a chi router with pgx
          instead of a raw SQL client. This dashboard&apos;s own docs have not been fully re-verified against
          a redeployment of that Go service specifically: the provisioning checklist above reflects the
          original (TypeScript-era) Railway rollout, and whether the Go binary has been redeployed to the
          same Railway services since is not something these docs can currently confirm. Treat the rows
          above as &quot;this infrastructure exists and was verified once,&quot; not as a live status of the
          current Go build.
        </Callout>
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
          Locally, the original TypeScript-era topology was defined in{" "}
          <code className="font-mono">docker-compose.yml</code> (project name{" "}
          <code className="font-mono">payment-orchestrator</code>) — the same Postgres/Redis/Hatchet-lite
          services this Go backend still depends on, with only the <code className="font-mono">api</code>/{" "}
          <code className="font-mono">worker</code> service commands differing:
        </p>
        <CodeBlock label="docker-compose.yml services (original TypeScript-era file)" className="mt-3">{`postgres  — postgres:16, port 5432, healthcheck via pg_isready
redis     — redis:7, port 6379, healthcheck via redis-cli ping
hatchet   — ghcr.io/hatchet-dev/hatchet/hatchet-lite:latest
            dashboard :8888, grpc :7077, depends on postgres (healthy)
            needs a one-time "make hatchet-token" bootstrap into .env as HATCHET_CLIENT_TOKEN
api       — npm run dev:api,    depends on postgres/redis/hatchet (healthy), port 3000
worker    — npm run dev:worker, same deps, exposes :9464 (metrics only)`}</CodeBlock>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          The Go rewrite&apos;s own equivalent compose file would swap the <code className="font-mono">
            api
          </code>
          /<code className="font-mono">worker</code> commands for the compiled <code className="font-mono">
            cmd/api
          </code>
          /<code className="font-mono">cmd/worker</code> binaries — that update was out of scope for the
          port itself and is not documented here yet.
        </p>
        <Callout tone="info" title="Never run end-to-end in this build environment" className="mt-4">
          The original compose file&apos;s own header comment states it was never run end-to-end — authored
          and validated for YAML correctness without a Docker daemon available in the build sandbox,
          cross-checked against Hatchet&apos;s published reference only. The observability stack
          (Prometheus/Grafana dashboards-as-code, per <code className="font-mono">
            docs/adr/0009-dashboards-and-alerting.md
          </code>
          ) is deliberately kept out of the default compose file and lives in an optional{" "}
          <code className="font-mono">docker-compose.observability.yml</code> overlay instead.
        </Callout>
      </section>

      <section className="mb-10">
        <h2 id="config-and-secrets" className="mb-3 text-lg font-semibold text-foreground">Config &amp; secrets</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          The original TypeScript backend validated all configuration at boot via a Zod schema (
          <code className="font-mono">src/config/schema.ts</code>), failing fast on anything missing or
          malformed — including a cross-field check that <code className="font-mono">
            STRIPE_SECRET_KEY
          </code>
          /<code className="font-mono">STRIPE_PUBLISHABLE_KEY</code> prefixes match the declared{" "}
          <code className="font-mono">STRIPE_MODE</code>. The Go rewrite&apos;s config package (
          <code className="font-mono">internal/config/</code>) ports the same fail-fast-at-boot approach
          using <code className="font-mono">caarlos0/env</code> for env-var parsing and{" "}
          <code className="font-mono">go-playground/validator</code> for struct-tag validation — the Go
          equivalent of a Zod schema, not a from-scratch redesign. In dev/CI this is just a{" "}
          <code className="font-mono">.env</code> file; for a real production deployment,{" "}
          <code className="font-mono">docs/adr/0003-secrets-management.md</code> recommends a secrets
          manager (AWS Secrets Manager/Parameter Store, or Doppler/Vault) injected at boot before config
          loads, rather than plain container env vars — and notes there is currently no live-reload or
          zero-downtime key-rotation story; rotating a secret requires a rolling restart.
        </p>
      </section>

      <section className="mb-10">
        <h2 id="wiring-it-up" className="mb-3 text-lg font-semibold text-foreground">What &quot;wiring it up&quot; actually means</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Mechanical — Dashboard, Payments, Customers, Retries</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              These pages and their types (<code className="font-mono">lib/types.ts</code>) already match
              the backend&apos;s real shapes (<code className="font-mono">payment-orchestrator-go/internal/domain/</code>,{" "}
              <code className="font-mono">internal/api/</code>). Wiring means replacing{" "}
              <code className="font-mono">getMockPayments()</code>/<code className="font-mono">
                useRetrySettingsStore
              </code>{" "}
              mock calls with fetches against <code className="font-mono">GET /v1/payments</code>,{" "}
              <code className="font-mono">GET /v1/customers/:id/payment-methods</code>, and{" "}
              <code className="font-mono">GET</code>/<code className="font-mono">PUT /v1/retry-settings</code>,
              using a per-product Bearer token. This is a fetch-and-map job, not a schema redesign.
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
              call. The Checkout SDK and its checkout-sessions backend are the one exception among the
              &quot;newer&quot; features: that flow was designed backend-first, so it has no such mismatch — see{" "}
              <a href="/docs/checkout-sdk" className="font-medium text-accent-foreground underline underline-offset-2">
                Checkout SDK
              </a>
              .
            </CardContent>
          </Card>
        </div>
      </section>

      <section>
        <h2 id="no-authentication" className="mb-3 text-lg font-semibold text-foreground">No authentication on this dashboard</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          This frontend has no login screen. It&apos;s currently reachable as an internal tool without any
          gate in front of it. The backend&apos;s per-product API tokens (<code className="font-mono">
            payment-orchestrator-go/internal/api/auth.go
          </code>
          , format <code className="font-mono">po_&lt;48 hex chars&gt;</code>, only the SHA-256 hash persisted
          — a 1:1 port of the original TypeScript token format) will eventually gate the real API calls this
          dashboard makes — but that only protects the API, not this UI. Add an auth layer here before this
          is reachable outside a trusted network.
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
