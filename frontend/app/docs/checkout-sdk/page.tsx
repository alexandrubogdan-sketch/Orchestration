import { DocsHeader } from "@/components/docs/docs-header";
import { Callout } from "@/components/docs/callout";
import { CodeBlock } from "@/components/docs/code-block";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default function CheckoutSdkDocsPage() {
  return (
    <div>
      <DocsHeader
        eyebrow="Core payments"
        title="Checkout SDK"
        description="The browser-embeddable @alphapayments/checkout-sdk package and the checkout-sessions backend contract it talks to — a Stripe.js/Elements-shaped API that works across Stripe, Solidgate, and the mock adapter."
      />

      <Callout tone="info" title="A separate package, not part of this dashboard" className="mb-8">
        The SDK lives in its own repo (<code className="font-mono">payment-orchestrator-sdk/</code>), built
        and tested independently of this frontend. Nothing on this page or in this dashboard consumes it —
        it is what a merchant&apos;s <em>own</em> checkout page would import to collect a card and confirm a
        payment, not something rendered inside Alpha Payments itself.
      </Callout>

      <section className="mb-10">
        <h2 id="five-hops" className="mb-3 text-lg font-semibold text-foreground">Five hops, three owned by the SDK</h2>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          A checkout session flows through five hops; the SDK owns only the last three:
        </p>
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
          <li>
            <strong className="text-foreground">Merchant server → Alpha Payments server.</strong> The
            merchant&apos;s own backend calls <code className="font-mono">POST /v1/checkout-sessions</code>{" "}
            with its private Bearer key (never exposed to the browser) and gets back{" "}
            <code className="font-mono">{"{ id, clientSecret, expiresAt, amount }"}</code>.
          </li>
          <li>
            <strong className="text-foreground">Merchant server → merchant frontend.</strong> That{" "}
            <code className="font-mono">id</code>/<code className="font-mono">clientSecret</code> pair is
            sent down to the merchant&apos;s own page. The SDK never sees the private Bearer key.
          </li>
          <li>
            <strong className="text-foreground">SDK → Alpha Payments (public config).</strong>{" "}
            <code className="font-mono">loadCheckout(...)</code> calls the unauthenticated{" "}
            <code className="font-mono">GET /checkout/{"{id}"}/public</code> to learn the session&apos;s
            amount, status, and active PSP (<code className="font-mono">stripe</code> /{" "}
            <code className="font-mono">solidgate</code> / <code className="font-mono">mock</code>) plus
            that PSP&apos;s publishable key.
          </li>
          <li>
            <strong className="text-foreground">SDK → PSP&apos;s own client-side tokenization.</strong> Based
            on the active PSP, the SDK loads that PSP&apos;s own client-side script (Stripe: the real{" "}
            <code className="font-mono">js.stripe.com/v3</code>) and tokenizes the card directly with the
            PSP — raw card data never touches the merchant&apos;s server or this SDK&apos;s own backend calls.
          </li>
          <li>
            <strong className="text-foreground">SDK → Alpha Payments (confirm) → optional automatic 3DS.</strong>{" "}
            The resulting token is POSTed to <code className="font-mono">POST /checkout/{"{id}"}/confirm</code>.
            If the PSP demands further authentication, the SDK drives that challenge itself and re-confirms
            — by default the integrator&apos;s own code never needs to know 3DS happened.
          </li>
        </ol>
      </section>

      <section className="mb-10">
        <h2 id="quick-start" className="mb-3 text-lg font-semibold text-foreground">Quick start</h2>
        <CodeBlock label="checkout.ts">{`import { loadCheckout } from "@alphapayments/checkout-sdk";

const checkout = await loadCheckout({
  apiBaseUrl: "https://api.example.com",
  sessionId: session.id,
  clientSecret: session.clientSecret,
});

const card = checkout.createElement("card", {
  appearance: { colorPrimary: "#6366f1", borderRadius: "10px" },
});
card.mount("#card-container");

card.on("change", (state) => {
  submitButton.disabled = !state.complete;
  errorEl.textContent = state.error ?? "";
});

// One-click Apple Pay / Google Pay — auto-hides if the active driver
// or browser doesn't support it.
const expressCheckout = checkout.createElement("expressCheckout");
expressCheckout.mount("#express-checkout-container");

const result = await checkout.confirm({ element: card });
// result.status: "succeeded" | "requires_action" | "error"`}</CodeBlock>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          React bindings ship at a separate entry point,{" "}
          <code className="font-mono">@alphapayments/checkout-sdk/react</code> (
          <code className="font-mono">CheckoutProvider</code>, <code className="font-mono">CardElement</code>,{" "}
          <code className="font-mono">useCheckout()</code>), wrapping the same underlying{" "}
          <code className="font-mono">CheckoutSession</code>.
        </p>
      </section>

      <section className="mb-10">
        <h2 id="public-api" className="mb-3 text-lg font-semibold text-foreground">Public API surface</h2>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          Everything exported from <code className="font-mono">src/index.ts</code>:
        </p>
        <CodeBlock label="@alphapayments/checkout-sdk">{`loadCheckout(options: LoadCheckoutOptions): Promise<CheckoutSession>
class CheckoutSession {
  createElement(type: "card" | "expressCheckout", options?): CardElement | ExpressCheckoutElement;
  confirm(options: ConfirmOptions): Promise<ConfirmResult>;
}

type ConfirmResult =
  | { status: "succeeded"; payment: Payment }
  | { status: "requires_action" }
  | { status: "error"; error: { message: string; code?: string } };

class CardElement { mount(selector); on("change", handler); unmount(); }
class ExpressCheckoutElement { mount(selector); }

// Errors
CheckoutSessionNotFoundError, CheckoutSessionClosedError, CheckoutApiError

// Appearance theming
type Appearance; const DEFAULT_APPEARANCE

// Classifies a raw payment/attempt status into a UI-friendly bucket
classifyPaymentState(input: ClassifyPaymentStateInput): PaymentStateClassification`}</CodeBlock>
      </section>

      <section className="mb-10">
        <h2 id="backend-contract" className="mb-3 text-lg font-semibold text-foreground">The backend contract it talks to</h2>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          Three routes in <code className="font-mono">payment-orchestrator-go/internal/api/checkout_sessions.go</code>{" "}
          back this SDK — the checkout-sessions resource:
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle>Create session</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <div>
                <Badge tone="accent" className="mr-2 font-mono normal-case">POST</Badge>
                <code className="font-mono text-xs">/v1/checkout-sessions</code>
              </div>
              <p>
                Bearer-authenticated (merchant&apos;s private key). Resolves the customer and routing once,
                creates the session row, and returns the plaintext{" "}
                <code className="font-mono">clientSecret</code> exactly once — only its SHA-256 hash is ever
                persisted or returned again.
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Public config</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <div>
                <Badge tone="accent" className="mr-2 font-mono normal-case">GET</Badge>
                <code className="font-mono text-xs">/checkout/{"{id}"}/public</code>
              </div>
              <p>
                Unauthenticated — the caller is the end user&apos;s browser, which structurally cannot hold a
                Bearer token. Returns amount, status, PSP name, and that PSP&apos;s publishable key only.
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Confirm</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <div>
                <Badge tone="accent" className="mr-2 font-mono normal-case">POST</Badge>
                <code className="font-mono text-xs">/checkout/{"{id}"}/confirm</code>
              </div>
              <p>
                Also unauthenticated — gated instead by possession of the session&apos;s{" "}
                <code className="font-mono">clientSecret</code> (constant-time compared against its stored
                hash). Runs the same attempt-creation flow as{" "}
                <code className="font-mono">POST /v1/payments</code>.
              </p>
            </CardContent>
          </Card>
        </div>
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
          Sessions expire 15 minutes after creation (<code className="font-mono">checkoutSessionTTL</code>) —
          long enough to fill in card details and clear a 3DS challenge, short enough that a leaked client
          secret has a short useful life.
        </p>
      </section>

      <Callout tone="warning" title="Routing quirk, flagged in the backend's own source">
        The two browser-facing routes live at a sibling path prefix — <code className="font-mono">
          /checkout/{"{id}"}/public
        </code>{" "}
        and <code className="font-mono">/checkout/{"{id}"}/confirm</code> — rather than nested under{" "}
        <code className="font-mono">/v1/checkout-sessions/{"{id}"}/...</code>, even though that would read
        more RESTfully. The Go source&apos;s own comment on <code className="font-mono">
          registerPublicCheckoutSessionRoutes
        </code>{" "}
        explains why: this port&apos;s author wasn&apos;t confident, without a working compiler to check, that
        chi&apos;s router lets an unauthenticated literal path coexist cleanly with <code className="font-mono">
          /v1
        </code>{" "}
        being mounted as its own authenticated sub-router one level up. A disjoint top-level prefix
        sidesteps the question at the cost of a slightly less RESTful URL — flagged as something to
        re-verify once a real Go toolchain confirms the nested form would also route correctly.
      </Callout>

      <section className="mt-10">
        <h2 id="drivers" className="mb-3 text-lg font-semibold text-foreground">One driver per PSP</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          <code className="font-mono">src/drivers/</code> has one driver per PSP — <code className="font-mono">
            stripe-driver.ts
          </code>
          , <code className="font-mono">solidgate-driver.ts</code>, and{" "}
          <code className="font-mono">mock-driver.ts</code> — behind a shared internal interface, mirroring
          the backend&apos;s own <code className="font-mono">PspAdapter</code> isolation principle (see{" "}
          <a href="/docs/adapters" className="font-medium text-accent-foreground underline underline-offset-2">
            PSP adapters &amp; declines
          </a>
          ) one layer up in the stack: this SDK&apos;s public API never leaks a PSP-specific type, only the
          shared <code className="font-mono">CardElementChangeState</code>/<code className="font-mono">
            ConfirmResult
          </code>{" "}
          shapes. The mock driver exists so integration tests (and a merchant&apos;s own sandbox) can exercise
          the full checkout flow without a real Stripe/Solidgate account.
        </p>
      </section>
    </div>
  );
}
