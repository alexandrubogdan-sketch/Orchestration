import { DocsHeader } from "@/components/docs/docs-header";
import { Callout } from "@/components/docs/callout";
import { CodeBlock } from "@/components/docs/code-block";

export default function PlansDocsPage() {
  return (
    <div>
      <DocsHeader
        eyebrow="Configuration"
        title="Plans & billing"
        description="The billing-plan catalog: localized pricing rows and trial configuration."
      />

      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold text-foreground">Shape</h2>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          A <code className="font-mono">Plan</code> (<code className="font-mono">lib/types.ts</code>) is a
          billing interval plus a flat list of price rows, plus an optional trial:
        </p>
        <CodeBlock label="Plan">{`interface Plan {
  id: string;
  name: string;
  billingIntervalUnit: "days" | "months" | "years";
  billingIntervalCount: number;
  prices: PriceRow[];
  trial: TrialConfig;
  createdAt: string;
}

interface PriceRow {
  id: string;
  currency: string;        // e.g. "USD", "EUR", "GBP", "CAD", "AUD", "JPY"
  amountMinorUnits: number;
  country: string;         // ISO-3166 alpha-2, or "ALL"
}

interface TrialConfig {
  enabled: boolean;
  intervalUnit: "days" | "months" | "years";
  intervalCount: number;
  prices: PriceRow[];
}`}</CodeBlock>
      </section>

      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold text-foreground">Localized pricing rows</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          There is no separate localization table — a plan&apos;s <code className="font-mono">prices</code> array
          is just filtered by <code className="font-mono">country</code> at read time. Exactly one row uses
          the sentinel <code className="font-mono">country: &quot;ALL&quot;</code> (<code className="font-mono">
            DEFAULT_PRICE_COUNTRY
          </code>
          ) as the default/fallback price; every other row is a country-specific override, keyed by a
          free-text ISO-3166 alpha-2 code. For example, the seeded <code className="font-mono">
            plan-pro-monthly
          </code>{" "}
          plan has a default USD 2999 ($29.99) row plus a CAD 3399 override for <code className="font-mono">
            CA
          </code>{" "}
          and a GBP 2499 override for <code className="font-mono">GB</code>.
        </p>
      </section>

      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold text-foreground">Trial configuration</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          <code className="font-mono">trial</code> is a fully independent structure — its own{" "}
          <code className="font-mono">intervalUnit</code>/<code className="font-mono">intervalCount</code>{" "}
          (unrelated to the plan&apos;s own billing interval) and its own <code className="font-mono">
            prices: PriceRow[]
          </code>{" "}
          array, so a trial can itself carry localized, multi-currency pricing. <code className="font-mono">
            trial.enabled
          </code>{" "}
          gates whether trial pricing applies at all. The seed data has two 7/14-day trials priced at
          $0 USD for <code className="font-mono">ALL</code>, and one plan (<code className="font-mono">
            plan-pro-annual
          </code>
          ) with trials disabled entirely.
        </p>
      </section>

      <Callout tone="warning" title="Client-side state only, and modeled on PayNext" className="mb-6">
        Plan edits live in a Zustand store (<code className="font-mono">lib/plan-store.ts</code>) seeded from{" "}
        <code className="font-mono">defaultPlans()</code> in <code className="font-mono">lib/mock-data.ts</code> —
        refreshing the page resets everything. This page also replaced an earlier per-customer
        &quot;Subscriptions&quot; list and was rebuilt to match docs.paynext.com&apos;s plan-catalog model, not the
        backend&apos;s actual Milestone 8 subscriptions schema.
      </Callout>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-foreground">How this differs from the backend&apos;s subscriptions</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          The backend&apos;s <code className="font-mono">subscriptions</code> table (
          <code className="font-mono">src/subscriptions/subscriptions.ts</code>) represents a live,
          per-customer subscription instance — <code className="font-mono">merchant_entity_id</code>,{" "}
          <code className="font-mono">customer_id</code>, <code className="font-mono">payment_method_id</code>,{" "}
          <code className="font-mono">psp_account_id</code>, <code className="font-mono">amount_minor_units</code>,{" "}
          <code className="font-mono">interval_unit</code>/<code className="font-mono">interval_count</code>,{" "}
          <code className="font-mono">status</code> (<code className="font-mono">active</code> /{" "}
          <code className="font-mono">paused</code> / <code className="font-mono">past_due</code> /{" "}
          <code className="font-mono">canceled</code>), <code className="font-mono">current_period_start/end</code>,{" "}
          <code className="font-mono">next_billing_at</code>, and dunning state (
          <code className="font-mono">dunning_stage</code>, <code className="font-mono">dunning_next_retry_at</code>
          ). There is no plan-catalog concept there at all — each subscription stores its own amount and
          interval directly. This dashboard&apos;s <code className="font-mono">Plan</code> model is a
          product-catalog abstraction that the backend does not have; wiring the two together would mean
          either adding a plans table upstream of <code className="font-mono">subscriptions</code>, or
          treating this page purely as pricing documentation that a human keys into{" "}
          <code className="font-mono">subscriptions.amount_minor_units</code> by hand.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Renewals always bill the same <code className="font-mono">payment_method</code> and{" "}
          <code className="font-mono">psp_account</code> as the original subscription — there is no
          re-routing through the evaluator on renewal. Failed renewals that aren&apos;t hard/fraud declines
          enter the dunning ladder at <code className="font-mono">DUNNING_LADDER_HOURS = [24, 72, 168]</code>{" "}
          (1, 3, and 7 days) before the subscription is canceled; hard or fraud declines cancel
          immediately instead of entering dunning.
        </p>
      </section>
    </div>
  );
}
