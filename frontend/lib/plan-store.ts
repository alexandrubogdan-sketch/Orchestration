import { create } from "zustand";
import type { Plan } from "./types";
import { defaultPlans } from "./mock-data";

function randomId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

interface PlanStoreState {
  plans: Plan[];
  createPlan: (plan: Omit<Plan, "id" | "createdAt">) => string;
  updatePlan: (id: string, plan: Omit<Plan, "id" | "createdAt">) => void;
  deletePlan: (id: string) => void;
  reset: () => void;
}

export const usePlanStore = create<PlanStoreState>((set) => ({
  plans: defaultPlans(),

  createPlan: (plan) => {
    const id = randomId("plan");
    set((state) => ({
      plans: [...state.plans, { ...plan, id, createdAt: new Date().toISOString() }],
    }));
    return id;
  },

  updatePlan: (id, plan) =>
    set((state) => ({
      plans: state.plans.map((p) => (p.id === id ? { ...plan, id, createdAt: p.createdAt } : p)),
    })),

  deletePlan: (id) => set((state) => ({ plans: state.plans.filter((p) => p.id !== id) })),

  reset: () => set({ plans: defaultPlans() }),
}));

export function randomRowId(prefix: string): string {
  return randomId(prefix);
}
