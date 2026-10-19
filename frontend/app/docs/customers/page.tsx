import Link from "next/link";

import { DocsHeader } from "@/components/docs/docs-header";
import { DocSection, InlineCode } from "@/components/docs/prose";

export default function CustomersDocsPage() {
  return (
    <div>
      <DocsHeader
        eyebrow="Accept payments"
        title="Customers"
        description="A customer is the person paying, with the payment methods they have saved. Customers belong to a legal entity, so every product under that entity shares them."
      />

      <DocSection id="creating" title="Creating customers">
        <p>
          You don&apos;t need a separate call. Send <InlineCode>customerEmail</InlineCode> when you{" "}
          <Link href="/docs/api/create-payment" className="font-medium text-primary hover:underline">create a payment</Link>{" "}
          and the customer is found or created by email. Send <InlineCode>customerId</InlineCode> instead to charge a
          customer you already know.
        </p>
        <p>
          A <InlineCode>customerId</InlineCode> from another legal entity returns 404, so one company&apos;s products can
          never charge another company&apos;s customers.
        </p>
      </DocSection>

      <DocSection id="payment-methods" title="Saved payment methods">
        <p>
          Successful payments save their payment method against the customer. Subscription renewals charge that saved
          method as merchant-initiated transactions, passing the original network transaction ID when the processor
          provided one.
        </p>
        <p>
          <Link href="/docs/api/list-payment-methods" className="font-medium text-primary hover:underline">List a customer&apos;s payment methods</Link>{" "}
          to show cards on an account page. Only the brand and last four digits are returned. Card numbers never reach
          Alpha Payments.
        </p>
      </DocSection>

      <DocSection id="card-updates" title="Card updates">
        <p>
          When a processor reports a reissued card through its account updater, the saved payment method is updated in
          place, so the next renewal uses the new card without the customer doing anything.
        </p>
      </DocSection>
    </div>
  );
}
