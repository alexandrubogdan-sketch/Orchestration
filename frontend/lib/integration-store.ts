import { create } from "zustand";
import type { Integration, IntegrationMode, ProcessorId } from "./types";
import { PROCESSOR_CREDENTIAL_FIELDS } from "./types";
import { defaultIntegrations } from "./mock-data";

interface IntegrationStoreState {
  integrations: Integration[];
  /** Mock-only: stores nothing server-side, just flips local state so the
   *  UI reflects "connected" — see frontend README known gaps for what a
   *  real Stripe/Solidgate OAuth or API-key exchange would need.
   *  `credentials` is keyed by each processor's CredentialFieldSpec.key
   *  (see lib/types.ts PROCESSOR_CREDENTIAL_FIELDS) — every field for that
   *  processor is required before this is called. */
  connect: (
    id: string,
    processor: ProcessorId,
    mode: IntegrationMode,
    credentials: Record<string, string>,
  ) => void;
  disconnect: (id: string) => void;
  reset: () => void;
}

function maskValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 4) return "••••";
  return `••••${trimmed.slice(-4)}`;
}

/** Builds the masked-preview record for storage: secret fields are always
 *  masked to their last 4 chars, non-secret fields (publishable/public
 *  keys) are shown in full since they aren't sensitive by design. */
function buildCredentialPreviews(
  processor: ProcessorId,
  credentials: Record<string, string>,
): Record<string, string> {
  const fields = PROCESSOR_CREDENTIAL_FIELDS[processor];
  const previews: Record<string, string> = {};
  for (const field of fields) {
    const value = credentials[field.key] ?? "";
    previews[field.key] = field.secret ? maskValue(value) : value;
  }
  return previews;
}

export const useIntegrationStore = create<IntegrationStoreState>((set) => ({
  integrations: defaultIntegrations(),

  connect: (id, processor, mode, credentials) =>
    set((state) => ({
      integrations: state.integrations.map((i) =>
        i.id === id
          ? {
              ...i,
              status: "connected",
              connectedAt: new Date().toISOString(),
              mode,
              credentialPreviews: buildCredentialPreviews(processor, credentials),
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

  reset: () => set({ integrations: defaultIntegrations() }),
}));
