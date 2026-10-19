"use client";

import { GitBranch, List } from "lucide-react";
import { cn } from "@/lib/utils";

export type WorkflowsTab = "workflows" | "lists";

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
