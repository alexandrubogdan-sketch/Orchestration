import { Topbar } from "@/components/layout/topbar";
import { KpiCard } from "@/components/dashboard/kpi-card";
import { VolumeChart } from "@/components/dashboard/volume-chart";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import {
  computeDashboardKpis,
  computeDeclineBreakdown,
  computeEntityBreakdown,
  computeVolumeSeries,
  getMockPayments,
} from "@/lib/mock-data";
import { formatMoney, formatPercent } from "@/lib/utils";
import { AlertTriangle, CircleCheck, CircleX, DollarSign } from "lucide-react";

export default function DashboardPage() {
  const payments = getMockPayments();
  const kpis = computeDashboardKpis(payments);
  const volumeSeries = computeVolumeSeries(payments);
  const declineBreakdown = computeDeclineBreakdown(payments);
  const entityBreakdown = computeEntityBreakdown(payments);

  return (
    <>
      <Topbar
        title="Dashboard"
        description="Cross-provider payment performance, last 14 days"
      />
      <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-8">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard
            label="Approval rate"
            value={formatPercent(kpis.approvalRate)}
            delta={kpis.approvalRateDelta}
            icon={CircleCheck}
          />
          <KpiCard
            label="Decline rate"
            value={formatPercent(kpis.declineRate)}
            delta={kpis.declineRateDelta}
            invertDelta
            icon={CircleX}
          />
          <KpiCard
            label="Volume (captured)"
            value={formatMoney(kpis.volumeMinorUnits, kpis.volumeCurrency)}
            delta={kpis.volumeDelta}
            icon={DollarSign}
          />
          <KpiCard
            label="Active disputes"
            value={String(kpis.activeDisputes)}
            icon={AlertTriangle}
          />
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Volume &amp; approval rate</CardTitle>
          </CardHeader>
          <CardContent>
            <VolumeChart data={volumeSeries} />
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Decline breakdown</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <THead>
                  <TR>
                    <TH>Normalized code</TH>
                    <TH>Category</TH>
                    <TH className="text-right">Count</TH>
                    <TH className="text-right">Share</TH>
                  </TR>
                </THead>
                <TBody>
                  {declineBreakdown.map((row) => (
                    <TR key={row.normalizedCode}>
                      <TD className="font-mono text-xs">{row.normalizedCode}</TD>
                      <TD>
                        <Badge tone={row.category === "hard" || row.category === "fraud" ? "danger" : "warning"}>
                          {row.category}
                        </Badge>
                      </TD>
                      <TD className="text-right">{row.count}</TD>
                      <TD className="text-right">{formatPercent(row.share)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Performance by legal entity</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <THead>
                  <TR>
                    <TH>Entity</TH>
                    <TH className="text-right">Volume</TH>
                    <TH className="text-right">Approval rate</TH>
                    <TH className="text-right">Decline rate</TH>
                  </TR>
                </THead>
                <TBody>
                  {entityBreakdown.map((row) => (
                    <TR key={row.entity}>
                      <TD className="font-medium">{row.entity}</TD>
                      <TD className="text-right">{formatMoney(row.volumeMinorUnits, "USD")}</TD>
                      <TD className="text-right">{formatPercent(row.approvalRate)}</TD>
                      <TD className="text-right">{formatPercent(row.declineRate)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
