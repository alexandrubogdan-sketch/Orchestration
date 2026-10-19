import { create } from "zustand";
import { getInitialCheckoutMethods, nextCheckoutId } from "./mock-data";
import type {
  CheckoutConditionBlock,
  CheckoutMethod,
  CheckoutMethodType,
  CheckoutProcessorSplit,
  ProcessorId,
} from "./types";

function cloneMethods(methods: CheckoutMethod[]): CheckoutMethod[] {
  return methods.map((m) => ({
    ...m,
    conditionBlocks: m.conditionBlocks.map((b) => ({ ...b, countries: [...b.countries], splits: b.splits.map((s) => ({ ...s })) })),
    merchantSplit: m.merchantSplit.map((s) => ({ ...s })),
  }));
}

interface CheckoutState {
  methods: CheckoutMethod[];

  initialMethods: CheckoutMethod[];
  selectedMethodId: string;
  isPublishing: boolean;
  lastPublishedAt: string | null;

  selectMethod: (id: string) => void;
  toggleMethodEnabled: (id: string) => void;
  reorderActiveMethods: (orderedIds: string[]) => void;

  addConditionBlock: (methodId: string) => void;
  updateConditionBlock: (methodId: string, blockId: string, patch: Partial<Omit<CheckoutConditionBlock, "id" | "splits">>) => void;
  removeConditionBlock: (methodId: string, blockId: string) => void;
  reorderConditionBlocks: (methodId: string, orderedBlockIds: string[]) => void;
  updateConditionSplits: (methodId: string, blockId: string, splits: CheckoutProcessorSplit[]) => void;
  updateMerchantSplit: (methodId: string, splits: CheckoutProcessorSplit[]) => void;

  publish: () => void;
  resetToPublished: () => void;
}

function withMethod(
  methods: CheckoutMethod[],
  id: string,
  update: (method: CheckoutMethod) => CheckoutMethod,
): CheckoutMethod[] {
  return methods.map((m) => (m.id === id ? update(m) : m));
}

export const useCheckoutStore = create<CheckoutState>((set) => {
  const initial = getInitialCheckoutMethods();
  const cardMethod = initial.find((m) => m.type === "card") ?? initial[0]!;

  return {
    methods: initial,
    initialMethods: cloneMethods(initial),
    selectedMethodId: cardMethod.id,
    isPublishing: false,
    lastPublishedAt: null,

    selectMethod: (id) => set({ selectedMethodId: id }),

    toggleMethodEnabled: (id) =>
      set((state) => {
        const target = state.methods.find((m) => m.id === id);
        if (!target || target.locked) return state;

        const nextEnabled = !target.enabled;
        const card = state.methods.find((m) => m.locked);
        const rest = state.methods.filter((m) => m.id !== id && !m.locked);
        const changed = { ...target, enabled: nextEnabled };

        const reordered = nextEnabled
          ? [...rest, changed, ...(card ? [card] : [])]
          : [changed, ...rest, ...(card ? [card] : [])];

        return { methods: reordered.map((m, index) => ({ ...m, order: index })) };
      }),

    reorderActiveMethods: (orderedIds) =>
      set((state) => {
        const byId = new Map(state.methods.map((m) => [m.id, m]));
        const activeUnlocked = orderedIds.map((id) => byId.get(id)).filter((m): m is CheckoutMethod => !!m);
        const activeLocked = state.methods.filter((m) => m.enabled && m.locked);
        const inactive = state.methods.filter((m) => !m.enabled);
        const combined = [...activeUnlocked, ...activeLocked, ...inactive];
        return { methods: combined.map((m, index) => ({ ...m, order: index })) };
      }),

    addConditionBlock: (methodId) =>
      set((state) => ({
        methods: withMethod(state.methods, methodId, (m) => ({
          ...m,
          conditionBlocks: [
            ...m.conditionBlocks,
            {
              id: nextCheckoutId("cond"),
              countryMatchType: "one_of",
              countries: [],
              splits: [{ id: nextCheckoutId("split"), processor: "stripe" as ProcessorId, sharePercent: 100 }],
            },
          ],
        })),
      })),

    updateConditionBlock: (methodId, blockId, patch) =>
      set((state) => ({
        methods: withMethod(state.methods, methodId, (m) => ({
          ...m,
          conditionBlocks: m.conditionBlocks.map((b) => (b.id === blockId ? { ...b, ...patch } : b)),
        })),
      })),

    removeConditionBlock: (methodId, blockId) =>
      set((state) => ({
        methods: withMethod(state.methods, methodId, (m) => ({
          ...m,
          conditionBlocks: m.conditionBlocks.filter((b) => b.id !== blockId),
        })),
      })),

    reorderConditionBlocks: (methodId, orderedBlockIds) =>
      set((state) => ({
        methods: withMethod(state.methods, methodId, (m) => {
          const byId = new Map(m.conditionBlocks.map((b) => [b.id, b]));
          const reordered = orderedBlockIds.map((id) => byId.get(id)).filter((b): b is CheckoutConditionBlock => !!b);
          return { ...m, conditionBlocks: reordered };
        }),
      })),

    updateConditionSplits: (methodId, blockId, splits) =>
      set((state) => ({
        methods: withMethod(state.methods, methodId, (m) => ({
          ...m,
          conditionBlocks: m.conditionBlocks.map((b) => (b.id === blockId ? { ...b, splits } : b)),
        })),
      })),

    updateMerchantSplit: (methodId, splits) =>
      set((state) => ({
        methods: withMethod(state.methods, methodId, (m) => ({ ...m, merchantSplit: splits })),
      })),

    publish: () => {
      set({ isPublishing: true });
      setTimeout(() => {
        set((state) => ({
          isPublishing: false,
          initialMethods: cloneMethods(state.methods),
          lastPublishedAt: new Date().toISOString(),
        }));
      }, 500);
    },

    resetToPublished: () => set((state) => ({ methods: cloneMethods(state.initialMethods) })),
  };
});

export function useIsCheckoutDirty(): boolean {
  const methods = useCheckoutStore((s) => s.methods);
  const initialMethods = useCheckoutStore((s) => s.initialMethods);
  return JSON.stringify(methods) !== JSON.stringify(initialMethods);
}

export function useSelectedCheckoutMethod(): CheckoutMethod | undefined {
  const methods = useCheckoutStore((s) => s.methods);
  const selectedMethodId = useCheckoutStore((s) => s.selectedMethodId);
  return methods.find((m) => m.id === selectedMethodId);
}

export type { CheckoutMethodType };
