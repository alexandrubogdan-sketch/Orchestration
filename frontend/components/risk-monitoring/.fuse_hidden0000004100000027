import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { RiskMonthPoint, RiskStatus } from "@/lib/risk-monitoring-types";
import { cn, formatPercent } from "@/lib/utils";
import { RatioTrendChart } from "./ratio-trend-chart";

export function SchemeStatusCard({
  schemeLabel,
  status,
  history,
  thresholdPct,
  thresholdLabel,
  countLabel,
  countValue,
  lineColor,
}: {
  schemeLabel: string;
  status: RiskStatus;
  history: RiskMonthPoint[];
  thresholdPct: number;
  thresholdLabel: string;
  countLabel: string;
  countValue: string;
  lineColor?: string;
}) {
  const progressPct = Math.min(100, Math.max(0, status.headroomFraction * 100));

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2 pb-3">
        <div className="flex flex-col gap-1">
          <CardTitle>{schemeLabel}</CardTitle>
          <CardDescription>{status.tier.description}</CardDescription>
        </div>
        <Badge tone={status.tier.tone}>{status.tier.label}</Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-end justify-between">
          <div>
            <div className="text-3xl font-semibold tracking-tight">
              {formatPercent(status.ratioPct, 2)}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              Threshold: {formatPercent(thresholdPct, 2)} ({thresholdLabel})
            </div>
          </div>
          <div className="text-right text-xs text-muted-foreground">
            <div>{countLabel}</div>
            <div className="font-medium text-foreground">{countValue}</div>
          </div>
        </div>

        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              status.tier.tone === "danger" && "bg-danger",
              status.tier.tone === "warning" && "bg-warning",
              status.tier.tone === "success" && "bg-success",
            )}
            style={{ width: `${progressPct}%` }}
          />
        </div>

        <RatioTrendChart
          data={history}
          thresholdPct={thresholdPct}
          thresholdLabel={thresholdLabel}
          lineColor={lineColor}
        />
      </CardContent>
    </Card>
  );
}
