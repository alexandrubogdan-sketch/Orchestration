"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { VolumePoint } from "@/lib/types";
import { formatDate, formatMoney, formatPercent } from "@/lib/utils";

export function VolumeChart({ data }: { data: VolumePoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={data} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="volumeFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#4f46e5" stopOpacity={0.25} />
            <stop offset="100%" stopColor="#4f46e5" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={(v: string) => formatDate(v)}
          tick={{ fontSize: 11, fill: "#6b7280" }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          yAxisId="volume"
          tick={{ fontSize: 11, fill: "#6b7280" }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v: number) => `$${(v / 100000).toFixed(0)}k`}
        />
        <YAxis
          yAxisId="rate"
          orientation="right"
          domain={[0, 100]}
          tick={{ fontSize: 11, fill: "#6b7280" }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v: number) => `${v}%`}
        />
        <Tooltip
          formatter={(value, name) =>
            name === "volumeMinorUnits"
              ? [formatMoney(Number(value ?? 0), "USD"), "Volume"]
              : [formatPercent(Number(value ?? 0)), "Approval rate"]
          }
          labelFormatter={(label) => formatDate(String(label ?? ""))}
          contentStyle={{ fontSize: 12, borderRadius: 8, borderColor: "#e5e7eb" }}
        />
        <Area
          yAxisId="volume"
          type="monotone"
          dataKey="volumeMinorUnits"
          stroke="#4f46e5"
          fill="url(#volumeFill)"
          strokeWidth={2}
        />
        <Line
          yAxisId="rate"
          type="monotone"
          dataKey="approvalRate"
          stroke="#16a34a"
          strokeWidth={2}
          dot={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
