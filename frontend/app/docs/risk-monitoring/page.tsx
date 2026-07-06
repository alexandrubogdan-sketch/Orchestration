import { DocsHeader } from "@/components/docs/docs-header";
import { Callout } from "@/components/docs/callout";
import { CodeBlock } from "@/components/docs/code-block";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";

export default function RiskMonitoringDocsPage() {
  return (
    <div>
      <DocsHeader
        eyebrow="Risk & operations"
        title="Risk monitoring"
        description="Visa VAMP and Mastercard chargeback-monitoring thresholds, and exactly how the tiers in this dashboard are computed."
      />

      <Callout tone="info" title="Real thresholds, mock underlying data" className="mb-8">
        The tier thresholds and formulas on this page and in <code className="font-mono">lib/risk-monitoring.ts</code>{" "}
        are sourced from Visa&apos;s and Mastercard&apos;s published program rules. The per-descriptor transaction
        and chargeback counts they&apos;re applied to (<code className="font-mono">DESCRIPTOR_SEEDS</code>) are
        fabricated mock data — there is no live feed from Stripe/Solidgate dispute data or the backend&apos;s{" "}
        <code className="font-mono">transactions</code> ledger into this page today.
      </Callout>

      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold text-foreground">Visa VAMP (Acquirer Monitoring Program)</h2>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          Ratio formula:
        </p>
        <CodeBlock label="VAMP ratio">{`VAMP Ratio = (TC40 fraud count + TC15 dispute count) / settled (TC05) transaction count`}</CodeBlock>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          A merchant is only in scope once combined fraud + dispute transactions reach{" "}
          <strong className="text-foreground">1,500 per month</strong> (<code className="font-mono">
            VAMP_MIN_MONTHLY_COUNT
          </code>
          ). Merchants in the &quot;Excessive&quot; tier are charged <strong className="text-foreground">$8</strong>{" "}
          per transaction (<code className="font-mono">VAMP_EXCESSIVE_FEE_USD</code>). The Excessive
          threshold itself has moved: it was 2.2% at the program&apos;s June 2025 rollout / October 1, 2025 fee
          start, and tightens to <strong className="text-foreground">1.5%</strong> globally (excluding MENA)
          from <strong className="text-foreground">April 1, 2026</strong>.
        </p>
        <Table className="mt-4">
          <THead>
            <TR>
              <TH>Tier</TH>
              <TH>Min ratio</TH>
              <TH>Tone</TH>
            </TR>
          </THead>
          <TBody>
            <TR>
              <TD>Standard</TD>
              <TD>0%</TD>
              <TD><Badge tone="success">success</Badge></TD>
            </TR>
            <TR>
              <TD>Approaching threshold</TD>
              <TD>1.05%</TD>
              <TD><Badge tone="warning">warning</Badge></TD>
            </TR>
            <TR>
              <TD>Excessive</TD>
              <TD>1.5%</TD>
              <TD><Badge tone="danger">danger</Badge></TD>
            </TR>
          </TBody>
        </Table>
        <p className="mt-2 text-xs text-muted-foreground">
          &quot;Approaching threshold&quot; is set at 1.05% because that&apos;s within 30% of the 1.5% Excessive
          line, per the code comment in <code className="font-mono">RISK_TIERS</code>.
        </p>
      </section>

      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold text-foreground">Mastercard ECP (Excessive Chargeback Program)</h2>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">Ratio formula:</p>
        <CodeBlock label="Mastercard chargeback ratio">{`ratio = current-month chargebacks / prior-month sales transactions × 100`}</CodeBlock>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Minimum chargeback counts gate each tier: <strong className="text-foreground">100</strong> for ECM (
          <code className="font-mono">MC_ECM_MIN_COUNT</code>), <strong className="text-foreground">300</strong>{" "}
          for HECM (<code className="font-mono">MC_HECM_MIN_COUNT</code>).
        </p>
        <Table className="mt-4">
          <THead>
            <TR>
              <TH>Tier</TH>
              <TH>Min ratio</TH>
              <TH>Chargeback count</TH>
              <TH>Tone</TH>
            </TR>
          </THead>
          <TBody>
            <TR>
              <TD>Standard</TD>
              <TD>0%</TD>
              <TD>—</TD>
              <TD><Badge tone="success">success</Badge></TD>
            </TR>
            <TR>
              <TD>Excessive (ECM)</TD>
              <TD>1.5%</TD>
              <TD>100–299</TD>
              <TD><Badge tone="warning">warning</Badge></TD>
            </TR>
            <TR>
              <TD>High Excessive (HECM)</TD>
              <TD>≥ 3%</TD>
              <TD>≥ 300</TD>
              <TD><Badge tone="danger">danger</Badge></TD>
            </TR>
          </TBody>
        </Table>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Fines escalate from roughly <strong className="text-foreground">$1,000/month</strong> up past{" "}
          <strong className="text-foreground">$200,000+</strong> for sustained HECM status. Exiting ECM/HECM
          requires 3 consecutive months back under threshold — noted in the source comments but not
          enforced anywhere in this dashboard&apos;s code, since there&apos;s no persisted month-over-month state
          to enforce it against.
        </p>
      </section>

      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold text-foreground">Tier classification</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          <code className="font-mono">classifyRisk(scheme, ratioPct)</code> picks the highest tier whose{" "}
          <code className="font-mono">minRatioPct</code> is at or below the observed ratio, for that scheme.{" "}
          <code className="font-mono">headroomFraction</code> is computed as{" "}
          <code className="font-mono">(ratioPct - floor) / (ceiling - floor)</code>, where the ceiling is the
          next tier&apos;s <code className="font-mono">minRatioPct</code> — or, if there is no next tier (i.e.
          already in the worst tier), <code className="font-mono">floor * 1.5</code> (or 1 if that&apos;s zero).
          This means headroom can legitimately exceed 1.0 once a merchant is deep into the worst tier.
        </p>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-foreground">Mock descriptor seeds</h2>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          Four fabricated descriptor profiles (<code className="font-mono">DESCRIPTOR_SEEDS</code>) exercise
          every tier:
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <SeedCard descriptor="ACME*DIGITALGOODS" processor="Solidgate" entity="US-LLC" settled="118,400" vamp="1.62%" vampTier="Excessive" mc="3.35%" mcTier="HECM" />
          <SeedCard descriptor="ACME* PRO SUB" processor="Stripe" entity="US-LLC" settled="86,200" vamp="1.12%" vampTier="Approaching threshold" mc="1.85%" mcTier="ECM" />
          <SeedCard descriptor="ACMEDIGITAL EU" processor="Stripe" entity="EU-BV" settled="52,900" vamp="0.58%" vampTier="Standard" mc="0.71%" mcTier="Standard" />
          <SeedCard descriptor="ACME GOODS CO" processor="Solidgate" entity="EU-BV" settled="34,150" vamp="0.34%" vampTier="Standard" mc="0.42%" mcTier="Standard" />
        </div>
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
          Each profile carries 6 months of history (oldest first) for both schemes, used to draw the trend
          chart on the live page. Sourced comments in the file cite checkout.com&apos;s VAMP writeup, Visa&apos;s
          own VAMP fact sheet, chargebacks911.com, chargeflow.io, and chargebackstop.com&apos;s 2026
          remediation guide as the basis for the thresholds above.
        </p>
      </section>
    </div>
  );
}

function SeedCard({
  descriptor,
  processor,
  entity,
  settled,
  vamp,
  vampTier,
  mc,
  mcTier,
}: {
  descriptor: string;
  processor: string;
  entity: string;
  settled: string;
  vamp: string;
  vampTier: string;
  mc: string;
  mcTier: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-mono normal-case text-foreground">{descriptor}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5 text-sm text-muted-foreground">
        <div>
          {processor} &middot; {entity} &middot; {settled} settled txns
        </div>
        <div>
          VAMP: <span className="font-mono text-foreground">{vamp}</span> ({vampTier})
        </div>
        <div>
          Mastercard: <span className="font-mono text-foreground">{mc}</span> ({mcTier})
        </div>
      </CardContent>
    </Card>
  );
}
