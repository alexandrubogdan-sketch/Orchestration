import { create } from "zustand";
import type { Plan } from "./types";
import { defaultPlans } from "./mock-data";

function randomId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

type PlanDraft = Omit<Plan, "id" | "createdAt" | "updatedAt">;

interface PlanStoreState {
  plans: Plan[];
  createPlan: (plan: PlanDraft) => string;
  updatePlan: (id: string, plan: PlanDraft) => void;
  deletePlan: (id: string) => void;
  /** Clones a plan into a brand-new plan with a new id, "(copy)" appended
   *  to the name, and fresh created/updated timestamps. Returns the new
   *  plan's id so the caller can open it straight into the edit form. */
  duplicatePlan: (id: string) => string | null;
  reset: () => void;
}

export const usePlanStore = create<PlanStoreState>((set, get) => ({
  plans: defaultPlans(),

  createPlan: (plan) => {
    const id = randomId("plan");
    const now = new Date().toISOString();
    set((state) => ({
      plans: [...state.plans, { ...plan, id, createdAt: now, updatedAt: now }],
    }));
    return id;
  },

  updatePlan: (id, plan) =>
    set((state) => ({
      plans: state.plans.map((p) =>
        p.id === id
          ? { ...plan, id, createdAt: p.createdAt, updatedAt: new Date().toISOString() }
          : p,
      ),
    })),

  deletePlan: (id) => set((state) => ({ plans: state.plans.filter((p) => p.id !== id) })),

  duplicatePlan: (id) => {
    const source = get().plans.find((p) => p.id === id);
    if (!source) return null;
    const newId = randomId("plan");
    const now = new Date().toISOString();
    const clone: Plan = {
      ...source,
      id: newId,
      name: `${source.name} (copy)`,
      prices: source.prices.map((row) => ({ ...row, id: randomRowId("price") })),
      rules: source.rules.map((rule) => ({ ...rule, id: randomRowId("rule") })),
      trial: {
        ...source.trial,
        prices: source.trial.prices.map((row) => ({ ...row, id: randomRowId("trial-price") })),
        rules: source.trial.rules.map((rule) => ({ ...rule, id: randomRowId("trial-rule") })),
      },
      createdAt: now,
      updatedAt: now,
    };
    set((state) => ({ plans: [...state.plans, clone] }));
    return newId;
  },

  reset: () => set({ plans: defaultPlans() }),
}));

export function randomRowId(prefix: string): string {
  return randomId(prefix);
}
