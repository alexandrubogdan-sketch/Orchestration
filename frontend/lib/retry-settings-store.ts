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

/** The inverse of toDunningLadderHours — rehydrates the client-side
 *  editable ladder (stable ids for list operations) from the plain
 *  `number[]` a real GET/PUT /v1/retry-settings response actually
 *  carries. Added 2026-07-08 alongside setPolicyFromServer below, once
 *  app/workflows/retries/page.tsx started calling the real backend in
 *  Live mode instead of only ever reading this store's local defaults. */
function fromDunningLadderHours(hours: number[]): DunningLadderStep[] {
  return hours.map((waitHours) => ({ id: randomStepId(), waitHours }));
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
   * Persists the current policy — for Sandbox mode this just means
   * "already is the current Zustand state," so this remains a no-op,
   * exactly as it always has been. This action's own doc comment used
   * to describe a real `PUT /v1/retry-settings` call as a hypothetical
   * one-line change to make here; as of 2026-07-08 that wiring exists,
   * but lives in app/workflows/retries/page.tsx's handleSave (via
   * lib/live-api.ts's putLiveRetrySettings), not in this action —
   * Live mode's save button calls that instead of this one. This stays
   * a plain local no-op so Sandbox's "Save policy" button keeps doing
   * exactly what it always did.
   */
  savePolicy: () => void;

  /** Rehydrates `policy` from a real GET/PUT /v1/retry-settings
   *  response (lib/live-api.ts's LiveRetrySettings) — the Live-mode
   *  counterpart to resetToDefaults below. Called from
   *  app/workflows/retries/page.tsx after both the initial Live-mode
   *  GET and every successful PUT, so the ladder/policy shown always
   *  matches what the backend actually has stored (rather than
   *  optimistically trusting the client's pre-save state, which could
   *  drift from a normalized/validated server response). */
  setPolicyFromServer: (dto: {
    dunningLadderHours: number[];
    maxAttemptsPerPayment: number;
    minSpacingSeconds: number;
  }) => void;

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

  // See this action's own doc comment above (on the interface) — a
  // deliberate, permanent no-op for Sandbox mode. Live mode's save
  // button does not call this; see app/workflows/retries/page.tsx.
  savePolicy: () => {},

  setPolicyFromServer: (dto) =>
    set({
      policy: {
        ladder: fromDunningLadderHours(dto.dunningLadderHours),
        maxAttemptsPerPayment: dto.maxAttemptsPerPayment,
        minSpacingSeconds: dto.minSpacingSeconds,
      },
    }),

  resetToDefaults: () => set({ policy: defaultRetryPolicy() }),
}));
