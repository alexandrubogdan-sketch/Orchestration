"use client";

import { use } from "react";
import { BuilderToolbar } from "@/components/workflow/builder-toolbar";
import { WorkflowCanvas } from "@/components/workflow/canvas";

export default function WorkflowDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  return (
    <>
      <BuilderToolbar workflowId={id} />
      <div className="relative flex-1">
        <WorkflowCanvas workflowId={id} />
      </div>
    </>
  );
}
