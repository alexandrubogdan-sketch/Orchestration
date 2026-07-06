"use client";

import { useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { randomRowId } from "@/lib/plan-store";
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 sm:p-8">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-surface shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold">{initial ? "Edit plan" : "Create plan"}</h2>
          <button onClick={onClose} className="text-muted hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          <div className="flex flex-col gap-6">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Plan name</span>
              <Input
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                placeholder="e.g. Pro Monthly"
              />
            </label>

            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Duration</span>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted">Every</span>
                <Input
                  type="number"
                  min={1}
                  className="w-20"
                  value={draft.billingIntervalCount}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, billingIntervalCount: Number(e.target.value) }))
                  }
                />
                <Select
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
                <span className="text-sm font-medium">Pricing</span>
                <Button size="sm" variant="outline" onClick={addPriceRow}>
                  <Plus className="h-3.5 w-3.5" /> Add currency / country
                </Button>
              </div>
              <span className="text-xs text-muted">
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
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={draft.trial.enabled}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, trial: { ...d.trial, enabled: e.target.checked } }))
                  }
                />
                Trial
              </label>

              {draft.trial.enabled ? (
                <div className="flex flex-col gap-3 rounded-lg bg-neutral-bg p-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted">Trial length</span>
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
                    <span className="text-sm font-medium">Trial amount</span>
                    <Button size="sm" variant="outline" onClick={addTrialPriceRow}>
                      <Plus className="h-3.5 w-3.5" /> Add currency / country
                    </Button>
                  </div>
                  <span className="text-xs text-muted">
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
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button size="sm" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canSave} onClick={() => onSave(draft)}>
            {initial ? "Save changes" : "Create plan"}
          </Button>
        </div>
      </div>
    </div>
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
            <span className="w-32 text-sm text-muted">All countries (default)</span>
          ) : (
            <Input
              className="w-32"
              placeholder="Country, e.g. CA"
              value={row.country}
              onChange={(e) => onUpdate(row.id, { country: e.target.value.toUpperCase() })}
            />
          )}
          {index > 0 || allowEmptyRemove ? (
            <button onClick={() => onRemove(row.id)} className="text-muted hover:text-danger">
              <Trash2 className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
