import { DocsHeader } from "@/components/docs/docs-header";
import { Callout } from "@/components/docs/callout";
import { CodeBlock } from "@/components/docs/code-block";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default function PaymentsDocsPage() {
  return (
    <div>
      <DocsHeader
        eyebrow="Core payments"
        title="Payments"
        description="The canonical payment state machine, the public timeline vocabulary, and how idempotency is enforced end to end."
      />

      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold text-foreground">Canonical states</h2>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          A payment moves through exactly one of 15 states, defined in{" "}
          <code className="font-mono">src/domain/stateMachine.ts</code>:
        </p>
        <div className="mb-4 flex flex-wrap gap-1.5">
          {[
            "created",
            "requires_action",
            "authorizing",
            "authorized",
            "capturing",
            "captured",
            "refund_pending",
            "refunded",
            "dispute_opened",
            "dispute_won",
            "dispute_lost",
            "declined",
            "voided",
            "failed",
            "settled",
          ].map((s) => (
            <Badge key={s} tone="neutral" className="font-mono normal-case">
              {s}
            </Badge>
          ))}
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Terminal states are <code className="font-mono">declined</code>, <code className="font-mono">voided</code>,{" "}
          <code className="font-mono">failed</code>, <code className="font-mono">dispute_won</code>, and{" "}
          <code className="font-mono">dispute_lost</code>. Notably, <code className="font-mono">settled</code> and{" "}
          <code className="font-mono">refunded</code> are <strong className="text-foreground">not</strong>{" "}
          terminal — a settled payment can still be disputed, and a refunded payment can receive further
          partial refunds (<code className="font-mono">refunded</code> loops back to{" "}
          <code className="font-mono">refund_pending</code> on another <code className="font-mono">refund_started</code>{" "}
          event).
        </p>
      </section>

      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold text-foreground">The transition table is law</h2>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          <code className="font-mono">ALLOWED_TRANSITIONS</code> maps each state to the canonical event types
          it accepts and where they lead:
        </p>
        <CodeBlock label="src/domain/stateMachine.ts (abridged)">{`created         + authentication_required   -> requires_action
created         + authorization_started      -> authorizing
requires_action + authentication_completed   -> authorizing
requires_action + authentication_failed      -> declined
authorizing     + authorized                 -> authorized
authorizing     + declined                   -> declined
authorizing     + authorization_failed       -> failed
authorized      + capture_started            -> capturing
authorized      + voided                     -> voided
capturing       + captured                   -> captured
capturing       + declined                   -> declined
captured        + refund_started             -> refund_pending
captured        + dispute_opened             -> dispute_opened
captured        + settled                    -> settled
refund_pending  + refunded                   -> refunded
refund_pending  + declined                   -> declined
refunded        + refund_started             -> refund_pending   (further partial refunds)
settled         + dispute_opened             -> dispute_opened
dispute_opened  + dispute_won                -> captured | settled  (needs resolvedTarget)
dispute_opened  + dispute_lost                -> dispute_lost`}</CodeBlock>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          <code className="font-mono">applyTransition(currentState, event)</code> returns one of three outcomes:
        </p>
        <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
          <li>
            <Badge tone="success" className="mr-2">
              transitioned
            </Badge>
            the event is valid from the current state — state moves, one timeline row is written.
          </li>
          <li>
            <Badge tone="warning" className="mr-2">
              late
            </Badge>
            the event type is recognized but invalid from the current state (e.g. a duplicate/out-of-order
            webhook). Recorded as a <code className="font-mono">late_event</code> row — state does{" "}
            <strong className="text-foreground">not</strong> regress.
          </li>
          <li>
            <Badge tone="danger" className="mr-2">
              rejected
            </Badge>
            a genuinely unknown event type throws <code className="font-mono">InvalidTransitionError</code>{" "}
            and is logged as an <code className="font-mono">invariant_violation</code> row before rethrowing.
          </li>
        </ul>
      </section>

      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold text-foreground">
          Effectful transitions: <code className="font-mono">stateMachineDb.ts</code>
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          <code className="font-mono">transition(db, paymentId, event)</code> is the single choke point for
          all state changes. It locks the row with <code className="font-mono">SELECT ... FOR UPDATE</code>{" "}
          inside a DB transaction, validates via the pure state machine above, and — whatever the
          outcome — writes exactly one <code className="font-mono">payment_events</code> row in the same
          transaction. On a successful transition it also enqueues an outbox row (
          <code className="font-mono">event_type: &apos;outbound-webhook&apos;</code>) for any event type that has a
          stable public name, carrying <code className="font-mono">{"{ state, amount, declineCode }"}</code> —
          this is the same transactional-outbox mechanism that eventually notifies products.
        </p>
      </section>

      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold text-foreground">Timeline events (the public contract)</h2>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          Internal canonical event types are richer than what&apos;s exposed. <code className="font-mono">
            src/domain/timelineEvents.ts
          </code>{" "}
          defines a smaller, stable vocabulary (<code className="font-mono">TIMELINE_EVENT_NAMES</code>) that
          products and this dashboard actually see:
        </p>
        <div className="mb-3 flex flex-wrap gap-1.5">
          {[
            "started",
            "authentication_required",
            "authorized",
            "pending",
            "captured",
            "declined",
            "voided",
            "refund_pending",
            "refunded",
            "settled",
            "dispute_opened",
            "dispute_closed",
          ].map((s) => (
            <Badge key={s} tone="accent" className="font-mono normal-case">
              {s}
            </Badge>
          ))}
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Several internal event types collapse onto the same stable name — e.g.{" "}
          <code className="font-mono">authorization_started</code> → <code className="font-mono">started</code>,{" "}
          <code className="font-mono">authentication_completed</code> and{" "}
          <code className="font-mono">capture_started</code> both → <code className="font-mono">pending</code>, and
          both <code className="font-mono">dispute_won</code>/<code className="font-mono">dispute_lost</code> →{" "}
          <code className="font-mono">dispute_closed</code> (with a separate <code className="font-mono">outcome:
          &apos;won&apos;|&apos;lost&apos;</code> field). <code className="font-mono">late_event</code> and{" "}
          <code className="font-mono">invariant_violation</code> are deliberately excluded from this public
          vocabulary — they stay in <code className="font-mono">payment_events</code> for internal
          diagnostics only.
        </p>
      </section>

      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold text-foreground">Idempotency, at every layer</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle>Client → API</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Every mutating <code className="font-mono">/v1/*</code> call requires an{" "}
              <code className="font-mono">Idempotency-Key</code> header. Postgres is the arbiter: the key is
              a primary key on <code className="font-mono">idempotency_keys</code>, so concurrent requests
              race to insert and the loser polls for the winner&apos;s stored response. A key reused with a{" "}
              <em>different</em> request hash (method + path + body, SHA-256) returns 409.
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>API → PSP</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              A deterministic per-attempt idempotency key is forwarded to the PSP on every mutating call
              (Stripe&apos;s own <code className="font-mono">idempotencyKey</code> option, Solidgate&apos;s signed
              request). Retrying a dropped response with the same key must yield exactly one charge, never
              two.
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Webhook → handler</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              <code className="font-mono">webhook_inbox</code> has a unique constraint on{" "}
              <code className="font-mono">(psp, provider_event_id)</code>. Duplicate deliveries insert-conflict
              and short-circuit to a 200 before any business logic runs.
            </CardContent>
          </Card>
        </div>
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
          Redis is layered on top purely as a 24-hour read-through cache of already-completed responses (
          <code className="font-mono">idempotency:response:&lt;key&gt;</code>) to keep replay traffic off
          Postgres — it is never the source of truth for &quot;who won.&quot;
        </p>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-foreground">Money</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          All amounts are a branded <code className="font-mono">Money</code> type (
          <code className="font-mono">{"{ minorUnits: number; currency: string }"}</code>), constructed only
          via <code className="font-mono">makeMoney()</code>, which rejects non-integers, unsafe integers,
          negative values, and any currency outside a 20-code allow-list. A small zero-decimal set (JPY,
          KRW, VND, CLP, ISK, HUF) is handled explicitly in both the backend and this dashboard&apos;s{" "}
          <code className="font-mono">formatMoney()</code> helper — everything else is assumed to have 2
          decimal places.
        </p>
        <Callout tone="warning" title="Known gap in this dashboard" className="mt-4">
          The Plans pricing editor in this frontend always divides/multiplies by 100 when entering an
          amount. Zero-decimal currencies will show or store the wrong amount if selected — this hasn&apos;t
          been fixed yet.
        </Callout>
      </section>
    </div>
  );
}
