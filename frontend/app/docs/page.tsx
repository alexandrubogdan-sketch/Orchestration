import Link from "next/link";
import {
  CreditCard,
  Plug,
  Workflow,
  Wallet,
  Boxes,
  ShieldAlert,
  Scale,
  Rocket,
} from "lucide-react";
import { DocsHeader } from "@/components/docs/docs-header";
import { Callout } from "@/components/docs/callout";
import { CodeBlock } from "@/components/docs/code-block";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default function DocsOverviewPage() {
  return (
    <div>
      <DocsHeader
        eyebrow="Introduction"
        title="Overview & architecture"
        description="What Alpha Payments is, how the pieces fit together, and — since this is an internal build, not a vendor's marketing site — exactly how much of it is wired up today."
      />

      <section className="mb-10 space-y-3">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Alpha Payments is an in-house payment orchestration layer for a digital-goods company operating
          multiple products across two legal entities (
          <code className="rounded bg-neutral-bg px-1 py-0.5 text-xs font-mono">US-LLC</code> and{" "}
          <code className="rounded bg-neutral-bg px-1 py-0.5 text-xs font-mono">EU-BV</code>), processing
          through multiple PSPs — Stripe first, Solidgate second, with Adyen and Netevia intended later
          behind the same adapter interface.
        </p>
        <p className="text-sm leading-relaxed text-muted-foreground">It provides:</p>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li><strong className="text-foreground">One internal payments API</strong> and one canonical payment state machine</li>
          <li><strong className="text-foreground">One normalized decline-code taxonomy</strong> across PSPs</li>
          <li><strong className="text-foreground">Reliable webhook ingestion</strong> and config-driven PSP routing</li>
          <li><strong className="text-foreground">An append-only event timeline</strong> per payment, plus an immutable transaction ledger</li>
          <li><strong className="text-foreground">Settlement reconciliation</strong> against the ledger</li>
        </ul>
        <p className="text-sm leading-relaxed text-muted-foreground">
          It deliberately does <strong className="text-foreground">not</strong> build a checkout UI, a card
          vault (no PAN or CVV is ever stored or logged), fraud scoring, or chargeback representment.
        </p>
      </section>

      <section className="mb-10">
        <h2 id="two-codebases-one-product" className="mb-3 text-lg font-semibold text-foreground">Two codebases, one product</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Backend — payment-orchestrator</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p>
                Fastify + TypeScript on Node 22, Postgres 16 as the source of truth, Redis 7 for
                idempotency/rate-limiting/circuit-breaker state, and a self-hosted Hatchet task queue for
                durable background work (webhook normalization, settlement ingestion, dunning, nightly
                invariants).
              </p>
              <p>Built across 8 milestones, all complete in code:</p>
              <ol className="list-decimal space-y-0.5 pl-4">
                <li>Foundations (config, observability, CI)</li>
                <li>Core domain &amp; state machine</li>
                <li>PSP adapter interface + Stripe + mock</li>
                <li>Webhook pipeline</li>
                <li>Orchestrator API</li>
                <li>Routing v1 + circuit breakers</li>
                <li>Ledger &amp; reconciliation</li>
                <li>Hardening &amp; ops, then subscriptions/dunning + Solidgate</li>
              </ol>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Frontend — this dashboard</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p>
                <strong className="text-foreground">Next.js 16</strong> (App Router) + TypeScript +
                Tailwind CSS v4, with shadcn/ui-style primitives under{" "}
                <code className="rounded bg-neutral-bg px-1 py-0.5 text-xs font-mono">components/ui/</code>.
              </p>
              <p>
                <strong className="text-foreground">Recharts</strong> for charts,{" "}
                <strong className="text-foreground">React Flow + elkjs</strong> for the workflow canvas, and{" "}
                <strong className="text-foreground">Zustand</strong> for client-side editable state.
              </p>
              <p>
                Pages: Dashboard, Payments, Plans, Integrations, Workflows, Risk Monitoring — and now
                this Docs section.
              </p>
            </CardContent>
          </Card>
        </div>
      </section>

      <Callout tone="warning" title="This dashboard runs on mock data" className="mb-10">
        Every page in this app — Dashboard, Payments, Plans, Integrations, Workflows, Risk Monitoring —
        renders deterministic mock data from <code className="font-mono">lib/mock-data.ts</code> (and{" "}
        <code className="font-mono">lib/risk-monitoring.ts</code> for the risk tiers). There is currently no
        live fetch against the backend&apos;s API anywhere in this codebase. The backend itself is functionally
        complete, but the two were never wired together. See{" "}
        <Link href="/docs/deployment" className="font-medium text-accent-foreground underline underline-offset-2">
          Deployment
        </Link>{" "}
        for exactly what that means for the live, deployed version of this app, and each page&apos;s own docs
        for what would need to change to wire it up.
      </Callout>

      <section className="mb-10">
        <h2 id="request-flow" className="mb-3 text-lg font-semibold text-foreground">Request flow, end to end</h2>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          A payment moving through the (backend&apos;s) real pipeline looks like this:
        </p>
        <CodeBlock label="pipeline">{`1. Client -> POST /v1/payments (Idempotency-Key header, product Bearer token)
2. API resolves a psp_account via the routing evaluator (routing_rules, else naive fallback)
3. API calls adapter.createPayment() -> PSP (Stripe PaymentIntent / Solidgate /charge)
4. Synchronous AttemptResult applies "initial" canonical events immediately (src/api/attemptEvents.ts)
5. PSP sends webhooks asynchronously -> POST /webhooks/:psp
   -> webhook_inbox insert (dedup on (psp, provider_event_id))
   -> "webhook.normalize" task -> adapter.normalizeEvent() -> canonical events
   -> "webhook.apply" task (serialized per payment_id) -> stateMachineDb.transition()
6. Every transition writes exactly one payment_events row + (for capture/refund/chargeback)
   a transactions row, in the same DB transaction, and enqueues an outbox row for
   outbound webhooks to products.
7. Settlement ingestion (cron) later reconciles Stripe balance transactions/payouts
   against the ledger; nightly invariants sweep for stuck states and net mismatches.`}</CodeBlock>
      </section>

      <section className="mb-10">
        <h2 id="non-negotiable-principles" className="mb-3 text-lg font-semibold text-foreground">Non-negotiable principles</h2>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          These are enforced in the backend&apos;s design, not just conventions — quoting{" "}
          <code className="font-mono">SPEC.md</code> directly since they explain a lot of the API and schema
          shape you&apos;ll see in the rest of these docs:
        </p>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li>
            <Badge tone="accent" className="mr-2">
              money
            </Badge>
            Amounts are always integer minor units + an ISO 4217 currency code. Any float in a money path
            is treated as a bug.
          </li>
          <li>
            <Badge tone="accent" className="mr-2">
              source of truth
            </Badge>
            Postgres enforces state transitions, idempotency, and dedupe via transactions and unique
            constraints — never application memory.
          </li>
          <li>
            <Badge tone="accent" className="mr-2">
              webhooks
            </Badge>
            Webhooks are the source of truth for payment status; API responses are advisory. Delivery is
            assumed at-least-once, duplicate, out-of-order, and bursty.
          </li>
          <li>
            <Badge tone="accent" className="mr-2">
              idempotency
            </Badge>
            Enforced at every layer: client→API (<code className="font-mono">Idempotency-Key</code> header),
            API→PSP (deterministic per-attempt key), webhook→handler (unique constraint on provider event
            id).
          </li>
          <li>
            <Badge tone="accent" className="mr-2">
              state machine is law
            </Badge>
            Transitions outside the allowed-transition table are rejected and logged as invariant
            violations. Late/out-of-order events are recorded on the timeline but never regress state.
          </li>
          <li>
            <Badge tone="accent" className="mr-2">
              append-only
            </Badge>
            <code className="font-mono">payment_events</code> and <code className="font-mono">transactions</code>{" "}
            are never updated or deleted. Corrections are new rows.
          </li>
          <li>
            <Badge tone="accent" className="mr-2">
              adapter isolation
            </Badge>
            Nothing outside <code className="font-mono">src/adapters/</code> may import a PSP SDK or
            reference a PSP-specific status/code.
          </li>
          <li>
            <Badge tone="accent" className="mr-2">
              no PAN/CVV
            </Badge>
            Never stored, never logged — enforced with a log-scrubbing test that greps captured log output
            for card-number patterns.
          </li>
        </ul>
      </section>

      <section>
        <h2 id="where-to-go-next" className="mb-3 text-lg font-semibold text-foreground">Where to go next</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {[
            { href: "/docs/payments", title: "Payments", desc: "States, timeline events, idempotency", icon: CreditCard },
            { href: "/docs/adapters", title: "PSP adapters & declines", desc: "Adapter isolation, decline taxonomy", icon: Plug },
            { href: "/docs/workflows", title: "Workflows", desc: "Trigger/condition/action model, 3DS, routing", icon: Workflow },
            { href: "/docs/plans", title: "Plans & billing", desc: "Localized pricing, trial config", icon: Wallet },
            { href: "/docs/integrations", title: "Integrations", desc: "Per-processor credentials", icon: Boxes },
            { href: "/docs/risk-monitoring", title: "Risk monitoring", desc: "VAMP / Mastercard thresholds", icon: ShieldAlert },
            { href: "/docs/reconciliation", title: "Reconciliation & ledger", desc: "Settlement matching, exceptions", icon: Scale },
            { href: "/docs/deployment", title: "Deployment", desc: "Vercel, Railway, and what isn't wired up", icon: Rocket },
          ].map((item) => (
            <Link key={item.href} href={item.href}>
              <Card className="h-full transition-colors hover:border-accent/50">
                <CardContent className="flex items-start gap-3 p-4">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent-foreground">
                    <item.icon className="h-4 w-4" />
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-foreground">{item.title}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{item.desc}</div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
