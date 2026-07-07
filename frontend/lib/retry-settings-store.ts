import { create } from "zustand";
import {
  DEFAULT_DUNNING_LADDER_HOURS,
  DEFAULT_MAX_ATTEMPTS_PER_PAYMENT,
  DEFAULT_MIN_SPACING_SECONDS,
  type DunningLadderStep,
  type RetryPolicy,
} from "./types";

function randomStepId(): string {
  return `step-${Math.random().toString(36).slice(2, 9)}`;
}

function defaultRetryPolicy(): RetryPolicy {
  return {
    ladder: DEFAULT_DUNNING_LADDER_HOURS.map((waitHours) => ({ id: randomStepId(), waitHours })),
    maxAttemptsPerPayment: DEFAULT_MAX_ATTEMPTS_PER_PAYMENT,
    minSpacingSeconds: DEFAULT_MIN_SPACING_SECONDS,
  };
}

/** Converts the store's client-side ladder (with stable ids for list
 *  editing) into the plain `number[]` shape the real backend's
 *  `dunningLadderHours` column/DTO field actually is
 *  (payment-orchestrator-go/internal/api/retry_settings.go's
 *  RetrySettingsDTO.DunningLadderHours) — this is exactly the
 *  conversion a real `PUT /v1/retry-settings` request body would need,
 *  so it's written here now even though nothing calls fetch() yet. */
export function toDunningLadderHours(ladder: DunningLadderStep[]): number[] {
  return ladder.map((step) => step.waitHours);
}

interface RetrySettingsState {
  policy: RetryPolicy;

  /** Ladder editing — add/remove/reorder, mirroring the Plans price-
   *  rows editor's own update/add/remove trio (lib/plan-store.ts). */
  addLadderStep: () => void;
  updateLadderStep: (id: string, waitHours: number) => void;
  removeLadderStep: (id: string) => void;
  moveLadderStep: (id: string, direction: "up" | "down") => void;

  setMaxAttemptsPerPayment: (value: number) => void;
  setMinSpacingSeconds: (value: number) => void;

  /**
   * Persists the current policy — for now, that just means "already is
   * the current Zustand state," so this is a no-op today. It exists as
   * its own action (rather than callers relying on the setters above
   * having already committed) so wiring in a real backend later is a
   * ONE-LINE change: replace this function's body with
   * `await putRetrySettings({ dunningLadderHours: toDunningLadderHours(get().policy.ladder), maxAttemptsPerPayment: get().policy.maxAttemptsPerPayment, minSpacingSeconds: get().policy.minSpacingSeconds })`
   * (a fetch()/ky call to PUT /v1/retry-settings, matching
   * payment-orchestrator-go/internal/api/retry_settings.go's
   * UpsertRetrySettingsRequest shape exactly) — every field this action
   * would need to send already exists on `policy` in the right shape.
   * See app/workflows/retries/page.tsx's "Save policy" button, the one
   * call site.
   */
  savePolicy: () => void;

  resetToDefaults: () => void;
}

export const useRetrySettingsStore = create<RetrySettingsState>((set) => ({
  policy: defaultRetryPolicy(),

  addLadderStep: () =>
    set((state) => ({
      policy: {
        ...state.policy,
        ladder: [
          ...state.policy.ladder,
          { id: randomStepId(), waitHours: state.policy.ladder.at(-1)?.waitHours ?? 24 },
        ],
      },
    })),

  updateLadderStep: (id, waitHours) =>
    set((state) => ({
      policy: {
        ...state.policy,
        ladder: state.policy.ladder.map((step) => (step.id === id ? { ...step, waitHours } : step)),
      },
    })),

  removeLadderStep: (id) =>
    set((state) => ({
      policy: { ...state.policy, ladder: state.policy.ladder.filter((step) => step.id !== id) },
    })),

  moveLadderStep: (id, direction) =>
    set((state) => {
      const ladder = [...state.policy.ladder];
      const index = ladder.findIndex((step) => step.id === id);
      const targetIndex = direction === "up" ? index - 1 : index + 1;
      if (index === -1 || targetIndex < 0 || targetIndex >= ladder.length) {
        return state;
      }
      [ladder[index], ladder[targetIndex]] = [ladder[targetIndex]!, ladder[index]!];
      return { policy: { ...state.policy, ladder } };
    }),

  setMaxAttemptsPerPayment: (value) =>
    set((state) => ({ policy: { ...state.policy, maxAttemptsPerPayment: value } })),

  setMinSpacingSeconds: (value) =>
    set((state) => ({ policy: { ...state.policy, minSpacingSeconds: value } })),

  // See this action's own doc comment above (on the interface) for
  // exactly what a real PUT /v1/retry-settings wiring would replace
  // this body with — intentionally a no-op today since this frontend
  // never calls a real backend (see app/workflows/retries/page.tsx's
  // top doc comment).
  savePolicy: () => {},

  resetToDefaults: () => set({ policy: defaultRetryPolicy() }),
}));
