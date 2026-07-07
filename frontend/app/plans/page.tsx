"use client";

import { useState } from "react";
import { MoreHorizontal, Plus } from "lucide-react";
import { Topbar } from "@/components/layout/topbar";
import { Button } from "@/components/ui/button";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CopyToClipboardButton } from "@/components/ui/copy-to-clipboard-button";
import { PlanForm } from "@/components/plans/plan-form";
import { usePlanStore } from "@/lib/plan-store";
import { DEFAULT_PRICE_COUNTRY, type Plan } from "@/lib/types";
import { formatDate, formatMoney } from "@/lib/utils";

const PLAN_TYPE_TONES: Record<Plan["type"], BadgeTone> = {
  recurring: "accent",
  "one-off": "neutral",
};

function intervalLabel(count: number, unit: string): string {
  return count === 1 ? unit.replace(/s$/, "") : `${count} ${unit}`;
}

/** Compact price + interval summary, with a dimmed trial line underneath
 *  when the plan has an enabled trial — mirrors the real client's plans
 *  table "info" column layout. */
function PlanInfoCell({ plan }: { plan: Plan }) {
  const defaultPrice = plan.prices.find((p) => p.country === DEFAULT_PRICE_COUNTRY) ?? plan.prices[0];
  const trialDefaultPrice = plan.trial.prices.find((p) => p.country === DEFAULT_PRICE_COUNTRY) ?? plan.trial.prices[0];
  const overrideCount = plan.rules.length;

  return (
    <div className="flex max-w-[220px] flex-col gap-0.5">
      {defaultPrice ? (
        <div className="text-sm">
          {formatMoney(defaultPrice.amountMinorUnits, defaultPrice.currency)}
          {plan.type === "recurring" ? (
            <span className="text-muted-foreground">
              {" "}
              / {intervalLabel(plan.billingIntervalCount, plan.billingIntervalUnit)}
            </span>
          ) : null}
        </div>
      ) : (
        <span className="text-sm text-muted-foreground">No price set</span>
      )}

      {plan.trial.enabled && trialDefaultPrice ? (
        <div className="text-xs text-muted-foreground">
          {formatMoney(trialDefaultPrice.amountMinorUnits, trialDefaultPrice.currency)} /{" "}
          {intervalLabel(plan.trial.intervalCount, plan.trial.intervalUnit)} trial
        </div>
      ) : null}

      {overrideCount > 0 ? (
        <div className="text-xs text-muted-foreground">
          {overrideCount} price {overrideCount === 1 ? "override" : "overrides"}
        </div>
      ) : null}
    </div>
  );
}

export default function PlansPage() {
  const plans = usePlanStore((s) => s.plans);
  const createPlan = usePlanStore((s) => s.createPlan);
  const updatePlan = usePlanStore((s) => s.updatePlan);
  const deletePlan = usePlanStore((s) => s.deletePlan);
  const duplicatePlan = usePlanStore((s) => s.duplicatePlan);

  const [creating, setCreating] = useState(false);
  const [editingPlan, setEditingPlan] = useState<Plan | null>(null);

  function handleDuplicate(plan: Plan) {
    const newId = duplicatePlan(plan.id);
    if (!newId) return;
    const clone = usePlanStore.getState().plans.find((p) => p.id === newId);
    if (clone) setEditingPlan(clone);
  }

  return (
    <>
      <Topbar title="Plans" description="Billing plans — pricing, localized currencies, and trials" />
      <div className="flex-1 overflow-y-auto p-8">
        <div className="mb-4 flex items-center justify-between">
          <span className="text-sm text-muted-foreground">{plans.length} plan(s)</span>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" /> Create plan
          </Button>
        </div>

        <div className="overflow-hidden rounded-xl border border-border bg-surface">
          <Table>
            <THead>
              <TR>
                <TH>Name</TH>
                <TH>Type</TH>
                <TH>Plan info</TH>
                <TH>Created</TH>
                <TH>Updated</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {plans.map((plan) => (
                <TR key={plan.id}>
                  <TD>
                    <button
                      className="block max-w-[220px] truncate text-left text-sm font-semibold hover:underline"
                      onClick={() => setEditingPlan(plan)}
                    >
                      {plan.name}
                    </button>
                    <div className="group/plan-id flex items-center gap-1 text-xs text-muted-foreground">
                      <span className="truncate font-mono">{plan.id}</span>
                      <CopyToClipboardButton
                        text={plan.id}
                        className="opacity-0 transition-opacity group-hover/plan-id:opacity-100"
                      />
                    </div>
                  </TD>
                  <TD>
                    <Badge tone={PLAN_TYPE_TONES[plan.type]}>
                      {plan.type === "recurring" ? "Recurring" : "One-off"}
                    </Badge>
                  </TD>
                  <TD>
                    <PlanInfoCell plan={plan} />
                  </TD>
                  <TD className="text-sm text-muted-foreground">{formatDate(plan.createdAt)}</TD>
                  <TD className="text-sm text-muted-foreground">{formatDate(plan.updatedAt)}</TD>
                  <TD>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" aria-label="Plan actions">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setEditingPlan(plan)}>Edit</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleDuplicate(plan)}>Duplicate</DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => deletePlan(plan.id)}
                          className="text-danger focus:bg-danger-bg focus:text-danger"
                        >
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          {plans.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No plans yet — create one to start billing.
            </div>
          ) : null}
        </div>
      </div>

      {creating ? (
        <PlanForm
          onClose={() => setCreating(false)}
          onSave={(plan) => {
            createPlan(plan);
            setCreating(false);
          }}
        />
      ) : null}

      {editingPlan ? (
        <PlanForm
          initial={editingPlan}
          onClose={() => setEditingPlan(null)}
          onSave={(plan) => {
            updatePlan(editingPlan.id, plan);
            setEditingPlan(null);
          }}
        />
      ) : null}
    </>
  );
}
