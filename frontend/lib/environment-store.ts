import { create } from "zustand";

export type Environment = "sandbox" | "live";

interface EnvironmentState {
  environment: Environment;
  setEnvironment: (environment: Environment) => void;
}

export const useEnvironmentStore = create<EnvironmentState>((set) => ({
  environment: "sandbox",
  setEnvironment: (environment) => set({ environment }),
}));
