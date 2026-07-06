import { DocsHeader } from "@/components/docs/docs-header";
import { Callout } from "@/components/docs/callout";
import { CodeBlock } from "@/components/docs/code-block";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export default function ReconciliationDocsPage() {
  return (
    <div>
      <DocsHeader
        eyebrow="Core payments"
        title="Reconciliation & ledger"
        description="Milestone 6: an append-only transaction ledger, settlement ingestion, and the nightly invariants sweep. There is no UI for any of this yet."
      />

      <Callout tone="info" title="Backend-only, no dashboard page" className="mb-8">
        Everything on this page describes real, implemented backend behavior (
        <code className="font-mono">src/ledger/</code>, <code className="font-mono">
          src/workflow/tasks/settlementIngestion.ts
        </code>
        , <code className="font-mono">nightlyInvariants.ts</code>). This dashboard has no Reconciliation
        page — the closest operational surface is <code className="font-mono">make recon-report</code>{" "}
        (<code className="font-mono">scripts/recon-report.ts</code>) run from a terminal.
      </Callout>

      <section className="mb-10">
        <h2 id="ledger-append-only" className="mb-3 text-lg font-semibold text-foreground">The ledger is append-only</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          <code className="font-mono">transactions</code> rows are never updated, only inserted — a
          correction is always a new row. Each row has a <code className="font-mono">type</code> of{" "}
          <code className="font-mono">authorization</code>, <code className="font-mono">capture</code>,{" "}
          <code className="font-mono">refund</code>, <code className="font-mono">chargeback</code>,{" "}
          <code className="font-mono">fee</code>, or <code className="font-mono">payout</code>, plus{" "}
          <code className="font-mono">fee_minor_units</code> and an optional{" "}
          <code className="font-mono">payout_batch_id</code> linking it to a payout.
        </p>
        <CodeBlock label="TransactionsTable" className="mt-3">{`{
  id, payment_id, attempt_id,
  type: "authorization" | "capture" | "refund" | "chargeback" | "fee" | "payout",
  amount_minor_units, currency,
  psp_account_id, fee_minor_units, payout_batch_id,
  occurred_at, created_at
}`}</CodeBlock>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          When a matched capture has a linked payout, reconciliation inserts a{" "}
          <strong className="text-foreground">new</strong> transactions row with{" "}
          <code className="font-mono">type: &quot;payout&quot;</code> carrying the fee and batch id — never an
          UPDATE of the original capture row, per the append-only rule.
        </p>
      </section>

      <section className="mb-10">
        <h2 id="settlement-ingestion" className="mb-3 text-lg font-semibold text-foreground">Settlement ingestion</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          A scheduled task (<code className="font-mono">ledger.settlement-ingestion</code>, 2 retries) walks
          every enabled <code className="font-mono">psp_account</code>, calls the adapter&apos;s{" "}
          <code className="font-mono">listPayouts(sinceIso)</code> then{" "}
          <code className="font-mono">listSettlements(sinceIso)</code>, and runs{" "}
          <code className="font-mono">reconcileSettlements()</code> against the ledger. The lookback window
          defaults to 24 hours (<code className="font-mono">sinceHours</code>) — a fixed window, not a
          persisted cursor, which is flagged in{" "}
          <code className="font-mono">docs/adr/0008-settlement-ingestion.md</code> as a future optimization
          for reducing PSP API traffic rather than a correctness gap. A failure on one PSP account is
          caught and logged, not fatal to the whole run.
        </p>
      </section>

      <section className="mb-10">
        <h2 id="matching-and-exceptions" className="mb-3 text-lg font-semibold text-foreground">Matching and exceptions</h2>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          Only <code className="font-mono">capture</code> and <code className="font-mono">refund</code>{" "}
          settlement types are matched 1:1 against ledger transactions, deduplicated by{" "}
          <code className="font-mono">{"{pspAttemptRef}:{type}:{occurredAt}"}</code>. Fee-only settlement
          lines with no matching transaction are dropped by the normalizer rather than guessed at
          (&quot;encode ambiguity, don&apos;t guess&quot;). Everything else becomes a <code className="font-mono">
            recon_exceptions
          </code>{" "}
          row:
        </p>
        <Table>
          <THead>
            <TR>
              <TH>Exception type</TH>
              <TH>Meaning</TH>
            </TR>
          </THead>
          <TBody>
            <TR>
              <TD><Badge tone="warning">duplicate_settlement</Badge></TD>
              <TD className="text-sm text-muted-foreground">Same settlement line seen twice</TD>
            </TR>
            <TR>
              <TD><Badge tone="warning">unmatched_settlement</Badge></TD>
              <TD className="text-sm text-muted-foreground">No matching payment_attempts row found</TD>
            </TR>
            <TR>
              <TD><Badge tone="danger">missing_transaction</Badge></TD>
              <TD className="text-sm text-muted-foreground">Attempt found, but no ledger row exists</TD>
            </TR>
            <TR>
              <TD><Badge tone="danger">amount_mismatch</Badge></TD>
              <TD className="text-sm text-muted-foreground">Expected vs. actual settlement amount differ</TD>
            </TR>
          </TBody>
        </Table>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          <code className="font-mono">recon_exceptions</code> is the one Milestone 6 table deliberately{" "}
          <strong className="text-foreground">without</strong> the append-only trigger applied to the rest
          of the schema — it&apos;s mutable and operator-triaged, with a <code className="font-mono">status</code>{" "}
          of <code className="font-mono">open</code>, <code className="font-mono">resolved</code>, or{" "}
          <code className="font-mono">ignored</code>. <code className="font-mono">make recon-report</code>{" "}
          surfaces open exceptions from a terminal today.
        </p>
      </section>

      <section>
        <h2 id="nightly-invariants" className="mb-3 text-lg font-semibold text-foreground">Nightly invariants</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          <code className="font-mono">ledger.nightly-invariants</code> (1 retry) runs two checks and exposes
          them as Prometheus gauges only — there is no automated remediation:
        </p>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
          <li>
            <strong className="text-foreground">Net reconciliation per currency</strong>:{" "}
            <code className="font-mono">captured - refunded - paid_out</code>, exposed as{" "}
            <code className="font-mono">netReconciliationDiscrepancyMinorUnits</code>. A negative value is
            treated as never legitimate.
          </li>
          <li>
            <strong className="text-foreground">Stuck-state sweep</strong>: counts payments sitting in
            non-terminal states older than <code className="font-mono">staleHours</code> (default 24),
            exposed per-state as <code className="font-mono">stuckPaymentsTotal</code>.
          </li>
        </ul>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          It also surfaces <code className="font-mono">reconOpenExceptionsTotal</code> by exception type.
          Alert rules for these gauges live in <code className="font-mono">docs/dashboards/alert-rules.yml</code>{" "}
          (per <code className="font-mono">docs/adr/0009-dashboards-and-alerting.md</code>) — five rules,
          checked in but never round-tripped through a live Prometheus/Grafana instance during this build.
        </p>
      </section>
    </div>
  );
}
