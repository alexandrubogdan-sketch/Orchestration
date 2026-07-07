import { DocsHeader } from "@/components/docs/docs-header";
import { Callout } from "@/components/docs/callout";
import { CodeBlock } from "@/components/docs/code-block";
import { Badge } from "@/components/ui/badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";

type DeclineRow = { code: string; category: string; retry: string };

const DECLINES: DeclineRow[] = [
  { code: "insufficient_funds", category: "soft", retry: "same_instrument_later" },
  { code: "do_not_honor", category: "soft", retry: "same_instrument_later" },
  { code: "generic_decline", category: "soft", retry: "same_instrument_later" },
  { code: "processing_error", category: "soft", retry: "same_instrument_later" },
  { code: "approve_with_id", category: "soft", retry: "same_instrument_later" },
  { code: "card_velocity_exceeded", category: "soft", retry: "same_instrument_later" },
  { code: "incorrect_address", category: "soft", retry: "same_instrument_later" },
  { code: "incorrect_cvc / invalid_cvc", category: "soft", retry: "same_instrument_later" },
  { code: "incorrect_number / invalid_number", category: "soft", retry: "same_instrument_later" },
  { code: "incorrect_pin / invalid_pin", category: "soft", retry: "same_instrument_later" },
  { code: "incorrect_zip", category: "soft", retry: "same_instrument_later" },
  { code: "invalid_expiry_month", category: "soft", retry: "same_instrument_later" },
  { code: "invalid_expiry_year", category: "soft", retry: "same_instrument_later" },
  { code: "no_action_taken", category: "soft", retry: "same_instrument_later" },
  { code: "withdrawal_count_limit_exceeded", category: "soft", retry: "same_instrument_later" },
  { code: "duplicate_transaction", category: "soft", retry: "review" },
  { code: "stolen_card", category: "hard", retry: "never" },
  { code: "lost_card", category: "hard", retry: "never" },
  { code: "pickup_card", category: "hard", retry: "never" },
  { code: "invalid_account", category: "hard", retry: "never" },
  { code: "expired_card", category: "hard", retry: "never" },
  { code: "card_not_supported", category: "hard", retry: "never" },
  { code: "currency_not_supported", category: "hard", retry: "never" },
  { code: "call_issuer", category: "hard", retry: "never" },
  { code: "pin_try_exceeded", category: "hard", retry: "never" },
  { code: "restricted_card", category: "hard", retry: "never" },
  { code: "invalid_amount", category: "hard", retry: "never" },
  { code: "new_account_information_available", category: "hard", retry: "never" },
  { code: "not_permitted / service_not_allowed / transaction_not_allowed", category: "hard", retry: "never" },
  { code: "offline_pin_required", category: "hard", retry: "never" },
  { code: "online_or_offline_pin_required", category: "hard", retry: "never" },
  { code: "revocation_of_all_authorizations", category: "hard", retry: "never" },
  { code: "revocation_of_authorization", category: "hard", retry: "never" },
  { code: "stop_payment_order", category: "hard", retry: "never" },
  { code: "testmode_decline", category: "hard", retry: "never" },
  { code: "fraudulent", category: "fraud", retry: "never" },
  { code: "merchant_blacklist", category: "fraud", retry: "never" },
  { code: "security_violation", category: "fraud", retry: "never" },
  { code: "authentication_required", category: "authentication", retry: "retry_after_challenge" },
  { code: "authentication_not_handled", category: "authentication", retry: "retry_after_challenge" },
  { code: "mobile_device_authentication_required", category: "authentication", retry: "retry_after_challenge" },
  { code: "issuer_not_available", category: "technical", retry: "retry_different_psp" },
  { code: "try_again_later", category: "technical", retry: "retry_different_psp" },
  { code: "reenter_transaction", category: "technical", retry: "retry_different_psp" },
];

const CATEGORY_TONE: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = {
  soft: "warning",
  hard: "danger",
  fraud: "danger",
  authentication: "info",
  technical: "neutral",
  unmapped: "neutral",
};

