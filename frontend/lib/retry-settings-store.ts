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

export function toDunningLadderHours(ladder: DunningLadderStep[]): number[] {
  return ladder.map((step) => step.waitHours);
}

function fromDunningLadderHours(hours: number[]): DunningLadderStep[] {
  return hours.map((waitHours) => ({ id: randomStepId(), waitHours }));
}

interface RetrySettingsState {
  policy: RetryPolicy;

  addLadderStep: () => void;
  updateLadderStep: (id: string, waitHours: number) => void;
  removeLadderStep: (id: string) => void;
  moveLadderStep: (id: string, direction: "up" | "down") => void;

  setMaxAttemptsPerPayment: (value: number) => void;
  setMinSpacingSeconds: (value: number) => void;

  savePolicy: () => void;

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
