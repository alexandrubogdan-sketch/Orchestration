import { DocsHeader } from "@/components/docs/docs-header";
import { Callout } from "@/components/docs/callout";
import { CodeBlock } from "@/components/docs/code-block";
import { Badge } from "@/components/ui/badge";

export default function RetriesDocsPage() {
  return (
    <div>
      <DocsHeader
        eyebrow="Configuration"
        title="Retries & dunning"
        description="The configurable dunning ladder and same-instrument retry policy, surfaced as a Retries tab under Workflows and backed by a real, DB-persisted Go API."
      />

      <section className="mb-10">
        <h2 id="two-different-retries" className="mb-3 text-lg font-semibold text-foreground">
          Two different things named &quot;retry&quot;
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          This page covers both, since the Retries tab (<code className="font-mono">app/workflows/retries/page.tsx</code>)
          edits both at once, but they govern different failure modes:
        </p>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
          <li>
            <strong className="text-foreground">Same-instrument retry policy</strong> — how many times, and
            how far apart, a single payment&apos;s own attempt sequence may retry against the same
            instrument (see{" "}
            <a href="/docs/workflows#backend-routing-heading" className="font-medium text-accent-foreground underline underline-offset-2">
              Workflows &rsaquo; Backend routing
            </a>{" "}
            for how this interacts with the circuit breaker).
          </li>
          <li>
            <strong className="text-foreground">Dunning ladder</strong> — after a subscription renewal
            fails, how long to wait before each subsequent retry attempt, and how many rungs before the
            subscription is canceled.
          </li>
        </ul>
      </section>

      <section className="mb-10">
        <h2 id="now-configurable" className="mb-3 text-lg font-semibold text-foreground">Now configurable, not hardcoded</h2>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          Both used to be hardcoded constants (<code className="font-mono">routing.DefaultRetryPolicy</code>,{" "}
          <code className="font-mono">subscriptions.DunningLadderHours</code>). A real,
          per-merchant-entity <code className="font-mono">retry_settings</code> table and{" "}
          <code className="font-mono">GET</code>/<code className="font-mono">PUT /v1/retry-settings</code>{" "}
          API (<code className="font-mono">payment-orchestrator-go/internal/api/retry_settings.go</code>)
          now let a merchant override both. The old constants still exist — as the hardcoded fallback{" "}
          <code className="font-mono">GET</code> returns for a merchant entity that has never called{" "}
          <code className="font-mono">PUT</code>, not because the two are kept in sync by import; the Go
          source&apos;s own comment flags this duplication as deliberate, since <code className="font-mono">
            internal/api
          </code>{" "}
          intentionally doesn&apos;t depend on <code className="font-mono">internal/routing</code>/{" "}
          <code className="font-mono">internal/subscriptions</code>.
        </p>
        <CodeBlock label="Defaults (same numbers on both frontend and backend)">{`dunningLadderHours:    [24, 72, 168]   // 1, 3, and 7 days after a failed renewal
maxAttemptsPerPayment: 3
minSpacingSeconds:     2`}</CodeBlock>
      </section>

      <section className="mb-10">
        <h2 id="api" className="mb-3 text-lg font-semibold text-foreground"><code className="font-mono">GET</code>/<code className="font-mono">PUT /v1/retry-settings</code></h2>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          Both routes are Bearer-authenticated and scoped by <code className="font-mono">auth.MerchantEntityID</code>{" "}
          — retry policy is exactly as sensitive a piece of merchant configuration as anything else under{" "}
          <code className="font-mono">/v1</code>.
        </p>
        <CodeBlock label="RetrySettingsDTO">{`{
  "dunningLadderHours": [24, 72, 168],
  "maxAttemptsPerPayment": 3,
  "minSpacingSeconds": 2,
  "updatedAt": "2026-01-01T00:00:00Z"
}`}</CodeBlock>
        <p className="mt-3 mb-2 text-sm leading-relaxed text-muted-foreground">
          <code className="font-mono">GET</code> never inserts a row just because it was read — a merchant
          entity with no row yet gets the hardcoded defaults back directly, and only a <code className="font-mono">
            PUT
          </code>{" "}
          call ever creates one (an <code className="font-mono">INSERT ... ON CONFLICT DO UPDATE</code>,
          handling first-configure and every subsequent update identically). <code className="font-mono">
            PUT
          </code>{" "}
          validates before touching the store:
        </p>
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
          <li><code className="font-mono">dunningLadderHours</code>: 1&ndash;10 entries, every entry &ge; 0, and the sequence must be non-decreasing.</li>
          <li><code className="font-mono">maxAttemptsPerPayment</code>: &ge; 1.</li>
          <li><code className="font-mono">minSpacingSeconds</code>: &ge; 0.</li>
        </ul>
      </section>

      <section className="mb-10">
        <h2 id="frontend-shape" className="mb-3 text-lg font-semibold text-foreground">This dashboard&apos;s editable shape</h2>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          <code className="font-mono">lib/types.ts</code> mirrors the backend&apos;s row shape field-for-field,
          but represents the ladder as an array of stable-id&apos;d steps rather than a plain{" "}
          <code className="font-mono">number[]</code>, so the editor can add/remove/reorder rungs:
        </p>
        <CodeBlock label="lib/types.ts">{`interface DunningLadderStep {
  id: string;       // client-only key for list operations — never sent to the backend
  waitHours: number;
}

interface RetryPolicy {
  ladder: DunningLadderStep[];
  maxAttemptsPerPayment: number;
  minSpacingSeconds: number;
}`}</CodeBlock>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          <code className="font-mono">lib/retry-settings-store.ts</code>&apos;s{" "}
          <code className="font-mono">toDunningLadderHours()</code> converts the editable{" "}
          <code className="font-mono">DunningLadderStep[]</code> list down to the plain{" "}
          <code className="font-mono">number[]</code> the wire format uses — exactly the serialization step
          a real <code className="font-mono">PUT /v1/retry-settings</code> call would also need, per the
          store&apos;s own <code className="font-mono">savePolicy</code> doc comment.
        </p>
      </section>

      <Callout tone="warning" title="Save button doesn't call the API yet">
        <code className="font-mono">savePolicy()</code> is currently a no-op — the Retries tab edits{" "}
        <code className="font-mono">lib/retry-settings-store.ts</code>&apos;s local Zustand state only, seeded
        from the same hardcoded defaults the real <code className="font-mono">GET</code> falls back to.
        Refreshing the page resets any edits. The store&apos;s own doc comment spells out the exact one-line{" "}
        <code className="font-mono">PUT</code> call this would become once wired up, since every field it
        would need to send already exists on <code className="font-mono">policy</code> in the right shape.
      </Callout>

      <section className="mt-10">
        <h2 id="recent-attempts-table" className="mb-3 text-lg font-semibold text-foreground">Recent retry attempts table</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          The table below the policy editor is a separate, read-only mock list (
          <code className="font-mono">getMockRetryAttempts()</code>) of individual dunning-ladder rungs
          that fired against a (mock) payment — not persisted anywhere, regenerated deterministically the
          same seeded way every other mock table in this app is.
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Badge tone="success" className="font-mono normal-case">succeeded</Badge>
          <Badge tone="warning" className="font-mono normal-case">declined</Badge>
          <Badge tone="danger" className="font-mono normal-case">failed</Badge>
        </div>
      </section>
    </div>
  );
}
