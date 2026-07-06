import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ArrowDownRight, ArrowUpRight, type LucideIcon } from "lucide-react";

export function KpiCard({
  label,
  value,
  delta,
  deltaLabel = "vs last period",
  icon: Icon,
  invertDelta = false,
}: {
  label: string;
  value: string;
  delta?: number;
  deltaLabel?: string;
  icon?: LucideIcon;
  /** For metrics where a decrease is good (e.g. decline rate). */
  invertDelta?: boolean;
}) {
  const isPositive = delta !== undefined ? (invertDelta ? delta < 0 : delta > 0) : null;

  return (
    <Card>
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted">{label}</span>
          {Icon ? <Icon className="h-4 w-4 text-muted" /> : null}
        </div>
        <span className="text-2xl font-semibold tracking-tight">{value}</span>
        {delta !== undefined ? (
          <div className="flex items-center gap-1 text-xs">
            <span
              className={cn(
                "inline-flex items-center gap-0.5 font-medium",
                isPositive ? "text-success" : "text-danger",
              )}
            >
              {isPositive ? (
                <ArrowUpRight className="h-3 w-3" />
              ) : (
                <ArrowDownRight className="h-3 w-3" />
              )}
              {Math.abs(delta).toFixed(1)}%
            </span>
            <span className="text-muted">{deltaLabel}</span>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
