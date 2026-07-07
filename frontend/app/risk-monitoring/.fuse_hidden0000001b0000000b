"use client";

import { useMemo, useState } from "react";
import { Topbar } from "@/components/layout/topbar";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { SchemeStatusCard } from "@/components/risk-monitoring/scheme-status-card";
import {
  MC_ECM_MIN_COUNT,
  MC_HECM_MIN_COUNT,
  VAMP_EXCESSIVE_FEE_USD,
  VAMP_MIN_MONTHLY_COUNT,
  classifyRisk,
  getDescriptorsForProcessor,
  getProcessorsWithRiskData,
} from "@/lib/risk-monitoring";
import { PROCESSOR_LABELS, type ProcessorId } from "@/lib/types";
import { formatPercent } from "@/lib/utils";

export default function RiskMonitoringPage() {
  const processors = getProcessorsWithRiskData();
  const [processor, setProcessor] = useState<ProcessorId>(processors[0]!);
  const descriptors = getDescriptorsForProcessor(processor);
  const [descriptor, setDescriptor] = useState<string>(descriptors[0]?.descriptor ?? "");

  const profile = useMemo(
    () => descriptors.find((d) => d.descriptor === descriptor) ?? descriptors[0],
    [descriptors, descriptor],
  );

  function handleProcessorChange(next: ProcessorId) {
    setProcessor(next);
    const nextDescriptors = getDescriptorsForProcessor(next);
    setDescriptor(nextDescriptors[0]?.descriptor ?? "");
  }

  const vampStatus = profile ? classifyRisk("visa_vamp", profile.vampHistory.at(-1)!.fraudDisputeRatioPct) : null;
  const mcStatus = profile
    ? classifyRisk("mastercard_ecp", profile.mastercardHistory.at(-1)!.fraudDisputeRatioPct)
    : null;

  const worstTone =
    vampStatus?.tier.tone === "danger" || mcStatus?.tier.tone === "danger"
      ? "danger"
      : vampStatus?.tier.tone === "warning" || mcStatus?.tier.tone === "warning"
        ? "warning"
        : "success";

  return (
    <>
      <Topbar
        title="Risk Monitoring"
        description="Visa VAMP and Mastercard chargeback-monitoring thresholds by PSP and descriptor"
      />
      <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-8">
        <Card>
          <CardContent className="flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="risk-processor">PSP</Label>
              <Select
                id="risk-processor"
                className="w-48"
                value={processor}
                onChange={(e) => handleProcessorChange(e.target.value as ProcessorId)}
              >
                {processors.map((p) => (
                  <option key={p} value={p}>
                    {PROCESSOR_LABELS[p]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="risk-descriptor">Billing descriptor</Label>
              <Select
                id="risk-descriptor"
                className="w-64"
                value={descriptor}
                onChange={(e) => setDescriptor(e.target.value)}
              >
                {descriptors.map((d) => (
                  <option key={d.descriptor} value={d.descriptor}>
                    {d.descriptor}
                  </option>
                ))}
              </Select>
            </div>
            {profile ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-sm text-muted">Merchant entity</span>
                <span className="flex h-9 items-center text-sm font-medium">
                  {profile.merchantEntity}
                </span>
              </div>
            ) : null}
            <div className="ml-auto flex flex-col items-end gap-1.5">
              <span className="text-sm text-muted">Overall status</span>
              <Badge tone={worstTone} className="text-sm">
                {worstTone === "danger"
                  ? "Action required"
                  : worstTone === "warning"
                    ? "Monitor closely"
                    : "Healthy"}
              </Badge>
            </div>
          </CardContent>
        </Card>

        {profile && vampStatus && mcStatus ? (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <SchemeStatusCard
              schemeLabel="Visa VAMP ratio"
              status={vampStatus}
              history={profile.vampHistory}
              thresholdPct={1.5}
              thresholdLabel="Excessive, from Apr 1 2026"
              countLabel="Fraud + dispute count (TC40+TC15)"
              countValue={`${profile.vampFraudDisputeCount.toLocaleString()} / ${profile.settledTransactionCount.toLocaleString()} settled`}
              lineColor="var(--color-accent-foreground)"
            />
            <SchemeStatusCard
              schemeLabel="Mastercard chargeback ratio"
              status={mcStatus}
              history={profile.mastercardHistory}
              thresholdPct={mcStatus.tier.id === "mc_hecm" || mcStatus.ratioPct >= 3 ? 3 : 1.5}
              thresholdLabel={
                mcStatus.tier.id === "mc_hecm" || mcStatus.ratioPct >= 3
                  ? "High Excessive (HECM)"
                  : "Excessive (ECM)"
              }
              countLabel="Chargeback count"
              countValue={`${profile.mastercardChargebackCount.toLocaleString()} chargebacks`}
              lineColor="#d97706"
            />
          </div>
        ) : (
          <Card>
            <CardContent>
              <p className="text-sm text-muted">No risk data for this PSP yet.</p>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Program reference</CardTitle>
            <CardDescription>
              Current published thresholds this dashboard evaluates against.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-6 text-sm sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <div className="font-medium text-foreground">Visa Acquirer Monitoring Program (VAMP)</div>
              <ul className="list-inside list-disc space-y-1 text-muted-foreground">
                <li>Excessive merchant ratio: {formatPercent(1.5, 1)} (global ex-MENA, from Apr 1, 2026; was 2.2% at Jun–Oct 2025 rollout)</li>
                <li>In-scope minimum volume: {VAMP_MIN_MONTHLY_COUNT.toLocaleString()} fraud+dispute transactions/month</li>
                <li>Excessive merchant fee: ${VAMP_EXCESSIVE_FEE_USD} per fraudulent/disputed transaction</li>
                <li>Ratio = (TC40 fraud + TC15 disputes) / TC05 settled transactions</li>
              </ul>
            </div>
            <div className="flex flex-col gap-2">
              <div className="font-medium text-foreground">Mastercard Excessive Chargeback Program (ECP)</div>
              <ul className="list-inside list-disc space-y-1 text-muted-foreground">
                <li>ECM tier: {MC_ECM_MIN_COUNT}–299 chargebacks AND {formatPercent(1.5, 1)}–2.99% ratio</li>
                <li>HECM tier: {MC_HECM_MIN_COUNT}+ chargebacks AND {formatPercent(3, 1)}+ ratio</li>
                <li>Exit requires 3 consecutive months back under threshold</li>
                <li>Fines escalate from ~$1,000/month to $200,000+ for sustained HECM</li>
              </ul>
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
