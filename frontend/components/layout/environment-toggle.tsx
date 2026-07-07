"use client";

import { cn } from "@/lib/utils";
import { useEnvironmentStore } from "@/lib/environment-store";

/** Sidebar-only Sandbox/Live switch. Deliberately styled as two labeled
 *  buttons rather than a single ambiguous on/off Switch (the kind used
 *  in components/checkout/checkout-conditions.tsx) — "Live" is
 *  highlighted in a warning color so it's unmistakable at a glance that
 *  real backend calls (backend-go, via this app's own /api/* proxy
 *  routes) are active, not the default mock-data demo. */
export function EnvironmentToggle() {
  const environment = useEnvironmentStore((state) => state.environment);
  const setEnvironment = useEnvironmentStore((state) => state.setEnvironment);

  return (
    <div
      role="group"
      aria-label="Environment"
      className="flex items-center gap-0.5 rounded-full border border-border bg-neutral-bg p-0.5"
    >
      <button
        type="button"
        aria-pressed={environment === "sandbox"}
        onClick={() => setEnvironment("sandbox")}
        className={cn(
          "rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors",
          environment === "sandbox"
            ? "bg-surface text-foreground shadow-xs"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        Sandbox
      </button>
      <button
        type="button"
        aria-pressed={environment === "live"}
        onClick={() => setEnvironment("live")}
        className={cn(
          "rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors",
          environment === "live"
            ? "bg-red-500 text-white shadow-xs"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        Live
      </button>
    </div>
  );
}
