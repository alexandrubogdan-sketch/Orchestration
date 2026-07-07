import { DocsHeader } from "@/components/docs/docs-header";
import { Callout } from "@/components/docs/callout";
import { CodeBlock } from "@/components/docs/code-block";
import { Badge } from "@/components/ui/badge";

export default function CustomersDocsPage() {
  return (
    <div>
      <DocsHeader
        eyebrow="Core payments"
        title="Customers"
        description="The customer record and its saved payment methods, and the one real endpoint this dashboard's Customers tab is modeled on."
      />

      <section className="mb-10">
        <h2 id="shape" className="mb-3 text-lg font-semibold text-foreground">Shape</h2>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          A <code className="font-mono">Customer</code> (<code className="font-mono">lib/types.ts</code>) is
          scoped to one of the two legal entities and carries its saved payment methods inline:
        </p>
        <CodeBlock label="Customer">{`interface Customer {
  id: string;
  merchantEntity: "US-LLC" | "EU-BV";
  email: string;
  externalRef?: string;    // the product's own id for this customer, if supplied
  country: string;         // derived from the customer's payments' issuer/customer country
  city?: string;
  createdAt: string;
  paymentMethods: CustomerPaymentMethod[];
}

interface CustomerPaymentMethod {
  id: string;
  type: PaymentMethodKind;
  pspAccount: string;
  isActive: boolean;
  cardBrand?: string;   // card-type only — display-safe PSP metadata
  cardLast4?: string;
  cardExpMonth?: number;
  cardExpYear?: number;
}`}</CodeBlock>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          <code className="font-mono">externalRef</code> mirrors the backend&apos;s{" "}
          <code className="font-mono">customers.external_ref</code> column — the product&apos;s own id for
          this customer, kept alongside our internal UUID rather than replacing it.
        </p>
      </section>

      <section className="mb-10">
        <h2 id="shared-across-products" className="mb-3 text-lg font-semibold text-foreground">
          Payment methods are shared across products, not per-product
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          A customer&apos;s saved payment methods are scoped by{" "}
          <code className="font-mono">merchant_entity_id</code>, not by product — the same saved card is
          reusable by any product under the same legal entity (<code className="font-mono">US-LLC</code> or{" "}
          <code className="font-mono">EU-BV</code>), matching the real backend&apos;s own comment on this
          exact design choice.
        </p>
      </section>

      <section className="mb-10">
        <h2 id="real-backend-endpoint" className="mb-3 text-lg font-semibold text-foreground">
          The one real backend endpoint
        </h2>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          <code className="font-mono">GET /v1/customers/:id/payment-methods</code> (
          <code className="font-mono">payment-orchestrator-go/internal/api/customers.go</code>) is
          Bearer-authenticated and scoped by <code className="font-mono">auth.MerchantEntityID</code> — it
          looks up the customer, 404s if it doesn&apos;t belong to the caller&apos;s entity, then returns every{" "}
          <code className="font-mono">is_active = true</code> row from <code className="font-mono">
            payment_methods
          </code>
          :
        </p>
        <CodeBlock label="GET /v1/customers/:id/payment-methods">{`-> 200 { "data": [ { id, type, pspAccount, cardBrand?, cardLast4?, ... } ] }
-> 404 if the customer doesn't exist or belongs to a different merchant entity`}</CodeBlock>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          There is no create/update/delete customer or payment-method route yet — customers and payment
          methods are written by the payments pipeline itself (a new customer/payment method is created as
          a side effect of a payment attempt), not through a dedicated CRUD API.
        </p>
      </section>

      <Callout tone="warning" title="This dashboard's Customers tab is mock data">
        Like every other page in this app, the Customers tab (<code className="font-mono">app/customers/</code>)
        renders deterministic mock data from <code className="font-mono">lib/mock-data.ts</code> — it does
        not call <code className="font-mono">GET /v1/customers/:id/payment-methods</code> or any other
        backend route. The <code className="font-mono">Customer</code>/<code className="font-mono">
          CustomerPaymentMethod
        </code>{" "}
        shapes above were, however, built to match the real endpoint&apos;s response fields rather than
        invented independently, so wiring this tab up later is a fetch-and-map job, not a schema redesign.
      </Callout>

      <section className="mt-10">
        <h2 id="detail-page" className="mb-3 text-lg font-semibold text-foreground">Customer detail page</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          <code className="font-mono">app/customers/[id]/page.tsx</code> shows one customer&apos;s profile,
          saved payment methods, and — reusing the same timeline component as the Payments page — every
          payment they&apos;ve made, filtered client-side from the same mock payments list rather than a
          separate <code className="font-mono">customer_id</code>-scoped fetch.
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Badge tone="neutral" className="font-mono normal-case">US-LLC</Badge>
          <Badge tone="neutral" className="font-mono normal-case">EU-BV</Badge>
        </div>
      </section>
    </div>
  );
}
