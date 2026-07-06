import { DocsHeader } from "@/components/docs/docs-header";
import { Callout } from "@/components/docs/callout";
import { CodeBlock } from "@/components/docs/code-block";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default function IntegrationsDocsPage() {
  return (
    <div>
      <DocsHeader
        eyebrow="Configuration"
        title="Integrations"
        description="Per-processor credential fields for Stripe and Solidgate, and exactly how much of 'connecting' one is real."
      />

      <Callout tone="danger" title="Connecting an integration doesn't call a real backend" className="mb-8">
        The Connect flow (<code className="font-mono">lib/integration-store.ts</code>) masks whatever you
        paste into local Zustand state and flips the integration&apos;s status to{" "}
        <code className="font-mono">connected</code>. Nothing is sent over the network, there is no OAuth or
        API-key exchange, and no backend endpoint exists yet to persist processor credentials — the
        backend&apos;s <code className="font-mono">psp_accounts</code> table and its{" "}
        <code className="font-mono">secret_ref</code> pattern (see{" "}
        <code className="font-mono">src/adapters/stripe/credentials.ts</code>) are configured today only via
        environment variables read at process boot (<code className="font-mono">src/config/schema.ts</code>),
        not through any UI.
      </Callout>

      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold text-foreground">Credential fields per processor</h2>
        <p className="mb-4 text-sm leading-relaxed text-muted-foreground">
          <code className="font-mono">PROCESSOR_CREDENTIAL_FIELDS</code> in <code className="font-mono">
            lib/types.ts
          </code>{" "}
          defines exactly which fields the Connect dialog asks for, per processor:
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Stripe</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <FieldRow label="Publishable key" placeholder="pk_test_..." secret={false} env="STRIPE_PUBLISHABLE_KEY" />
              <FieldRow label="Secret key" placeholder="sk_test_..." secret env="STRIPE_SECRET_KEY" />
              <FieldRow label="Webhook signing secret" placeholder="whsec_..." secret env="STRIPE_WEBHOOK_SECRET" />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Solidgate</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <FieldRow label="Public key" placeholder="api_pk_..." secret={false} env="SOLIDGATE_PUBLIC_KEY" />
              <FieldRow label="Secret key" placeholder="api_sk_..." secret env="SOLIDGATE_SECRET_KEY" />
              <FieldRow label="Webhook public key" placeholder="wh_pk_..." secret={false} env="SOLIDGATE_WEBHOOK_PUBLIC_KEY" />
              <FieldRow label="Webhook secret key" placeholder="wh_sk_..." secret env="SOLIDGATE_WEBHOOK_SECRET_KEY" />
            </CardContent>
          </Card>
        </div>
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
          Each field carries a <code className="font-mono">secret: boolean</code> flag driving whether the
          value is masked in the UI (<code className="font-mono">credentialPreviews</code> keeps only the
          last 4 characters, prefixed with <code className="font-mono">••••</code>, for secret fields — non-secret
          fields are shown in full). The env-var names above are the real backend config keys these values
          map to conceptually; the UI does not currently write to them.
        </p>
      </section>

      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold text-foreground">Sandbox vs. production mode</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Both the frontend&apos;s <code className="font-mono">IntegrationMode</code> and the backend&apos;s real{" "}
          <code className="font-mono">psp_accounts.mode</code> column use the same{" "}
          <code className="font-mono">&quot;sandbox&quot; | &quot;production&quot;</code> enum (
          <code className="font-mono">docs/adr/0005-sandbox-production-mode.md</code>). On the backend, mode
          is per-account rather than a process-wide flag, so one process can hold both a sandbox and a
          production Stripe account simultaneously. At boot, the backend validates that{" "}
          <code className="font-mono">STRIPE_SECRET_KEY</code>/<code className="font-mono">
            STRIPE_PUBLISHABLE_KEY
          </code>{" "}
          prefixes (<code className="font-mono">sk_test_</code>/<code className="font-mono">pk_test_</code> vs.{" "}
          <code className="font-mono">sk_live_</code>/<code className="font-mono">pk_live_</code>) match the
          declared <code className="font-mono">STRIPE_MODE</code> — a mismatch fails config validation
          immediately rather than silently misrouting live traffic.
        </p>
      </section>

      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold text-foreground">Statement descriptors</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          An <code className="font-mono">Integration</code> can carry a list of{" "}
          <code className="font-mono">descriptors</code> — the billing-statement text customers see on their
          card statement. In the backend, this maps to <code className="font-mono">
            CreatePaymentInput.statementDescriptor
          </code>{" "}
          (<code className="font-mono">src/adapters/types.ts</code>), which Stripe forwards as-is and which
          Solidgate falls back to <code className="font-mono">order_description</code> from if unset. The
          seeded Stripe integration carries two example descriptors, <code className="font-mono">
            &quot;ACME DIGITAL&quot;
          </code>{" "}
          and <code className="font-mono">&quot;ACME* SUBSCRIPTION&quot;</code> — these same descriptor strings
          are the join key the{" "}
          <a href="/docs/risk-monitoring" className="font-medium text-accent-foreground underline underline-offset-2">
            Risk Monitoring
          </a>{" "}
          page filters by, since VAMP/Mastercard chargeback-monitoring programs track ratios per billing
          descriptor, not per processor account.
        </p>
      </section>

      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold text-foreground">Why Stripe and Solidgate specifically</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          These are the only two PSPs the backend has actually implemented adapters for (see{" "}
          <a href="/docs/adapters" className="font-medium text-accent-foreground underline underline-offset-2">
            PSP adapters &amp; declines
          </a>
          ). <code className="font-mono">ProcessorId</code> in this frontend is intentionally restricted to{" "}
          <code className="font-mono">[&quot;stripe&quot;, &quot;solidgate&quot;]</code> to match, even though PayNext&apos;s
          own reference model (which this UI is otherwise modeled on) supports Braintree, PayPal, and
          Unlimit too.
        </p>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-foreground">Request signing differs by processor</h2>
        <CodeBlock label="Stripe vs. Solidgate webhook verification">{`Stripe:
  header: stripe-signature
  scheme: HMAC-SHA256, Stripe SDK's webhooks.constructEvent()

Solidgate:
  headers: merchant, signature, solidgate-event-id, solidgate-event-created-at
  scheme: base64( hex( HMAC-SHA512(secretKey, publicKey + jsonBody + publicKey) ) )
          -- note: base64 is applied to the hex STRING, not the raw digest bytes`}</CodeBlock>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Solidgate also requires <code className="font-mono">customerEmail</code> on every charge (Stripe
          does not), and uses its own <code className="font-mono">order_id</code> as the orchestrator&apos;s
          payment UUID directly rather than a separate metadata round-trip.
        </p>
      </section>
    </div>
  );
}

function FieldRow({
  label,
  placeholder,
  secret,
  env,
}: {
  label: string;
  placeholder: string;
  secret: boolean;
  env: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border pb-2 last:border-0 last:pb-0">
      <div>
        <div className="font-medium text-foreground">{label}</div>
        <div className="font-mono text-xs text-muted-foreground">{placeholder}</div>
      </div>
      <div className="flex flex-col items-end gap-1">
        <Badge tone={secret ? "danger" : "neutral"}>{secret ? "secret" : "public"}</Badge>
        <span className="font-mono text-[10px] text-muted-foreground">{env}</span>
      </div>
    </div>
  );
}
