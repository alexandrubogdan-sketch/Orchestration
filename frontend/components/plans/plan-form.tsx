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
  type BillingIntervalUnit,
  type Plan,
  type PriceRow,
} from "@/lib/types";

function emptyPriceRow(country: string): PriceRow {
  return { id: randomRowId("price"), currency: "USD", amountMinorUnits: 0, country };
}

function toMajor(minor: number): string {
  return (minor / 100).toFixed(2);
}

function toMinor(major: string): number {
  const parsed = Number.parseFloat(major);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

function emptyPlan(): Omit<Plan, "id" | "createdAt"> {
  return {
    name: "",
    billingIntervalUnit: "months",
    billingIntervalCount: 1,
    prices: [emptyPriceRow(DEFAULT_PRICE_COUNTRY)],
    trial: { enabled: false, intervalUnit: "days", intervalCount: 7, prices: [] },
  };
}

/**
 * Create/edit form for a Plan — modeled on
 * docs.paynext.com/guides/platform/plans: a default ("all countries")
 * price plus any number of country-specific override rows, an optional
 * billing interval, and an optional trial with its own price rows.
 */
export function PlanForm({
  initial,
  onSave,
  onClose,
}: {
  initial?: Plan;
  onSave: (plan: Omit<Plan, "id" | "createdAt">) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Omit<Plan, "id" | "createdAt">>(
    initial ? { ...initial } : emptyPlan(),
  );

  const canSave = draft.name.trim().length > 0 && draft.prices.length > 0;

  function updatePriceRow(rowId: string, patch: Partial<PriceRow>) {
    setDraft((d) => ({ ...d, prices: d.prices.map((r) => (r.id === rowId ? { ...r, ...patch } : r)) }));
  }
  function addPriceRow() {
    setDraft((d) => ({ ...d, prices: [...d.prices, emptyPriceRow("")] }));
  }
  function removePriceRow(rowId: string) {
    setDraft((d) => ({ ...d, prices: d.prices.filter((r) => r.id !== rowId) }));
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

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label>Pricing</Label>
              <Button type="button" size="sm" variant="outline" onClick={addPriceRow}>
                <Plus className="h-3.5 w-3.5" /> Add currency / country
              </Button>
            </div>
            <span className="text-xs text-muted-foreground">
              The first row is the default price for all countries. Add a row per country to
              override it — e.g. USD 29.99 for all countries, then CAD 33.99 for CA.
            </span>
            <PriceRowsEditor
              rows={draft.prices}
              onUpdate={updatePriceRow}
              onRemove={removePriceRow}
              allowEmptyRemove={draft.prices.length > 1}
            />
          </div>

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
                  <Label>Trial amount</Label>
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
              </div>
            ) : null}
          </div>
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
