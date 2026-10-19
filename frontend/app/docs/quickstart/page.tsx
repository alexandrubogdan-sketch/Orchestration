import Link from "next/link";

import { Callout } from "@/components/docs/callout";
import { CodeTabs } from "@/components/docs/code-tabs";
import { DocsHeader } from "@/components/docs/docs-header";
import { InlineCode, Step, Steps } from "@/components/docs/prose";
import { curlSample, findEndpoint, nodeSample, pythonSample } from "@/lib/api-reference";

const create = findEndpoint("create-payment")!;

export default function QuickstartPage() {
  return (
    <div>
      <DocsHeader
        eyebrow="Get started"
        title="Quickstart"
        description="Create an API key, take a card with the Checkout SDK, charge it, and confirm the result."
      />

      <Steps>
        <Step id="create-a-key" title="Create an API key">
          <p>
            Open <Link href="/developers" className="font-medium text-primary hover:underline">Developers</Link> in the
            dashboard and select <strong className="text-foreground">Create key</strong>. For a server that charges
            customers, choose <strong className="text-foreground">Full access</strong>. Copy the key when it appears,
            because it is shown only once.
          </p>
          <CodeTabs samples={[{ label: "Shell", code: `export ALPHA_API_URL="https://<your-api-host>"\nexport ALPHA_API_KEY="po_..."` }]} />
        </Step>

        <Step id="collect-card" title="Collect the card in the browser">
          <p>
            Use your processor&apos;s client library so card numbers never touch your servers. With Stripe, create a
            payment method from a card element and send its ID to your server as the{" "}
            <InlineCode>paymentMethodRef</InlineCode>.
          </p>
          <CodeTabs
            samples={[
              {
                label: "JavaScript",
                code: `const stripe = Stripe("pk_test_...");
const card = stripe.elements().create("card");
card.mount("#card");

const { paymentMethod, error } = await stripe.createPaymentMethod({ type: "card", card });
await fetch("/pay", { method: "POST", body: JSON.stringify({ paymentMethodRef: paymentMethod.id }) });`,
              },
            ]}
          />
        </Step>

        <Step id="charge" title="Charge it from your server">
          <p>
            Send the payment method to <InlineCode>POST /v1/payments</InlineCode> with an{" "}
            <InlineCode>Idempotency-Key</InlineCode> that is unique to the order. Retrying with the same key never charges
            twice.
          </p>
          <CodeTabs
            samples={[
              { label: "cURL", code: curlSample(create) },
              { label: "Node.js", code: nodeSample(create) },
              { label: "Python", code: pythonSample(create) },
            ]}
          />
        </Step>

        <Step id="handle-result" title="Handle the result">
          <p>
            A <InlineCode>captured</InlineCode> state means the money is taken. <InlineCode>requires_action</InlineCode>{" "}
            comes with a <InlineCode>clientSecret</InlineCode>: hand it to the SDK to run 3-D Secure. A{" "}
            <InlineCode>declined</InlineCode> payment carries a normalized decline code you can show the customer.
          </p>
          <Callout tone="tip" title="Rely on webhooks for the final word">
            Some payment methods settle later. Subscribe to <Link href="/docs/webhooks" className="font-medium text-primary hover:underline">webhooks</Link>{" "}
            and grant access when the <InlineCode>captured</InlineCode> event arrives.
          </Callout>
        </Step>
      </Steps>
    </div>
  );
}
