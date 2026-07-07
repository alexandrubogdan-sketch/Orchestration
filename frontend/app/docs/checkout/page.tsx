import { DocsHeader } from "@/components/docs/docs-header";
import { Callout } from "@/components/docs/callout";
import { CodeBlock } from "@/components/docs/code-block";

export default function CheckoutConfiguratorDocsPage() {
  return (
    <div>
      <DocsHeader
        eyebrow="Configuration"
        title="Checkout configurator"
        description="The Checkout tab — pick which payment methods appear at checkout, reorder them, configure per-method routing conditions, and preview the result against the real checkout SDK."
      />

      <section className="mb-10">
        <h2 id="three-columns" className="mb-3 text-lg font-semibold text-foreground">Three columns, one selection</h2>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          <code className="font-mono">app/checkout/page.tsx</code> lays out three columns that all read from
          one selection state in <code className="font-mono">lib/checkout-store.ts</code>:
        </p>
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
          <li>
            <strong className="text-foreground">Methods list</strong> — Active methods (drag-to-reorder,
            except Card, which is always active and locked) and Inactive methods. Clicking a row selects it.
          </li>
          <li>
            <strong className="text-foreground">Conditions</strong> — an enable/disable switch plus, for
            Card specifically, a reorderable list of country-match routing conditions (each with its own
            processor split) and a catch-all &quot;merchant split&quot; for traffic that matches none of them.
          </li>
          <li>
            <strong className="text-foreground">Preview</strong> — a live checkout instance reflecting
            whichever methods are currently enabled.
          </li>
        </ul>
      </section>

      <section className="mb-10">
        <h2 id="reorder" className="mb-3 text-lg font-semibold text-foreground">Drag-to-reorder</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Both the active-methods list and a method&apos;s own condition blocks use{" "}
          <code className="font-mono">framer-motion</code>&apos;s <code className="font-mono">Reorder.Group</code>/
          <code className="font-mono">Reorder.Item</code> — added as a new dependency to this frontend
          specifically for this page, rather than hand-rolling an equivalent pointer-based drag interaction,
          since matching that interaction 1:1 was a goal here and the library is small.
        </p>
      </section>

      <section className="mb-10">
        <h2 id="preview-sdk" className="mb-3 text-lg font-semibold text-foreground">The preview uses the real SDK</h2>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          Unlike the rest of this dashboard, the preview column in{" "}
          <code className="font-mono">components/checkout/checkout-preview.tsx</code> is not purely a static
          mock — it calls <code className="font-mono">loadCheckout()</code> from the real{" "}
          <code className="font-mono">@alphapayments/checkout-sdk</code> package (see{" "}
          <a href="/docs/checkout-sdk" className="font-medium text-accent-foreground underline underline-offset-2">
            Checkout SDK
          </a>
          ) and mounts a genuine <code className="font-mono">CardElement</code> with real client-side
          validation. This still never reaches a live network socket: the SDK&apos;s <code className="font-mono">
            loadCheckout()
          </code>{" "}
          accepts an injectable <code className="font-mono">fetchImpl</code>, and this page passes a tiny
          in-memory fake that answers <code className="font-mono">GET /checkout/{"{id}"}/public</code> and{" "}
          <code className="font-mono">POST /checkout/{"{id}"}/confirm</code> itself, using the SDK&apos;s{" "}
          <code className="font-mono">mock</code> PSP driver end to end.
        </p>
        <CodeBlock label="components/checkout/checkout-preview.tsx (shape)">{`const checkout = await loadCheckout({
  apiBaseUrl: "https://sandbox.internal.invalid",
  sessionId: "cs_sandbox_preview",
  clientSecret: "cs_secret_sandbox_preview",
  fetchImpl: buildFakeFetch(), // answers /public and /confirm in-memory, no network call
});

const card = checkout.createElement("card", { appearance: { colorPrimary: "#6366f1" } });
card.mount("#checkout-preview-mount");`}</CodeBlock>
      </section>

      <Callout tone="info" title="Only Card renders in the preview">
        The SDK&apos;s <code className="font-mono">mock</code> driver doesn&apos;t implement wallet/express
        checkout support (<code className="font-mono">supportsExpressCheckout()</code> returns{" "}
        <code className="font-mono">false</code>), so enabling PayPal/Apple Pay/Google Pay/Venmo/Cash App
        changes the methods list and conditions panel, but the live preview column only ever mounts a card
        element. Wiring a wallet-capable preview would mean adding a mock express-checkout path to the SDK
        itself, which was out of scope for this page.
      </Callout>

      <section className="mt-10">
        <h2 id="publish" className="mb-3 text-lg font-semibold text-foreground">Publish is a snapshot, not an API call</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          The header&apos;s <code className="font-mono">Publish</code> button (with its red unsaved-changes
          dot while dirty) calls <code className="font-mono">lib/checkout-store.ts</code>&apos;s{" "}
          <code className="font-mono">publish()</code>, which snapshots the current methods/conditions into
          the store&apos;s own &quot;last published&quot; baseline after a short fake delay — matching this
          frontend&apos;s no-live-backend convention (see{" "}
          <a href="/docs/retries#save-button-doesnt-call-the-api-yet" className="font-medium text-accent-foreground underline underline-offset-2">
            Retries &amp; dunning
          </a>{" "}
          for the same pattern). Refreshing the page resets any edits.
        </p>
      </section>
    </div>
  );
}
