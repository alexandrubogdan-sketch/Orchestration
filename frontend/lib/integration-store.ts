import { create } from "zustand";
import type { Integration, IntegrationMode, ProcessorId } from "./types";
import { PROCESSOR_CREDENTIAL_FIELDS } from "./types";
import { defaultIntegrations } from "./mock-data";

function randomId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

interface IntegrationStoreState {
  integrations: Integration[];

  connect: (
    id: string,
    processor: ProcessorId,
    mode: IntegrationMode,
    credentials: Record<string, string>,
    descriptors?: string[],
  ) => void;

  updateIntegration: (
    id: string,
    processor: ProcessorId,
    mode: IntegrationMode,
    credentials: Record<string, string>,
    descriptors?: string[],
  ) => void;
  disconnect: (id: string) => void;

  addIntegration: (processor: ProcessorId, displayName: string) => string;
  removeIntegration: (id: string) => void;
  reset: () => void;
}

function maskValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 4) return "••••";
  return `••••${trimmed.slice(-4)}`;
}

function buildCredentialPreviews(
  processor: ProcessorId,
  credentials: Record<string, string>,
  existing?: Record<string, string>,
): Record<string, string> {
  const fields = PROCESSOR_CREDENTIAL_FIELDS[processor];
  const previews: Record<string, string> = {};
  for (const field of fields) {
    const value = credentials[field.key] ?? "";
    if (value.trim().length === 0 && existing?.[field.key]) {
      previews[field.key] = existing[field.key];
      continue;
    }
    previews[field.key] = field.secret ? maskValue(value) : value;
  }
  return previews;
}

function cleanDescriptors(descriptors?: string[]): string[] | undefined {
  const cleaned = descriptors?.map((d) => d.trim()).filter((d) => d.length > 0);
  return cleaned && cleaned.length > 0 ? cleaned : undefined;
}

export const useIntegrationStore = create<IntegrationStoreState>((set) => ({
  integrations: defaultIntegrations(),

  connect: (id, processor, mode, credentials, descriptors) =>
    set((state) => ({
      integrations: state.integrations.map((i) =>
        i.id === id
          ? {
              ...i,
              status: "connected",
              connectedAt: new Date().toISOString(),
              mode,
              credentialPreviews: buildCredentialPreviews(processor, credentials),
              descriptors: cleanDescriptors(descriptors),
            }
          : i,
      ),
    })),

  updateIntegration: (id, processor, mode, credentials, descriptors) =>
    set((state) => ({
      integrations: state.integrations.map((i) =>
        i.id === id
          ? {
              ...i,
              mode,
              credentialPreviews: buildCredentialPreviews(processor, credentials, i.credentialPreviews),
              descriptors: cleanDescriptors(descriptors),
            }
          : i,
      ),
    })),

  disconnect: (id) =>
    set((state) => ({
      integrations: state.integrations.map((i) =>
        i.id === id
          ? { ...i, status: "not_connected", connectedAt: undefined, mode: undefined, credentialPreviews: undefined }
          : i,
      ),
    })),

  addIntegration: (processor, displayName) => {
    const id = randomId("integration");
    set((state) => ({
      integrations: [
        ...state.integrations,
        { id, processor, displayName, status: "not_connected" },
      ],
    }));
    return id;
  },

  removeIntegration: (id) =>
    set((state) => ({ integrations: state.integrations.filter((i) => i.id !== id) })),

  reset: () => set({ integrations: defaultIntegrations() }),
}));
