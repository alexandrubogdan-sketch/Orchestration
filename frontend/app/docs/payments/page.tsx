import Link from "next/link";

import { Callout } from "@/components/docs/callout";
import { CodeTabs } from "@/components/docs/code-tabs";
import { DocsHeader } from "@/components/docs/docs-header";
import { DocSection, InlineCode } from "@/components/docs/prose";

const STATES = [
  { state: "created", meaning: "Recorded, not yet sent to a processor.", final: false },
  { state: "requires_action", meaning: "Waiting for the customer to finish 3-D Secure.", final: false },
  { state: "authorizing", meaning: "The processor is deciding.", final: false },
  { state: "authorized", meaning: "Funds reserved. Capture or void it.", final: false },
  { state: "capturing", meaning: "Capture requested, waiting for the processor.", final: false },
  { state: "captured", meaning: "Money taken. Fulfil the order.", final: false },
  { state: "refund_pending", meaning: "A refund is in progress.", final: false },
  { state: "refunded", meaning: "Fully refunded. Partial refunds can still follow.", final: false },
  { state: "settled", meaning: "Paid out by the processor. Can still be disputed.", final: false },
  { state: "dispute_opened", meaning: "The cardholder raised a chargeback.", final: false },
  { state: "dispute_won", meaning: "The chargeback was resolved in your favour.", final: true },
  { state: "dispute_lost", meaning: "The chargeback was lost.", final: true },
  { state: "declined", meaning: "The processor refused the payment.", final: true },
  { state: "voided", meaning: "The authorization was released.", final: true },
  { state: "failed", meaning: "A technical failure ended the payment.", final: true },
];

export default function PaymentLifecyclePage() {
  return (
    <div>
      <DocsHeader
        eyebrow="Accept payments"
        title="Payment lifecycle"
        description="Every payment follows one state machine, whichever processor handles it. Learn the states, what moves a payment between them, and how retries stay safe."
      />

      <DocSection id="states" title="Payment states">
        <p>
          A payment is always in exactly one state. States marked final never change again. Events that arrive after a
          payment is final are kept on its timeline but don&apos;t change the state.
        </p>
        <dl className="divide-y divide-border border-y border-border">
          {STATES.map((row) => (
            <div key={row.state} className="grid gap-1 py-2.5 sm:grid-cols-[11rem_1fr_auto]">
              <dt><InlineCode>{row.state}</InlineCode></dt>
              <dd className="text-sm">{row.meaning}</dd>
              <dd className="text-xs font-medium text-muted-foreground">{row.final ? "Final" : ""}</dd>
            </div>
          ))}
        </dl>
      </DocSection>

      <DocSection id="capture" title="Automatic and manual capture">
        <p>
          With <InlineCode>captureMethod: &quot;automatic&quot;</InlineCode> the payment goes straight to{" "}
          <InlineCode>captured</InlineCode>. With <InlineCode>manual</InlineCode> it stops at{" "}
          <InlineCode>authorized</InlineCode>, and you <Link href="/docs/api/capture-payment" className="font-medium text-primary hover:underline">capture</Link>{" "}
          or <Link href="/docs/api/void-payment" className="font-medium text-primary hover:underline">void</Link> it later,
          for example after checking stock.
        </p>
      </DocSection>

      <DocSection id="routing" title="Routing and fallback">
        <p>
          The workflow for the payment method decides which processor to try. A processor that keeps failing is taken
          out of rotation by a circuit breaker; after a cool-down a single trial payment checks whether it has
          recovered before traffic returns. Only technical failures fall back to another processor. A real decline from
          the bank is never retried elsewhere, because that would count against your dispute and fraud ratios.
        </p>
      </DocSection>

      <DocSection id="timeline" title="Timeline">
        <p>
          <Link href="/docs/api/retrieve-payment" className="font-medium text-primary hover:underline">Retrieving a payment</Link>{" "}
          returns every processor attempt and a timeline of events with stable names, the same names your{" "}
          <Link href="/docs/webhooks" className="font-medium text-primary hover:underline">webhooks</Link> use.
        </p>
        <CodeTabs
          samples={[
            {
              label: "timeline",
              code: JSON.stringify(
                [
                  { event: "started", occurredAt: "2026-10-19T09:12:44.130Z" },
                  { event: "authentication_required", occurredAt: "2026-10-19T09:12:44.610Z" },
                  { event: "authorized", occurredAt: "2026-10-19T09:13:02.881Z" },
                  { event: "captured", occurredAt: "2026-10-19T09:13:03.240Z" },
                ],
                null,
                2,
              ),
            },
          ]}
        />
      </DocSection>

      <DocSection id="safe-retries" title="Safe retries">
        <p>
          Send the same <InlineCode>Idempotency-Key</InlineCode> when you retry after a timeout. The API returns the
          original result instead of charging again, and the key is forwarded to the processor so a retry never creates
          a second charge there either.
        </p>
        <Callout tone="tip" title="Pick keys from your own data">
          Use something like <InlineCode>order_8841</InlineCode>, not a random value generated per request. A random key
          on each retry defeats the protection.
        </Callout>
      </DocSection>

      <DocSection id="amounts" title="Amounts">
        <p>
          Amounts are integers in the currency&apos;s smallest unit: 1999 USD is $19.99 and 1999 JPY is ¥1,999. There is
          no floating point anywhere in the API, so rounding errors can&apos;t creep in.
        </p>
      </DocSection>
    </div>
  );
}