export default function AdaptersDocsPage() {
  return (
    <div>
      <DocsHeader
        eyebrow="Core payments"
        title="PSP adapters & decline codes"
        description="Adapter isolation, the NormalizedDecline taxonomy, and the real Stripe decline-code map."
      />

      <section className="mb-10">
        <h2 id="adapter-isolation" className="mb-3 text-lg font-semibold text-foreground">Adapter isolation</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Non-negotiable #7 in the backend&apos;s spec: nothing outside <code className="font-mono">
            src/adapters/
          </code>{" "}
          may import a PSP SDK or reference a PSP-specific status string. Every PSP implements the same{" "}
          <code className="font-mono">PspAdapter</code> interface (<code className="font-mono">
            src/adapters/types.ts
          </code>
          ):
        </p>
        <CodeBlock label="PspAdapter" className="mt-3">{`interface PspAdapter {
  readonly psp: string;
  createPayment(input: CreatePaymentInput): Promise<AttemptResult>;
  capture(pspAttemptRef, amount, idempotencyKey): Promise<AttemptResult>;
  void(pspAttemptRef, idempotencyKey): Promise<AttemptResult>;
  refund(pspAttemptRef, amount, idempotencyKey): Promise<RefundResult>;
  getPayment(pspAttemptRef): Promise<AttemptSnapshot>;
  verifyWebhook(rawBody, headers): VerifiedEvent;
  normalizeEvent(rawPayload): CanonicalEvent[];
  extractPaymentId(rawPayload): string | undefined;
  extractPspAttemptRef(rawPayload): string | undefined;
  normalizeDecline(rawCode): NormalizedDecline;
  capabilities(): PspCapabilities;
  listSettlements(sinceIso): Promise<SettlementRecord[]>;
  listPayouts(sinceIso): Promise<PayoutRecord[]>;
  listAccountUpdates(sinceIso): Promise<AccountUpdateRecord[]>;
}`}</CodeBlock>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          <code className="font-mono">src/adapters/registry.ts</code> is the only place outside{" "}
          <code className="font-mono">adapters/mock</code>/<code className="font-mono">stripe</code>/<code className="font-mono">solidgate</code>{" "}
          allowed to know concrete adapter classes exist.
        </p>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
          <li>
            It resolves an adapter per <code className="font-mono">psp_account</code>, caching Stripe/Solidgate
            clients per account id (constructing a Stripe client is expensive) — the mock adapter is always
            a single shared instance.
          </li>
          <li>
            It optionally wraps the result in <code className="font-mono">RateLimitedPspAdapter</code>, a
            decorator that gates every outbound-network method through a fixed 1-second-window limiter
            (default 25 req/s per <code className="font-mono">psp_account</code>, Stripe&apos;s conservative
            test-mode floor).
          </li>
          <li>These self-imposed limits never feed the circuit breaker — they aren&apos;t a signal of PSP health.</li>
        </ul>
      </section>

      <section className="mb-10">
        <h2 id="normalized-decline-taxonomy" className="mb-3 text-lg font-semibold text-foreground">The NormalizedDecline taxonomy</h2>
        <CodeBlock label="src/domain/declines.ts">{`type DeclineCategory = "hard" | "soft" | "fraud" | "authentication" | "technical" | "unmapped";
type DeclineRetryClass = "never" | "same_instrument_later" | "retry_after_challenge"
                        | "retry_different_psp" | "review";

interface NormalizedDecline {
  psp: string;
  rawCode: string;
  normalizedCode: string;
  category: DeclineCategory;
  retryClass: DeclineRetryClass;
  description?: string;
}`}</CodeBlock>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Two derived predicates drive retry/routing decisions everywhere else in the system:{" "}
          <code className="font-mono">isHardDecline</code> (<code className="font-mono">retryClass === &quot;never&quot;</code>
          ) and <code className="font-mono">isEligibleForPspFailover</code> (
          <code className="font-mono">retryClass === &quot;retry_different_psp&quot;</code> — only{" "}
          <code className="font-mono">technical</code> failures ever cascade to a different PSP via the
          circuit breaker). Any raw code the map doesn&apos;t recognize falls back to{" "}
          <code className="font-mono">unmappedDecline()</code>: category <code className="font-mono">unmapped</code>,
          retry class <code className="font-mono">review</code> — never silently treated as retryable.
        </p>
      </section>

      <section className="mb-10">
        <h2 id="stripe-decline-map" className="mb-3 text-lg font-semibold text-foreground">Stripe decline map (45 codes)</h2>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          <code className="font-mono">STRIPE_DECLINE_SEED</code> covers Stripe&apos;s documented decline codes —
          audited in <code className="font-mono">docs/adr/0012-stripe-decline-and-3ds-audit.md</code>, which
          found the original seed covered only 18 of Stripe&apos;s 46 official codes and added the remaining
          27 (excluding 2 deprecated codes Stripe no longer returns).
        </p>
        <Table>
          <THead>
            <TR>
              <TH>Raw code</TH>
              <TH>Category</TH>
              <TH>Retry class</TH>
            </TR>
          </THead>
          <TBody>
            {DECLINES.map((row) => (
              <TR key={row.code}>
                <TD className="font-mono text-xs">{row.code}</TD>
                <TD>
                  <Badge tone={CATEGORY_TONE[row.category]}>{row.category}</Badge>
                </TD>
                <TD className="font-mono text-xs text-muted-foreground">{row.retry}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </section>

      <section className="mb-10">
        <h2 id="mock-adapter" className="mb-3 text-lg font-semibold text-foreground">Mock adapter — scriptable outcomes</h2>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          <code className="font-mono">src/adapters/mock/</code> is a deterministic fake PSP used by every
          integration test, driven by magic amounts (minor units):
        </p>
        <Table>
          <THead>
            <TR>
              <TH>Amount</TH>
              <TH>Outcome</TH>
            </TR>
          </THead>
          <TBody>
            <TR>
              <TD className="font-mono">4000</TD>
              <TD>Declined — <code className="font-mono text-xs">insufficient_funds</code> (soft, same_instrument_later)</TD>
            </TR>
            <TR>
              <TD className="font-mono">4001</TD>
              <TD>Declined — <code className="font-mono text-xs">stolen_card</code> (hard, never) — added for dunning/subscription hard-decline tests</TD>
            </TR>
            <TR>
              <TD className="font-mono">5000</TD>
              <TD>Requires 3DS action — synthetic client secret + <code className="font-mono text-xs">threeDs.required: true</code></TD>
            </TR>
            <TR>
              <TD className="font-mono">9000</TD>
              <TD>&quot;Timeout-after-success&quot; — attempt is recorded as authorized/captured and the webhook is enqueued, but the call throws to simulate a dropped response; retrying with the same idempotency key must not create a duplicate</TD>
            </TR>
            <TR>
              <TD>anything else</TD>
              <TD>Authorized, or captured immediately if <code className="font-mono text-xs">captureMethod: &quot;automatic&quot;</code></TD>
            </TR>
          </TBody>
        </Table>
      </section>

      <Callout tone="danger" title="Solidgate decline codes are not yet mapped">
        Every Solidgate decline currently falls through to <code className="font-mono">unmappedDecline()</code> —
        <code className="font-mono">docs/adr/0011-solidgate-second-psp.md</code> flags that no confirmed
        decline-code field was found in Solidgate&apos;s documented response schema during this build, so{" "}
        <code className="font-mono">extractSolidgateDeclineCode</code> always returns{" "}
        <code className="font-mono">undefined</code>. This is listed as the top-priority gap to fix before
        Solidgate declines are useful for retry logic or dunning — until then, every Solidgate decline is
        treated as <code className="font-mono">category: &quot;unmapped&quot;, retryClass: &quot;review&quot;</code>.
      </Callout>

      <section className="mt-10">
        <h2 id="paypal-adapter" className="mb-3 text-lg font-semibold text-foreground">PayPal — an Orders API v2 adapter, not a card processor</h2>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          The third adapter (<code className="font-mono">internal/adapters/paypal/</code>, Go-only — it
          postdates the TypeScript backend) wraps PayPal&apos;s Orders API v2: create an order, capture it,
          void/refund/get by order or capture id. It differs from Stripe/Solidgate in three structural ways:
        </p>
        <ul className="mb-4 list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
          <li>
            <strong className="text-foreground">Decimal-string amounts.</strong> PayPal&apos;s{" "}
            <code className="font-mono">amount.value</code> is a decimal string (e.g.{" "}
            <code className="font-mono">&quot;19.99&quot;</code>), not integer minor units — this adapter
            converts at the boundary (<code className="font-mono">amountToPayPalValue</code>/{" "}
            <code className="font-mono">payPalValueToMinorUnits</code>) so the &quot;money is always integer
            minor units&quot; non-negotiable still holds everywhere else in the codebase.
          </li>
          <li>
            <strong className="text-foreground">OAuth2, not a static API key.</strong> Every call first
            resolves a short-lived access token (<code className="font-mono">getAccessToken</code>, cached
            until near expiry) from client id/secret, rather than sending a secret key directly.
          </li>
          <li>
            <strong className="text-foreground">Webhook verification is a live API call, not local HMAC.</strong>{" "}
            Unlike Stripe (local HMAC-SHA256) and Solidgate (local HMAC-SHA512), PayPal has no documented
            local verification algorithm for its certificate-based webhook scheme — this adapter instead
            calls PayPal&apos;s own <code className="font-mono">POST /v1/notifications/verify-webhook-signature</code>{" "}
            for every inbound webhook. This is flagged explicitly in the adapter&apos;s source as a deliberate
            trade-off: added latency and an availability dependency on PayPal being reachable, in exchange
            for not having to implement PayPal&apos;s certificate-chain verification from scratch. Requires a{" "}
            <code className="font-mono">PAYPAL_WEBHOOK_ID</code> per <code className="font-mono">
              psp_account
            </code>{" "}
            — the adapter refuses to verify without one rather than silently skipping verification.
          </li>
        </ul>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          Decline handling for a denied/failed capture is a small, hand-authored table (
          <code className="font-mono">declineReasonToCategory</code>/<code className="font-mono">
            declineReasonToRetryClass
          </code>{" "}
          in <code className="font-mono">statusmapping.go</code>) rather than a DB-backed{" "}
          <code className="font-mono">decline_code_map</code> lookup — an operator-configured{" "}
          <code className="font-mono">decline_code_map</code> row still takes priority if one exists, but
          PayPal&apos;s <code className="font-mono">status_details.reason</code> values are a small, fully
          enumerated set (unlike card-network issuer codes), so a built-in fallback table was judged
          sufficient. Capabilities: <code className="font-mono">USD</code>/<code className="font-mono">
            EUR
          </code>
          /<code className="font-mono">GBP</code> only, no 3DS. Settlement/payout listing is an honest,
          explicitly-flagged &quot;not yet implemented&quot; (PayPal&apos;s Transaction Search / Reporting APIs
          were out of scope for the session that built this adapter); account-updater is a considered
          &quot;genuinely no equivalent&quot; — a PayPal account isn&apos;t a card PAN a network can silently
          reissue.
        </p>
      </section>

      <section className="mt-10">
        <h2 id="stripe-vs-solidgate" className="mb-3 text-lg font-semibold text-foreground">All three adapters, side by side</h2>
        <Table>
          <THead>
            <TR>
              <TH></TH>
              <TH>Stripe</TH>
              <TH>Solidgate</TH>
              <TH>PayPal</TH>
            </TR>
          </THead>
          <TBody>
            <TR>
              <TD className="font-medium">Correlation</TD>
              <TD className="text-xs">metadata.payment_id round-trip</TD>
              <TD className="text-xs">order_id = our payment UUID directly</TD>
              <TD className="text-xs">custom_id on the purchase unit</TD>
            </TR>
            <TR>
              <TD className="font-medium">Required fields</TD>
              <TD className="text-xs">payment_method, capture_method</TD>
              <TD className="text-xs">customer_email is required (throws if absent)</TD>
              <TD className="text-xs">none beyond amount/currency</TD>
            </TR>
            <TR>
              <TD className="font-medium">Amount encoding</TD>
              <TD className="text-xs">integer minor units</TD>
              <TD className="text-xs">integer minor units</TD>
              <TD className="text-xs">decimal string — converted at the adapter boundary</TD>
            </TR>
            <TR>
              <TD className="font-medium">Auth model</TD>
              <TD className="text-xs">static secret key</TD>
              <TD className="text-xs">static secret key + signed requests</TD>
              <TD className="text-xs">OAuth2 access token, cached until near expiry</TD>
            </TR>
            <TR>
              <TD className="font-medium">3DS / challenge model</TD>
              <TD className="text-xs">client_secret (Payment Intents)</TD>
              <TD className="text-xs">verify_url redirect</TD>
              <TD className="text-xs">not supported (Capabilities().ThreeDs: false)</TD>
            </TR>
            <TR>
              <TD className="font-medium">Webhook auth</TD>
              <TD className="text-xs">stripe-signature header, local HMAC-SHA256</TD>
              <TD className="text-xs">merchant/signature headers, local HMAC-SHA512 then base64-of-hex</TD>
              <TD className="text-xs">outbound call to PayPal&apos;s verify-webhook-signature endpoint — no local algorithm</TD>
            </TR>
            <TR>
              <TD className="font-medium">Settlement/payout polling</TD>
              <TD className="text-xs">implemented (balanceTransactions, payouts)</TD>
              <TD className="text-xs">stubs returning [] — not yet implemented</TD>
              <TD className="text-xs">stubs returning [] — not yet implemented</TD>
            </TR>
            <TR>
              <TD className="font-medium">Account updater</TD>
              <TD className="text-xs">no polling equivalent exists (Stripe surfaces it as an ordinary decline on next charge)</TD>
              <TD className="text-xs">stub returning []</TD>
              <TD className="text-xs">genuinely no equivalent — not a card PAN a network can reissue</TD>
            </TR>
          </TBody>
        </Table>
        <p className="mt-3 text-xs text-muted-foreground">
          Per the respective ADRs/source comments, several Solidgate and PayPal details (Solidgate&apos;s
          settle/void/status endpoint paths and base URL default; PayPal&apos;s certificate-based webhook
          verification, sidestepped via a live API call instead) are flagged as inferred from documentation
          or deliberately worked around rather than confirmed against a live sandbox account — neither
          adapter has been run against real infrastructure for those specific paths.
        </p>
      </section>
    </div>
  );
}
