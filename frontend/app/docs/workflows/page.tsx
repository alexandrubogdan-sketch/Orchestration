import { DocsHeader } from "@/components/docs/docs-header";
import { Callout } from "@/components/docs/callout";
import { CodeBlock } from "@/components/docs/code-block";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default function WorkflowsDocsPage() {
  return (
    <div>
      <DocsHeader
        eyebrow="Configuration"
        title="Workflows"
        description="The no-code trigger → condition → action model this dashboard exposes for routing payments per payment method."
      />

      <Callout tone="warning" title="Modeled on PayNext, not on this backend's schema" className="mb-8">
        The Workflows UI (<code className="font-mono">lib/types.ts</code>, <code className="font-mono">
          lib/workflow-store.ts
        </code>
        ) was deliberately built to match docs.paynext.com&apos;s workflow model, not the backend&apos;s actual
        Milestone 5 routing engine. The backend&apos;s real <code className="font-mono">routing_rules</code>{" "}
        table (see{" "}
        <a
          className="font-medium text-accent-foreground underline underline-offset-2"
          href="#backend-routing"
        >
          Backend routing, below
        </a>
        ) has no concept of a trigger/condition/action chain, AND/OR groups, or a Split node. Treat this
        page as a UI/UX spec to reconcile against the real schema before wiring it up, not a preview of
        the live API shape.
      </Callout>

      <section className="mb-10">
        <h2 id="one-workflow-per-payment-method" className="mb-3 text-lg font-semibold text-foreground">One workflow per payment method</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Each <code className="font-mono">Workflow</code> is tied to exactly one payment method —{" "}
          <code className="font-mono">cards</code>, <code className="font-mono">apple_pay</code>, or{" "}
          <code className="font-mono">google_pay</code> (<code className="font-mono">PAYMENT_METHOD_TYPES</code>{" "}
          in <code className="font-mono">lib/types.ts</code>) — and has a <code className="font-mono">state</code>{" "}
          of <code className="font-mono">draft</code> or <code className="font-mono">published</code>. A
          workflow&apos;s <code className="font-mono">nodes</code> array is a linear chain: index 0 is always
          the trigger node, and every subsequent node is a condition or an action, evaluated in array
          order. There is no branching — a condition node does not have separate match/no-match paths, it
          simply gates whether execution continues to the next node in the chain.
        </p>
      </section>

      <section className="mb-10">
        <h2 id="conditions" className="mb-3 text-lg font-semibold text-foreground">Conditions</h2>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          A condition node matches on one <code className="font-mono">WorkflowConditionParameter</code> using
          one <code className="font-mono">WorkflowOperator</code>:
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Parameters
            </div>
            <div className="flex flex-wrap gap-1.5">
              {[
                "transaction_type",
                "bin",
                "card_network",
                "issuer_country",
                "currency",
                "issuer_name",
                "customer_country",
                "metadata",
                "cit_processor",
              ].map((p) => (
                <Badge key={p} tone="neutral" className="font-mono normal-case">
                  {p}
                </Badge>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Operators
            </div>
            <div className="flex flex-wrap gap-1.5">
              {["equals", "not_equals", "one_of", "is_in_list"].map((p) => (
                <Badge key={p} tone="neutral" className="font-mono normal-case">
                  {p}
                </Badge>
              ))}
            </div>
          </div>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          When <code className="font-mono">parameter</code> is <code className="font-mono">metadata</code>, an
          additional <code className="font-mono">metadataKey</code> (dot-notation) selects which metadata
          field to compare.
        </p>
      </section>

      <section className="mb-10">
        <h2 id="actions" className="mb-3 text-lg font-semibold text-foreground">Actions</h2>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          Five action types (<code className="font-mono">WORKFLOW_ACTION_TYPES</code>):{" "}
          <code className="font-mono">authorize_payment</code>, <code className="font-mono">settle_payment</code>,{" "}
          <code className="font-mono">block_payment</code>, <code className="font-mono">set_metadata</code>, and{" "}
          <code className="font-mono">delay</code>. The important one is{" "}
          <code className="font-mono">authorize_payment</code>:
        </p>
        <CodeBlock label="WorkflowAction (authorize_payment shape)">{`{
  type: "authorize_payment",
  processor?: "stripe" | "solidgate",
  fallbackProcessor?: "stripe" | "solidgate" | "none",
  threeDsMode?: "no_3ds" | "adaptive" | "frictionless",
  useCitProcessor?: boolean
}`}</CodeBlock>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          <code className="font-mono">processor</code> picks which connected integration handles the
          charge, with an optional <code className="font-mono">fallbackProcessor</code> for failover.{" "}
          <code className="font-mono">PROCESSORS</code> is currently just{" "}
          <code className="font-mono">[&quot;stripe&quot;, &quot;solidgate&quot;]</code> — matching the backend&apos;s two
          built adapters, even though PayNext&apos;s own model supports more (Braintree, PayPal, Unlimit).
        </p>
      </section>

      <section className="mb-10">
        <h2 id="3ds-modes" className="mb-3 text-lg font-semibold text-foreground">3DS modes</h2>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          <code className="font-mono">THREE_DS_MODES</code>: <code className="font-mono">no_3ds</code>,{" "}
          <code className="font-mono">adaptive</code>, <code className="font-mono">frictionless</code>.
        </p>
        <Callout tone="danger" title="Real product gap, not just a UI simplification">
          The backend maps <code className="font-mono">adaptive</code> and <code className="font-mono">
            frictionless
          </code>{" "}
          onto Stripe&apos;s <code className="font-mono">payment_method_options.card.request_three_d_secure</code>{" "}
          (<code className="font-mono">automatic</code> and <code className="font-mono">any</code>{" "}
          respectively) — but <strong className="text-foreground">Stripe has no request-level way to
          force-skip issuer-mandated 3DS</strong>. Selecting <code className="font-mono">no_3ds</code> in this
          UI, or omitting the field entirely, both just leave Stripe&apos;s parameter unset, which falls back
          to Stripe&apos;s own risk-based automatic behavior. This is called out explicitly in{" "}
          <code className="font-mono">docs/adr/0012-stripe-decline-and-3ds-audit.md</code> as &quot;a real
          product gap between what the Workflows UI&apos;s &apos;No 3DS&apos; option implies and what Stripe&apos;s API
          can actually guarantee, not a bug in the mapping.&quot; Solidgate&apos;s 3DS flow is redirect-based (a{" "}
          <code className="font-mono">verify_url</code>), not Stripe&apos;s client-secret model, so the two
          adapters don&apos;t even share a mechanism under the hood.
        </Callout>
      </section>

      <section className="mb-10">
        <h2 id="draft-vs-published" className="mb-3 text-lg font-semibold text-foreground">Draft vs. published</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          <code className="font-mono">togglePublish()</code> in <code className="font-mono">lib/workflow-store.ts</code>{" "}
          just flips a workflow&apos;s <code className="font-mono">state</code> between{" "}
          <code className="font-mono">draft</code> and <code className="font-mono">published</code> in local
          Zustand state — there is no version history, no diffing, and nothing downstream currently reads
          this flag to decide whether a workflow actually affects live routing (because nothing is wired
          to the backend at all yet). The trigger node at index 0 can never be removed, matching PayNext&apos;s
          rule that every trigger is tied to a payment method.
        </p>
      </section>

      <section id="backend-routing">
        <h2 id="backend-routing-heading" className="mb-3 text-lg font-semibold text-foreground">Backend routing (the real thing)</h2>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          The backend&apos;s actual Milestone 5 routing engine is much simpler and lives entirely in{" "}
          <code className="font-mono">src/routing/</code>.
        </p>
        <ul className="mb-3 list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
          <li>
            A <code className="font-mono">routing_rules</code> row is scoped by{" "}
            <code className="font-mono">merchant_entity_id</code> plus an optional{" "}
            <code className="font-mono">product_id</code>, with a jsonb <code className="font-mono">match</code>{" "}
            allow-list on currency / CIT-vs-MIT / payment-method-type (empty = matches anything).
          </li>
          <li>
            Rules are evaluated in ascending <code className="font-mono">priority</code> order, with
            product-specific rules breaking ties over entity-wide ones, and cached in Redis for 300 seconds
            with explicit invalidation on writes.
          </li>
          <li>
            Every write lands an audit row in <code className="font-mono">routing_rules_audit</code>. If
            nothing matches, routing falls back to the lowest-UUIDv7 enabled{" "}
            <code className="font-mono">psp_account</code>.
          </li>
        </ul>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          A per-<code className="font-mono">psp_account</code> circuit breaker (Redis-backed, fixed 60s
          window, opens after 5 failures, 30s cooldown) only ever trips on{" "}
          <code className="font-mono">technical</code>-category decline failures — never on hard declines,
          fraud, or authentication requirements, since retrying those against a different PSP wouldn&apos;t
          help.
        </p>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          A central retry policy caps same-instrument retries at 3 attempts per payment with a minimum
          2-second spacing, and refuses outright to retry hard declines or{" "}
          <code className="font-mono">review</code>-class declines.
        </p>
        <Callout tone="info" title="No admin API for routing rules yet">
          Per <code className="font-mono">docs/adr/0007-routing-rules-engine.md</code>, there are no HTTP
          admin routes for managing <code className="font-mono">routing_rules</code> today — only the
          repository-layer functions in <code className="font-mono">src/routing/rulesRepo.ts</code>. This
          Workflows UI cannot currently write to that table even if it were wired up; that&apos;s flagged
          backend-side as follow-up work.
        </Callout>
      </section>

      <section className="mt-10">
        <Card>
          <CardHeader>
            <CardTitle>Where the two models diverge</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <ul className="list-disc space-y-1.5 pl-4">
              <li>UI: linear trigger→condition→action chain. Backend: flat rule list with a match filter and priority order — no chain, no per-step actions.</li>
              <li>UI: fallback processor is per-action. Backend: fallback is per-rule (<code className="font-mono">fallback_psp_account_id</code>) and only triggered for technical failures via the circuit breaker, not a generic &quot;if declined&quot; branch.</li>
              <li>UI: no AND/OR condition groups or Split (percentage) node. Backend has neither concept either — but PayNext&apos;s real product does, so this is a simplification versus the reference model, not versus the backend.</li>
            </ul>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
