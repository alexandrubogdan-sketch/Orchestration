"use client";

import { History, ListChecks, Workflow as WorkflowIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type WorkflowDetailTab = "canvas" | "runs" | "history";

/**
 * Mirrors the real client's per-workflow WorkflowTabsComponent
 * (module/workflow (singular) — element/tab/workflow-tabs.component.tsx):
 * a line-style tab triplet (Canvas / Runs / History) sitting just below
 * the workflow's own top bar (name, status chip, save/publish actions),
 * switching which panel renders below it. Visually mirrors this
 * frontend's own WorkflowsTabs (components/workflow/workflows-tabs.tsx —
 * the LIST page's Workflows/Lists tab pair) for the same active/inactive
 * pill styling, but is a separate component instance/tab set since it
 * lives on the single-workflow detail page instead.
 */
export function WorkflowDetailTabs({
  active,
  onChange,
}: {
  active: WorkflowDetailTab;
  onChange: (tab: WorkflowDetailTab) => void;
}) {
  const tabs: Array<{ key: WorkflowDetailTab; label: string; icon: typeof WorkflowIcon }> = [
    { key: "canvas", label: "Canvas", icon: WorkflowIcon },
    { key: "runs", label: "Runs", icon: ListChecks },
    { key: "history", label: "History", icon: History },
  ];

  return (
    <div className="flex items-center gap-1 border-b border-border">
      {tabs.map((tab) => {
        const isActive = tab.key === active;
        const Icon = tab.icon;
        return (
          <button
            key={tab.key}
            onClick={() => onChange(tab.key)}
            className={cn(
              "flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
              isActive
                ? "border-accent-foreground text-accent-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
