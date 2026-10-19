import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import { CodeTabs } from "@/components/docs/code-tabs";
import { DocSection } from "@/components/docs/prose";

const PATHS = [
  { href: "/docs/quickstart", title: "Quickstart", body: "Create a key and charge your first payment in about five minutes." },
  { href: "/docs/api", title: "API reference", body: "Every endpoint with request and response examples in cURL, Node.js and Python." },
  { href: "/docs/checkout-sdk", title: "Checkout SDK", body: "Drop-in card and wallet fields with automatic 3-D Secure." },
  { href: "/docs/webhooks", title: "Webhooks", body: "Get told when a payment is captured, refunded or disputed, with signed payloads." },
  { href: "/docs/workflows", title: "Workflows", body: "Route each payment method to the right processor with fallbacks, without code." },
  { href: "/docs/retries", title: "Retries & dunning", body: "Recover failed renewals with decline-aware retry ladders." },
];

const CONCEPTS = [
  { term: "Payment", text: "One charge, followed through every processor attempt until it lands in a final state." },
  { term: "Attempt", text: "A single call to one processor. A payment that falls back to a second processor has two." },
  { term: "Customer", text: "Who pays, with their saved payment methods. Scoped to your merchant entity." },
  { term: "Workflow", text: "The rules that decide which processor handles a payment and what happens when it fails." },
  { term: "Subscription", text: "A recurring charge that bills on its original processor and hands failures to dunning." },
  { term: "API key", text: "A secret with scopes such as payments:read, so each system gets only the access it needs." },
];

export default function DocsOverviewPage() {
  return (
    <div>
      <div className="mb-14">
        <h1 className="max-w-2xl text-4xl font-semibold leading-[1.1] tracking-tight text-foreground">
          One API in front of every processor you use.
        </h1>
        <p className="mt-4 max-w-xl text-[17px] leading-relaxed text-muted-foreground">
          Alpha Payments sends each payment to the right processor, falls back when one is down, retries renewals that
          fail, and keeps one record of every attempt. Stripe, Solidgate and PayPal are connected today.
        </p>
        <div className="mt-8 max-w-xl">
          <CodeTabs
            title="Charge a card"
            samples={[
              {
                label: "cURL",
                code: `curl -X POST "$ALPHA_API_URL/v1/payments" \\
  -H "Authorization: Bearer $ALPHA_API_KEY" \\
  -H "Idempotency-Key: order_8841" \\
  -H "Content-Type: application/json" \\
  -d '{
    "customerEmail": "jane@example.com",
    "amount": { "minorUnits": 1999, "currency": "USD" },
    "paymentMethodRef": "pm_1Q2w3E4r5T6y7U8i"
  }'`,
              },
            ]}
          />
        </div>
      </div>

      <DocSection id="start-here" title="Start here">
        <div className="grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2">
          {PATHS.map((path) => (
            <Link key={path.href} href={path.href} className="group bg-card p-5 transition-colors hover:bg-neutral-bg">
              <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                {path.title}
                <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
              </span>
              <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">{path.body}</span>
            </Link>
          ))}
        </div>
      </DocSection>

      <DocSection id="how-it-works" title="How a payment flows">
        <p>
          Your server creates a payment with a payment method from the Checkout SDK. The workflow for that payment method
          picks a processor. If the processor answers, the payment moves to <code className="font-mono text-foreground">captured</code>,{" "}
          <code className="font-mono text-foreground">requires_action</code> or <code className="font-mono text-foreground">declined</code>.
          If the processor is unreachable, the circuit breaker takes it out of rotation and the next healthy processor
          gets the payment instead. Processor webhooks are verified, de-duplicated and applied in order, and your own
          webhook endpoint is notified with a signed event.
        </p>
      </DocSection>

      <DocSection id="concepts" title="Core concepts">
        <dl className="divide-y divide-border border-y border-border">
          {CONCEPTS.map((concept) => (
            <div key={concept.term} className="grid gap-1 py-3 sm:grid-cols-[9rem_1fr]">
              <dt className="text-sm font-semibold text-foreground">{concept.term}</dt>
              <dd className="text-sm">{concept.text}</dd>
            </div>
          ))}
        </dl>
      </DocSection>
    </div>
  );
}
