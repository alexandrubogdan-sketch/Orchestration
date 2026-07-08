"use client";

import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useEnvironmentStore } from "@/lib/environment-store";

/** Sidebar-only Sandbox/Live switch. Rendered as an actual on/off Switch
 *  (components/ui/switch.tsx) instead of two look-alike pill buttons, so
 *  the current mode reads unmistakably as a toggle at a glance. "Live" is
 *  the checked/on position, but it's deliberately kept in a warning color
 *  (red) rather than the default primary accent — the same safety
 *  reasoning as before: real backend calls (backend-go, via this app's
 *  own /api/* proxy routes) are active in Live mode, not the default
 *  mock-data demo, and that must stay visually unmistakable, not just
 *  inferable from thumb position alone. */
export function EnvironmentToggle() {
  const environment = useEnvironmentStore((state) => state.environment);
  const setEnvironment = useEnvironmentStore((state) => state.setEnvironment);

  const isLive = environment === "live";

  return (
    <div
      role="group"
      aria-label="Environment"
      className="flex items-center gap-2 rounded-full border border-border bg-neutral-bg px-2.5 py-1"
    >
      <span
        className={cn(
          "text-[11px] font-medium transition-colors",
          !isLive ? "text-foreground" : "text-muted-foreground",
        )}
      >
        Sandbox
      </span>
      <Switch
        checked={isLive}
        onCheckedChange={(checked) => setEnvironment(checked ? "live" : "sandbox")}
        aria-label={isLive ? "Switch to Sandbox mode" : "Switch to Live mode"}
        className={cn(isLive && "data-[state=checked]:bg-red-500")}
      />
      <span
        className={cn(
          "text-[11px] font-semibold transition-colors",
          isLive ? "text-red-500" : "text-muted-foreground",
        )}
      >
        Live
      </span>
    </div>
  );
}
