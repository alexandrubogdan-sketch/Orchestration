import { create } from "zustand";
import type { Integration } from "./types";
import { defaultIntegrations } from "./mock-data";

interface IntegrationStoreState {
  integrations: Integration[];
  /** Mock-only: stores nothing server-side, just flips local state so the
   *  UI reflects "connected" — see frontend README known gaps for what a
   *  real Stripe/Solidgate OAuth or API-key exchange would need. */
  connect: (id: string, apiKey: string) => void;
  disconnect: (id: string) => void;
  reset: () => void;
}

function maskKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 4) return "••••";
  return `••••${trimmed.slice(-4)}`;
}

export const useIntegrationStore = create<IntegrationStoreState>((set) => ({
  integrations: defaultIntegrations(),

  connect: (id, apiKey) =>
    set((state) => ({
      integrations: state.integrations.map((i) =>
        i.id === id
          ? { ...i, status: "connected", connectedAt: new Date().toISOString(), keyPreview: maskKey(apiKey) }
          : i,
      ),
    })),

  disconnect: (id) =>
    set((state) => ({
      integrations: state.integrations.map((i) =>
        i.id === id ? { ...i, status: "not_connected", connectedAt: undefined, keyPreview: undefined } : i,
      ),
    })),

  reset: () => set({ integrations: defaultIntegrations() }),
}));
