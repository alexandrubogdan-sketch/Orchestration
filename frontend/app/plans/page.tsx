"use client";

import { useState } from "react";
import { Plus, Repeat, Trash2 } from "lucide-react";
import { Topbar } from "@/components/layout/topbar";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PlanForm } from "@/components/plans/plan-form";
import { usePlanStore } from "@/lib/plan-store";
import { DEFAULT_PRICE_COUNTRY, type Plan } from "@/lib/types";
import { formatMoney } from "@/lib/utils";

export default function PlansPage() {
  const plans = usePlanStore((s) => s.plans);
  const createPlan = usePlanStore((s) => s.createPlan);
  const updatePlan = usePlanStore((s) => s.updatePlan);
  const deletePlan = usePlanStore((s) => s.deletePlan);

  const [creating, setCreating] = useState(false);
  const [editingPlan, setEditingPlan] = useState<Plan | null>(null);

  return (
    <>
      <Topbar title="Plans" description="Billing plans — pricing, localized currencies, and trials" />
      <div className="flex-1 overflow-y-auto p-8">
        <div className="mb-4 flex items-center justify-between">
          <span className="text-sm text-muted">{plans.length} plan(s)</span>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" /> Create plan
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {plans.map((plan) => {
            const defaultPrice =
              plan.prices.find((p) => p.country === DEFAULT_PRICE_COUNTRY) ?? plan.prices[0];
            const overrides = plan.prices.filter((p) => p.id !== defaultPrice?.id);

            return (
              <Card key={plan.id} className="group relative">
                <CardContent className="flex flex-col gap-3">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
                        <Repeat className="h-4 w-4" />
                      </div>
                      <button className="text-sm font-semibold hover:underline" onClick={() => setEditingPlan(plan)}>
                        {plan.name}
                      </button>
                    </div>
                    <button
                      onClick={() => deletePlan(plan.id)}
                      className="text-muted opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                      title="Delete plan"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>

                  {defaultPrice ? (
                    <div className="text-lg font-semibold">
                      {formatMoney(defaultPrice.amountMinorUnits, defaultPrice.currency)}
                      <span className="text-sm font-normal text-muted">
                        {" "}
                        / {plan.billingIntervalCount === 1
                          ? plan.billingIntervalUnit.replace(/s$/, "")
                          : `${plan.billingIntervalCount} ${plan.billingIntervalUnit}`}
                      </span>
                    </div>
                  ) : null}

                  {overrides.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {overrides.map((row) => (
                        <Badge key={row.id} tone="neutral">
                          {row.country || "?"}: {formatMoney(row.amountMinorUnits, row.currency)}
                        </Badge>
                      ))}
                    </div>
                  ) : null}

                  <div className="flex items-center gap-2 text-xs text-muted">
                    {plan.trial.enabled ? (
                      <Badge tone="info">
                        {plan.trial.intervalCount} {plan.trial.intervalUnit} trial
                      </Badge>
                    ) : (
                      <Badge tone="neutral">No trial</Badge>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        {plans.length === 0 ? (
          <div className="mt-8 text-center text-sm text-muted">No plans yet — create one to start billing.</div>
        ) : null}
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
