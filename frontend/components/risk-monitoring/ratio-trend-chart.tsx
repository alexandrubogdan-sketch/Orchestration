"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { RiskMonthPoint } from "@/lib/risk-monitoring-types";
import { formatDate, formatPercent } from "@/lib/utils";

export function RatioTrendChart({
  data,
  thresholdPct,
  thresholdLabel,
  lineColor = "var(--color-accent-foreground)",
}: {
  data: RiskMonthPoint[];
  thresholdPct: number;
  thresholdLabel: string;
  lineColor?: string;
}) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
        <XAxis
          dataKey="month"
          tickFormatter={(v: string) => formatDate(v)}
          tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v: number) => `${v}%`}
          width={40}
        />
        <Tooltip
          formatter={(value) => [formatPercent(Number(value ?? 0), 2), "Ratio"]}
          labelFormatter={(label) => formatDate(String(label ?? ""))}
          contentStyle={{
            fontSize: 12,
            borderRadius: 8,
            borderColor: "var(--color-border)",
            background: "var(--color-surface)",
            color: "var(--color-foreground)",
          }}
        />
        <ReferenceLine
          y={thresholdPct}
          stroke="var(--color-danger)"
          strokeDasharray="4 4"
          strokeWidth={1.5}
          label={{
            value: thresholdLabel,
            position: "insideTopRight",
            fontSize: 11,
            fill: "var(--color-danger)",
          }}
        />
        <Line
          type="monotone"
          dataKey="fraudDisputeRatioPct"
          stroke={lineColor}
          strokeWidth={2}
          dot={{ r: 3 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
