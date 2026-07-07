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
        <h2 id="shape" className="mb-3 text-lg font-semibold text-foreground">Shape</h2>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          A <code className="font-mono">Plan</code> (<code className="font-mono">lib/types.ts</code>) is a
          recurring-vs-one-off type flag, a base price row list, a multi-country override-rule list, a
          mirrored trial block, and a tax-collection mode:
        </p>
        <CodeBlock label="Plan">{`interface Plan {
  id: string;
  name: string;
  type: "recurring" | "one-off";
  billingIntervalUnit: "days" | "months" | "years";
  billingIntervalCount: number;
  prices: PriceRow[];              // base price, one row per country + one "ALL" default
  rules: PriceOverrideRule[];      // richer override list, one rule per group of countries
  trial: TrialConfig;
  taxCollection: "global" | "enabled" | "disabled";
  createdAt: string;
  updatedAt: string;
}

interface PriceRow {
  id: string;
  currency: string;        // e.g. "USD", "EUR", "GBP", "CAD", "AUD", "JPY"
  amountMinorUnits: number;
  country: string;         // ISO-3166 alpha-2, or "ALL"
}

interface PriceOverrideRule {
  id: string;
  currency: string;
  countries: string[];     // ISO-3166 alpha-2 codes this rule applies to
  amountMinorUnits: number;
}

interface TrialConfig {
  enabled: boolean;
  intervalUnit: "days" | "months" | "years";
  intervalCount: number;
  prices: PriceRow[];
  rules: PriceOverrideRule[];      // mirrors the plan-level rules, for trial pricing
}`}</CodeBlock>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          A <code className="font-mono">one-off</code> plan is a single charge with no billing interval and
          no trial — <code className="font-mono">type</code> is the only field that changes what the rest of
          the shape means, not a separate variant type.
        </p>
      </section>

      <section className="mb-10">
        <h2 id="localized-pricing-rows" className="mb-3 text-lg font-semibold text-foreground">Two ways to override price by country</h2>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          <code className="font-mono">prices</code> is the original one-row-per-country editor, kept as-is
          for the base price and trial price: exactly one row uses the sentinel{" "}
          <code className="font-mono">country: &quot;ALL&quot;</code> (<code className="font-mono">
            DEFAULT_PRICE_COUNTRY
          </code>
          ) as the default/fallback price, and every other row is a single country-specific override.
        </p>
        <p className="text-sm leading-relaxed text-muted-foreground">
          <code className="font-mono">rules</code> is additive, richer, and newer: one{" "}
          <code className="font-mono">PriceOverrideRule</code> applies to a <em>list</em> of countries at
          once — &quot;these 5 countries all pay EUR 9.99&quot; is one rule, not five{" "}
          <code className="font-mono">PriceRow</code> entries. The two lists are not mutually exclusive; a
          plan can have both a per-country <code className="font-mono">prices</code> override and a
          multi-country <code className="font-mono">rules</code> override at once — which one a given
          request should resolve to first is left to the reader, since neither the frontend nor the backend
          currently reads either list for anything but display.
        </p>
      </section>

      <section className="mb-10">
        <h2 id="trial-configuration" className="mb-3 text-lg font-semibold text-foreground">Trial configuration</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          <code className="font-mono">trial</code> is a fully independent structure — its own{" "}
          <code className="font-mono">intervalUnit</code>/<code className="font-mono">intervalCount</code>{" "}
          (unrelated to the plan&apos;s own billing interval) and its own{" "}
          <code className="font-mono">prices</code>/<code className="font-mono">rules</code> pair, mirroring
          the plan-level shape exactly, so a trial can carry the same localized, multi-currency,
          multi-country pricing the plan itself can. <code className="font-mono">trial.enabled</code> gates
          whether trial pricing applies at all.
        </p>
      </section>

      <section className="mb-10">
        <h2 id="tax-collection" className="mb-3 text-lg font-semibold text-foreground">Tax collection mode</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          <code className="font-mono">taxCollection</code> is one of three values: <code className="font-mono">
            global
          </code>{" "}
          defers to an account-level default (not modeled anywhere in this frontend — there is no
          account-settings page for it), while <code className="font-mono">enabled</code>/{" "}
          <code className="font-mono">disabled</code> force tax collection on or off for this plan
          specifically, overriding whatever the (unmodeled) global default would be.
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
        <h2 id="how-this-differs" className="mb-3 text-lg font-semibold text-foreground">How this differs from the backend&apos;s subscriptions</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          The backend&apos;s <code className="font-mono">subscriptions</code> table (
          <code className="font-mono">src/subscriptions/subscriptions.ts</code>) represents a live,
          per-customer subscription instance, not a plan-catalog entry:
        </p>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
          <li>
            Its own <code className="font-mono">merchant_entity_id</code>, <code className="font-mono">customer_id</code>,{" "}
            <code className="font-mono">payment_method_id</code>, <code className="font-mono">psp_account_id</code>, and{" "}
            <code className="font-mono">amount_minor_units</code>.
          </li>
          <li>
            <code className="font-mono">status</code> of <code className="font-mono">active</code> /{" "}
            <code className="font-mono">paused</code> / <code className="font-mono">past_due</code> /{" "}
            <code className="font-mono">canceled</code>, plus{" "}
            <code className="font-mono">current_period_start/end</code> and{" "}
            <code className="font-mono">next_billing_at</code>.
          </li>
          <li>
            Dunning state: <code className="font-mono">dunning_stage</code>,{" "}
            <code className="font-mono">dunning_next_retry_at</code>.
          </li>
        </ul>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          There is no plan-catalog concept there at all — each subscription stores its own amount and
          interval directly. This dashboard&apos;s <code className="font-mono">Plan</code> model is a
          product-catalog abstraction the backend does not have; wiring the two together would mean either
          adding a plans table upstream of <code className="font-mono">subscriptions</code>, or treating
          this page purely as pricing documentation that a human keys into{" "}
          <code className="font-mono">subscriptions.amount_minor_units</code> by hand.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Renewals always bill the same <code className="font-mono">payment_method</code> and{" "}
          <code className="font-mono">psp_account</code> as the original subscription — there is no
          re-routing through the evaluator on renewal.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Failed renewals that aren&apos;t hard/fraud declines enter the dunning ladder at{" "}
          <code className="font-mono">DUNNING_LADDER_HOURS = [24, 72, 168]</code> (1, 3, and 7 days) before
          the subscription is canceled. Hard or fraud declines cancel immediately instead of entering
          dunning.
        </p>
      </section>
    </div>
  );
}
