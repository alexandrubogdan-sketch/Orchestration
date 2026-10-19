import { create } from "zustand";

export const API_RESOURCES = [
  { id: "payments", label: "Payments", description: "Create, capture, void, refund and list payments" },
  { id: "customers", label: "Customers", description: "Read customers and their saved payment methods" },
  { id: "api_keys", label: "API keys", description: "Create and revoke other API keys" },
] as const;

export type ApiResourceId = (typeof API_RESOURCES)[number]["id"];
export type Access = "none" | "read" | "write";
export type AccessMatrix = Record<ApiResourceId, Access>;
export type AccessPreset = "full" | "read_only" | "custom";

export interface ApiKey {
  id: string;
  name: string;
  prefix: string | null;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  secret?: string;
}

export const FULL_ACCESS = "*";

export function scopesFromMatrix(matrix: AccessMatrix): string[] {
  return API_RESOURCES.flatMap(({ id }) => (matrix[id] === "none" ? [] : [`${id}:${matrix[id]}`]));
}

export function scopesForPreset(preset: AccessPreset, matrix: AccessMatrix): string[] {
  if (preset === "full") return [FULL_ACCESS];
  if (preset === "read_only") return API_RESOURCES.map(({ id }) => `${id}:read`);
  return scopesFromMatrix(matrix);
}

export function accessFor(scopes: string[], resource: ApiResourceId): Access {
  if (scopes.includes(FULL_ACCESS) || scopes.includes(`${resource}:write`)) return "write";
  return scopes.includes(`${resource}:read`) ? "read" : "none";
}

export function describeAccess(scopes: string[]): string {
  if (scopes.includes(FULL_ACCESS)) return "Full access";
  if (API_RESOURCES.every(({ id }) => accessFor(scopes, id) === "read")) return "Read only";
  return "Restricted";
}

function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return Array.from(values, (v) => v.toString(16).padStart(2, "0")).join("");
}

function sandboxKey(name: string, scopes: string[], createdAt: string, lastUsedAt: string | null): ApiKey {
  const secret = `po_${randomHex(24)}`;
  return { id: crypto.randomUUID(), name, prefix: secret.slice(0, 11), scopes, createdAt, lastUsedAt, revokedAt: null };
}

interface SandboxKeysState {
  keys: ApiKey[] | null;
  seed: () => void;
  create: (name: string, scopes: string[]) => ApiKey;
  revoke: (id: string) => void;
}

export const useSandboxKeys = create<SandboxKeysState>((set, get) => ({
  keys: null,
  seed: () => {
    if (get().keys) return;
    const day = 86_400_000;
    const now = Date.now();
    set({
      keys: [
        sandboxKey("Checkout backend", [FULL_ACCESS], new Date(now - 41 * day).toISOString(), new Date(now - 120_000).toISOString()),
        sandboxKey("Finance reporting", ["payments:read", "customers:read"], new Date(now - 9 * day).toISOString(), new Date(now - 3 * 3_600_000).toISOString()),
      ],
    });
  },
  create: (name, scopes) => {
    const secret = `po_${randomHex(24)}`;
    const key: ApiKey = {
      id: crypto.randomUUID(),
      name,
      prefix: secret.slice(0, 11),
      scopes,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    };
    set({ keys: [key, ...(get().keys ?? [])] });
    return { ...key, secret };
  },
  revoke: (id) =>
    set({
      keys: (get().keys ?? []).map((k) => (k.id === id ? { ...k, revokedAt: new Date().toISOString() } : k)),
    }),
}));
