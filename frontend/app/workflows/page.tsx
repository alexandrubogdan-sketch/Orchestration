"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Topbar } from "@/components/layout/topbar";
import { Button } from "@/components/ui/button";
import { CreateWorkflowDialog } from "@/components/workflow/create-workflow-dialog";
import { ListsTable } from "@/components/workflow/lists-table";
import { WorkflowsSubnav } from "@/components/workflow/workflows-subnav";
import { WorkflowsTable } from "@/components/workflow/workflows-table";
import { WorkflowsTabs, type WorkflowsTab } from "@/components/workflow/workflows-tabs";
import { useWorkflowStore } from "@/lib/workflow-store";

/**
 * Structured after the real client's workflows.module.tsx: a top bar,
 * then a tab strip (Workflows | Lists) with a trailing Create action,
 * then whichever table the active tab selects. See workflows-table.tsx
 * and lists-table.tsx for the two tables, and workflows-tabs.tsx for
 * the tab strip itself.
 */
export default function WorkflowsPage() {
  const workflows = useWorkflowStore((s) => s.workflows);
  const [activeTab, setActiveTab] = useState<WorkflowsTab>("workflows");
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <>
      <Topbar
        title="Workflows"
        description="Route payments per payment method — one trigger, then conditions and actions"
      />
      <WorkflowsSubnav />
      <div className="flex-1 overflow-y-auto p-8">
        <div className="mb-4 flex items-center justify-between">
          <WorkflowsTabs active={activeTab} onChange={setActiveTab} />
          {activeTab === "workflows" ? (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-3.5 w-3.5" /> Create workflow
            </Button>
          ) : null}
        </div>

        {activeTab === "workflows" ? (
          <>
            <p className="mb-3 text-sm text-muted-foreground">{workflows.length} workflow(s)</p>
            <div className="rounded-lg border border-border bg-card">
              <WorkflowsTable />
            </div>
          </>
        ) : (
          <div className="rounded-lg border border-border bg-card">
            <ListsTable />
          </div>
        )}
      </div>

      {createOpen ? <CreateWorkflowDialog onClose={() => setCreateOpen(false)} /> : null}
    </>
  );
}
