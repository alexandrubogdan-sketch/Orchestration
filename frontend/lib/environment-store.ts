import { create } from "zustand";

/** "sandbox" is the existing, unchanged demo experience — every read and
 *  write in the app runs through mock-data.ts / the SDK's injected
 *  fetchImpl, never a real network call. "live" is the new mode: pages
 *  and the Checkout preview call the real backend through this app's
 *  own /api/* route handlers (see app/api/checkout, app/api/payments,
 *  app/api/customers), which hold the backend's Bearer token
 *  server-side and forward to backend-go. Defaulting to "sandbox" and
 *  NOT persisting this across reloads is deliberate: a page refresh
 *  should always land back in the safe, fake-data mode rather than
 *  silently staying in "live" from a previous session. */
export type Environment = "sandbox" | "live";

interface EnvironmentState {
  environment: Environment;
  setEnvironment: (environment: Environment) => void;
}

export const useEnvironmentStore = create<EnvironmentState>((set) => ({
  environment: "sandbox",
  setEnvironment: (environment) => set({ environment }),
}));
