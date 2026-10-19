import { Callout } from "@/components/docs/callout";
import { CodeTabs } from "@/components/docs/code-tabs";
import { DocsHeader } from "@/components/docs/docs-header";
import { DocSection, InlineCode } from "@/components/docs/prose";

export default function DeploymentPage() {
  return (
    <div>
      <DocsHeader
        eyebrow="Operate"
        title="Deployment"
        description="The API runs as two processes, an HTTP server and a worker, on Postgres 16 and Redis. The dashboard is a separate Next.js app."
      />

      <DocSection id="services" title="Services">
        <dl className="divide-y divide-border border-y border-border">
          {[
            ["API", "Serves /v1, processor webhooks, /healthz, /readyz and /metrics. Runs migrations on start."],
            ["Worker", "Normalizes webhooks, relays the outbox, runs renewals, dunning and reconciliation."],
            ["Postgres 16", "Payments, the append-only ledger and event timeline, keys and subscriptions."],
            ["Redis", "Idempotency cache, circuit breakers, routing-rule cache and rate limits."],
            ["Hatchet", "Durable task queue and schedules for the worker."],
          ].map(([name, role]) => (
            <div key={name} className="grid gap-1 py-2.5 sm:grid-cols-[9rem_1fr]">
              <dt className="text-sm font-semibold text-foreground">{name}</dt>
              <dd className="text-sm">{role}</dd>
            </div>
          ))}
        </dl>
      </DocSection>

      <DocSection id="local" title="Run it locally">
        <CodeTabs
          samples={[
            {
              label: "Shell",
              code: `cd backend
cp .env.example .env
make dev
make migrate-up
make seed
npm test
npm run test:integration`,
            },
          ]}
        />
        <p>
          <InlineCode>make seed</InlineCode> prints a full-access API key for the seeded pilot product. Integration tests
          need the Postgres and Redis containers that <InlineCode>make dev</InlineCode> starts.
        </p>
      </DocSection>

      <DocSection id="production" title="Production">
        <p>
          Build the API from <InlineCode>backend/Dockerfile</InlineCode>. Deploy the same image twice: once with the
          default command for the API, and once running <InlineCode>node dist/src/worker.js</InlineCode> for the worker.
          Attach managed Postgres and Redis through <InlineCode>DATABASE_URL</InlineCode> and{" "}
          <InlineCode>REDIS_URL</InlineCode>.
        </p>
        <Callout tone="warning" title="Ship through a pull request">
          Pushing to the main branch deploys the live API. Merge changes that include migrations through a reviewed pull
          request and check <InlineCode>/readyz</InlineCode> afterwards.
        </Callout>
      </DocSection>

      <DocSection id="configuration" title="Configuration">
        <p>
          Every setting is an environment variable validated at start-up; the process refuses to boot with a missing or
          malformed value instead of failing later. <InlineCode>backend/.env.example</InlineCode> lists them all.
        </p>
        <p>
          The dashboard needs <InlineCode>BACKEND_API_BASE_URL</InlineCode> and <InlineCode>BACKEND_API_TOKEN</InlineCode>{" "}
          for Live mode, and <InlineCode>NEXT_PUBLIC_API_BASE_URL</InlineCode> to show the base URL on the Developers
          page. Give the dashboard&apos;s token only the scopes the pages you use need.
        </p>
      </DocSection>
    </div>
  );
}
