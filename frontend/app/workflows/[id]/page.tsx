"use client";

import { use, useState } from "react";
import { BuilderToolbar } from "@/components/workflow/builder-toolbar";
import { WorkflowCanvas } from "@/components/workflow/canvas";
import { WorkflowDetailTabs, type WorkflowDetailTab } from "@/components/workflow/workflow-detail-tabs";
import { WorkflowHistoryList } from "@/components/workflow/workflow-history-list";
import { WorkflowRunsTable } from "@/components/workflow/workflow-runs-table";

/**
 * Structured after the real client's workflow.module.tsx (module/workflow,
 * singular): WorkflowTopComponent (-> BuilderToolbar here) followed by a
 * Canvas/Runs/History tab strip (WorkflowTabsComponent -> WorkflowDetailTabs
 * here), then whichever panel the active tab selects. The canvas panel is
 * the pre-existing builder UI, unchanged — just now gated behind
 * activeTab === "canvas" instead of always rendering.
 */
export default function WorkflowDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [activeTab, setActiveTab] = useState<WorkflowDetailTab>("canvas");

  return (
    <>
      <BuilderToolbar workflowId={id} />
      <div className="px-6">
        <WorkflowDetailTabs active={activeTab} onChange={setActiveTab} />
      </div>

      {activeTab === "canvas" ? (
        <div className="relative flex-1">
          <WorkflowCanvas workflowId={id} />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="rounded-lg border border-border bg-card">
            {activeTab === "runs" ? (
              <WorkflowRunsTable workflowId={id} />
            ) : (
              <WorkflowHistoryList workflowId={id} />
            )}
          </div>
        </div>
      )}
    </>
  );
}
