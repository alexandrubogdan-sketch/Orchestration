"use client";

import { GitBranch, List } from "lucide-react";
import { cn } from "@/lib/utils";

export type WorkflowsTab = "workflows" | "lists";

/**
 * Mirrors the real client's WorkflowsTabsComponent (module/workflows/
 * element/tab/workflows-tabs.component.tsx): a line-style tab pair
 * ("Workflows" / "Lists", each with a leading icon) that switches
 * which table renders below it, plus a trailing "Create" action tied
 * to whichever tab is active. This component only renders the tab
 * strip + icons; the Create button lives in the page itself so it can
 * stay wired to the existing CreateWorkflowDialog (Lists doesn't have
 * a real create flow yet — see lists-table.tsx's doc comment).
 */
export function WorkflowsTabs({
  active,
  onChange,
}: {
  active: WorkflowsTab;
  onChange: (tab: WorkflowsTab) => void;
}) {
  const tabs: Array<{ key: WorkflowsTab; label: string; icon: typeof GitBranch }> = [
    { key: "workflows", label: "Workflows", icon: GitBranch },
    { key: "lists", label: "Lists", icon: List },
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
