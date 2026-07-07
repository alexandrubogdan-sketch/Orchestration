"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { randomRowId } from "@/lib/plan-store";
import { COUNTRIES } from "@/lib/countries";
import {
  BILLING_INTERVAL_UNITS,
  COMMON_CURRENCIES,
  DEFAULT_PRICE_COUNTRY,
  PLAN_TYPES,
  TAX_COLLECTION_LABELS,
  TAX_COLLECTION_MODES,
  type BillingIntervalUnit,
  type Plan,
  type PlanType,
  type PriceOverrideRule,
  type PriceRow,
  type TaxCollectionMode,
} from "@/lib/types";

function emptyPriceRow(country: string): PriceRow {
  return { id: randomRowId("price"), currency: "USD", amountMinorUnits: 0, country };
}

function emptyOverrideRule(prefix: string): PriceOverrideRule {
  return { id: randomRowId(prefix), currency: "USD", countries: [], amountMinorUnits: 0 };
}

function toMajor(minor: number): string {
  return (minor / 100).toFixed(2);
}

function toMinor(major: string): number {
  const parsed = Number.parseFloat(major);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

function emptyPlan(): Omit<Plan, "id" | "createdAt" | "updatedAt"> {
  return {
    name: "",
    type: "recurring",
    billingIntervalUnit: "months",
    billingIntervalCount: 1,
    prices: [emptyPriceRow(DEFAULT_PRICE_COUNTRY)],
    rules: [],
    trial: { enabled: false, intervalUnit: "days", intervalCount: 7, prices: [], rules: [] },
    taxCollection: "global",
  };
}

/**
 * Create/edit form for a Plan — a base ("all countries") price plus any
 * number of per-country/currency override rules, an optional billing
 * interval (hidden for one-off plans), an optional trial with its own
 * price + interval + override rules, and a tax-collection selector.
 */
export function PlanForm({
  initial,
  onSave,
  onClose,
}: {
  initial?: Plan;
  onSave: (plan: Omit<Plan, "id" | "createdAt" | "updatedAt">) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Omit<Plan, "id" | "createdAt" | "updatedAt">>(
    initial ? { ...initial } : emptyPlan(),
  );

  const canSave = draft.name.trim().length > 0 && draft.prices.length > 0;
  const isRecurring = draft.type === "recurring";

  function updatePriceRow(rowId: string, patch: Partial<PriceRow>) {
    setDraft((d) => ({ ...d, prices: d.prices.map((r) => (r.id === rowId ? { ...r, ...patch } : r)) }));
  }
  function addPriceRow() {
    setDraft((d) => ({ ...d, prices: [...d.prices, emptyPriceRow("")] }));
  }
  function removePriceRow(rowId: string) {
    setDraft((d) => ({ ...d, prices: d.prices.filter((r) => r.id !== rowId) }));
  }

  function updateRule(rowId: string, patch: Partial<PriceOverrideRule>) {
    setDraft((d) => ({ ...d, rules: d.rules.map((r) => (r.id === rowId ? { ...r, ...patch } : r)) }));
  }
  function addRule() {
    setDraft((d) => ({ ...d, rules: [...d.rules, emptyOverrideRule("rule")] }));
  }
  function removeRule(rowId: string) {
    setDraft((d) => ({ ...d, rules: d.rules.filter((r) => r.id !== rowId) }));
  }

  function updateTrialPriceRow(rowId: string, patch: Partial<PriceRow>) {
    setDraft((d) => ({
      ...d,
      trial: { ...d.trial, prices: d.trial.prices.map((r) => (r.id === rowId ? { ...r, ...patch } : r)) },
    }));
  }
  function addTrialPriceRow() {
    setDraft((d) => ({ ...d, trial: { ...d.trial, prices: [...d.trial.prices, emptyPriceRow("")] } }));
  }
  function removeTrialPriceRow(rowId: string) {
    setDraft((d) => ({ ...d, trial: { ...d.trial, prices: d.trial.prices.filter((r) => r.id !== rowId) } }));
  }

  function updateTrialRule(rowId: string, patch: Partial<PriceOverrideRule>) {
    setDraft((d) => ({
      ...d,
      trial: { ...d.trial, rules: d.trial.rules.map((r) => (r.id === rowId ? { ...r, ...patch } : r)) },
    }));
  }
  function addTrialRule() {
    setDraft((d) => ({ ...d, trial: { ...d.trial, rules: [...d.trial.rules, emptyOverrideRule("trial-rule")] } }));
  }
  function removeTrialRule(rowId: string) {
    setDraft((d) => ({ ...d, trial: { ...d.trial, rules: d.trial.rules.filter((r) => r.id !== rowId) } }));
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{initial ? "Edit plan" : "Create plan"}</DialogTitle>
          <DialogDescription>
            Billing plans — pricing, localized currencies, and trials.
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[60vh] flex-col gap-6 overflow-y-auto pr-1">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="plan-name">Plan name</Label>
            <Input
              id="plan-name"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="e.g. Pro Monthly"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="plan-type">Plan type</Label>
            <Select
              id="plan-type"
              value={draft.type}
              onChange={(e) => setDraft((d) => ({ ...d, type: e.target.value as PlanType }))}
              className="w-48"
            >
              {PLAN_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type === "recurring" ? "Recurring" : "One-off"}
                </option>
              ))}
            </Select>
            <span className="text-xs text-muted-foreground">
              One-off plans charge once, with no billing interval and no trial.
            </span>
          </div>

          {isRecurring ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="plan-duration-count">Duration</Label>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Every</span>
                <Input
                  id="plan-duration-count"
                  type="number"
                  min={1}
                  className="w-20"
                  value={draft.billingIntervalCount}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, billingIntervalCount: Number(e.target.value) }))
                  }
                />
                <Select
                  aria-label="Duration unit"
                  value={draft.billingIntervalUnit}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, billingIntervalUnit: e.target.value as BillingIntervalUnit }))
                  }
                >
                  {BILLING_INTERVAL_UNITS.map((unit) => (
                    <option key={unit} value={unit}>
                      {unit}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          ) : null}

          <div className="flex flex-col gap-2">
            <Label>Base price</Label>
            <span className="text-xs text-muted-foreground">
              The default price charged to all countries unless overridden below.
            </span>
            <PriceRowsEditor
              rows={draft.prices}
              onUpdate={updatePriceRow}
              onRemove={removePriceRow}
              allowEmptyRemove={draft.prices.length > 1}
            />
            {draft.prices.length === 0 ? (
              <Button type="button" size="sm" variant="outline" onClick={addPriceRow} className="self-start">
                <Plus className="h-3.5 w-3.5" /> Add base price
              </Button>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label>Price overrides</Label>
              <Button type="button" size="sm" variant="outline" onClick={addRule}>
                <Plus className="h-3.5 w-3.5" /> Add price rule
              </Button>
            </div>
            <span className="text-xs text-muted-foreground">
              Each rule sets one currency + amount for a list of countries — e.g. EUR 9.99 for
              Germany, France, and Spain in one rule instead of three separate rows.
            </span>
            <RuleRowsEditor rules={draft.rules} onUpdate={updateRule} onRemove={removeRule} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="plan-tax-collection">Tax collection</Label>
            <Select
              id="plan-tax-collection"
              className="w-48"
              value={draft.taxCollection}
              onChange={(e) =>
                setDraft((d) => ({ ...d, taxCollection: e.target.value as TaxCollectionMode }))
              }
            >
              {TAX_COLLECTION_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {TAX_COLLECTION_LABELS[mode]}
                </option>
              ))}
            </Select>
            <span className="text-xs text-muted-foreground">
              &quot;Global&quot; defers to the account-level tax setting; Enabled/Disabled overrides
              it for this plan only.
            </span>
          </div>

          {isRecurring ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Switch
                  id="trial-enabled"
                  checked={draft.trial.enabled}
                  onCheckedChange={(checked) =>
                    setDraft((d) => ({ ...d, trial: { ...d.trial, enabled: checked } }))
                  }
                />
                <Label htmlFor="trial-enabled">Trial</Label>
              </div>

              {draft.trial.enabled ? (
                <div className="flex flex-col gap-3 rounded-lg bg-muted p-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">Trial length</span>
                    <Input
                      type="number"
                      min={1}
                      className="w-20"
                      value={draft.trial.intervalCount}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          trial: { ...d.trial, intervalCount: Number(e.target.value) },
                        }))
                      }
                    />
                    <Select
                      aria-label="Trial length unit"
                      value={draft.trial.intervalUnit}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          trial: { ...d.trial, intervalUnit: e.target.value as BillingIntervalUnit },
                        }))
                      }
                    >
                      {BILLING_INTERVAL_UNITS.map((unit) => (
                        <option key={unit} value={unit}>
                          {unit}
                        </option>
                      ))}
                    </Select>
                  </div>

                  <div className="flex items-center justify-between">
                    <Label>Trial price</Label>
                    <Button type="button" size="sm" variant="outline" onClick={addTrialPriceRow}>
                      <Plus className="h-3.5 w-3.5" /> Add currency / country
                    </Button>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    Set to 0 for a free trial. Add a row per country the same way as pricing above.
                  </span>
                  <PriceRowsEditor
                    rows={draft.trial.prices}
                    onUpdate={updateTrialPriceRow}
                    onRemove={removeTrialPriceRow}
                    allowEmptyRemove
                  />

                  <div className="flex items-center justify-between">
                    <Label>Trial price overrides</Label>
                    <Button type="button" size="sm" variant="outline" onClick={addTrialRule}>
                      <Plus className="h-3.5 w-3.5" /> Add price rule
                    </Button>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    Per-country/currency overrides for the trial price, same shape as the plan-level
                    price overrides above.
                  </span>
                  <RuleRowsEditor
                    rules={draft.trial.rules}
                    onUpdate={updateTrialRule}
                    onRemove={removeTrialRule}
                  />
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" size="sm" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={!canSave} onClick={() => onSave(draft)}>
            {initial ? "Save changes" : "Create plan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PriceRowsEditor({
  rows,
  onUpdate,
  onRemove,
  allowEmptyRemove,
}: {
  rows: PriceRow[];
  onUpdate: (rowId: string, patch: Partial<PriceRow>) => void;
  onRemove: (rowId: string) => void;
  allowEmptyRemove: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, index) => (
        <div key={row.id} className="flex items-center gap-2">
          <Select
            aria-label="Currency"
            className="w-24"
            value={row.currency}
            onChange={(e) => onUpdate(row.id, { currency: e.target.value })}
          >
            {COMMON_CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
          <Input
            type="number"
            min={0}
            step={0.01}
            className="w-28"
            value={toMajor(row.amountMinorUnits)}
            onChange={(e) => onUpdate(row.id, { amountMinorUnits: toMinor(e.target.value) })}
          />
          {index === 0 ? (
            <span className="w-40 text-sm text-muted-foreground">All countries (default)</span>
          ) : (
            <Select
              aria-label="Country"
              className="w-40"
              value={row.country}
              onChange={(e) => onUpdate(row.id, { country: e.target.value })}
            >
              <option value="" disabled>
                Select country&hellip;
              </option>
              {COUNTRIES.map((country) => (
                <option key={country.code} value={country.code}>
                  {country.name}
                </option>
              ))}
            </Select>
          )}
          {index > 0 || allowEmptyRemove ? (
            <button
              type="button"
              onClick={() => onRemove(row.id)}
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/**
 * Editor for PriceOverrideRule rows — each rule is one currency + amount
 * applied to a *multi-select list* of countries (unlike PriceRowsEditor
 * above, which is one country per row). The country multi-select is a
 * plain native <select multiple>, matching this project's convention of
 * using native form controls wrapped in the shared Select styling rather
 * than a bespoke combobox.
 */
function RuleRowsEditor({
  rules,
  onUpdate,
  onRemove,
}: {
  rules: PriceOverrideRule[];
  onUpdate: (rowId: string, patch: Partial<PriceOverrideRule>) => void;
  onRemove: (rowId: string) => void;
}) {
  if (rules.length === 0) {
    return <span className="text-xs text-muted-foreground">No price overrides yet.</span>;
  }

  return (
    <div className="flex flex-col gap-3">
      {rules.map((rule) => (
        <div key={rule.id} className="flex items-start gap-2 rounded-md border border-border p-2">
          <Select
            aria-label="Currency"
            className="w-24"
            value={rule.currency}
            onChange={(e) => onUpdate(rule.id, { currency: e.target.value })}
          >
            {COMMON_CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
          <Input
            type="number"
            min={0}
            step={0.01}
            className="w-28"
            value={toMajor(rule.amountMinorUnits)}
            onChange={(e) => onUpdate(rule.id, { amountMinorUnits: toMinor(e.target.value) })}
          />
          <Select
            aria-label="Countries"
            multiple
            className="h-24 w-48"
            value={rule.countries}
            onChange={(e) =>
              onUpdate(rule.id, {
                countries: Array.from(e.target.selectedOptions).map((opt) => opt.value),
              })
            }
          >
            {COUNTRIES.map((country) => (
              <option key={country.code} value={country.code}>
                {country.name}
              </option>
            ))}
          </Select>
          <button
            type="button"
            onClick={() => onRemove(rule.id)}
            className="mt-1.5 text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
