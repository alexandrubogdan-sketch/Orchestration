import { Callout } from "@/components/docs/callout";
import { CodeTabs } from "@/components/docs/code-tabs";
import { DocsHeader } from "@/components/docs/docs-header";
import { DocSection, InlineCode } from "@/components/docs/prose";

const EVENTS = [
  { name: "started", when: "The first processor attempt began." },
  { name: "authentication_required", when: "The customer must complete 3-D Secure." },
  { name: "authorized", when: "Funds are reserved but not captured yet." },
  { name: "captured", when: "The money is taken. Grant access here." },
  { name: "declined", when: "The processor refused the payment." },
  { name: "voided", when: "An authorization was released." },
  { name: "refund_pending", when: "A refund was requested and is in progress." },
  { name: "refunded", when: "The refund completed." },
  { name: "settled", when: "The processor paid the funds out." },
  { name: "dispute_opened", when: "The cardholder disputed the payment." },
  { name: "dispute_closed", when: "The dispute was resolved." },
];

const PAYLOAD = JSON.stringify(
  {
    id: "01929c5a-7f10-7b2e-8c4d-1a2b3c4d5e6f",
    event: "captured",
    paymentId: "01929c4e-5b7a-7c1e-9f3a-2d8e6b4a1c90",
    occurredAt: "2026-10-19T09:12:45.903Z",
    data: { amount: { minorUnits: 1999, currency: "USD" }, state: "captured" },
  },
  null,
  2,
);

const NODE_VERIFY = `import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyWebhook(rawBody: string, header: string, secret: string): boolean {
  const parts = Object.fromEntries(header.split(",").map((part) => part.split("=")));
  const timestamp = Number(parts.t);
  if (!timestamp || Math.abs(Date.now() - timestamp) > 5 * 60_000) return false;

  const expected = createHmac("sha256", secret).update(\`\${timestamp}.\${rawBody}\`).digest("hex");
  const received = Buffer.from(parts.v1 ?? "");
  return received.length === expected.length && timingSafeEqual(received, Buffer.from(expected));
}`;

const PYTHON_VERIFY = `import hmac, hashlib, time

def verify_webhook(raw_body: bytes, header: str, secret: str) -> bool:
    parts = dict(part.split("=", 1) for part in header.split(","))
    timestamp = int(parts.get("t", 0))
    if not timestamp or abs(time.time() * 1000 - timestamp) > 5 * 60_000:
        return False
    signed = f"{timestamp}.".encode() + raw_body
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get("v1", ""))`;

export default function WebhooksPage() {
  return (
    <div>
      <DocsHeader
        eyebrow="Accept payments"
        title="Webhooks"
        description="Alpha Payments posts an event to your endpoint whenever a payment changes. Use webhooks, not the API response, as the trigger for fulfilment."
      />

      <DocSection id="delivery" title="How delivery works">
        <p>
          Each event is sent as a <InlineCode>POST</InlineCode> with a JSON body to every endpoint subscribed to that event.
          Reply with any 2xx status within 10 seconds. Anything else is recorded as a failed delivery with the status code
          you returned. An event is never re-sent to an endpoint that already accepted it.
        </p>
        <p>
          Events can arrive more than once and out of order. Store the <InlineCode>id</InlineCode> from the{" "}
          <InlineCode>X-Webhook-Event-Id</InlineCode> header and skip any you have already processed.
        </p>
      </DocSection>

      <DocSection id="payload" title="Payload">
        <CodeTabs samples={[{ label: "captured", code: PAYLOAD }]} />
      </DocSection>

      <DocSection id="verify" title="Verify the signature">
        <p>
          Every request carries an <InlineCode>X-Webhook-Signature</InlineCode> header in the form{" "}
          <InlineCode>t=&lt;timestamp&gt;,v1=&lt;signature&gt;</InlineCode>. The signature is an HMAC-SHA256 of{" "}
          <InlineCode>timestamp.rawBody</InlineCode> using your endpoint&apos;s <InlineCode>whsec_</InlineCode> secret.
          Reject requests older than five minutes to stop replays.
        </p>
        <Callout tone="warning" title="Use the raw body">
          Compute the signature over the exact bytes you received. Parsing and re-serializing the JSON first changes the
          bytes and the check fails.
        </Callout>
        <CodeTabs
          samples={[
            { label: "Node.js", code: NODE_VERIFY },
            { label: "Python", code: PYTHON_VERIFY },
          ]}
        />
      </DocSection>

      <DocSection id="events" title="Event types">
        <dl className="divide-y divide-border border-y border-border">
          {EVENTS.map((event) => (
            <div key={event.name} className="grid gap-1 py-2.5 sm:grid-cols-[13rem_1fr]">
              <dt><InlineCode>{event.name}</InlineCode></dt>
              <dd className="text-sm">{event.when}</dd>
            </div>
          ))}
        </dl>
      </DocSection>

      <DocSection id="processor-webhooks" title="Processor webhooks">
        <p>
          Point each processor&apos;s webhook at <InlineCode>POST /webhooks/&lt;processor&gt;</InlineCode>, for example{" "}
          <InlineCode>/webhooks/stripe</InlineCode>. Signatures are checked against every connected account for that
          processor, duplicates are dropped, and late events are recorded on the timeline without rolling a payment back.
        </p>
      </DocSection>
    </div>
  );
}
