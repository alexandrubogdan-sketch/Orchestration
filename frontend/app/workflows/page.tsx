"use client";

import { useState } from "react";
import Link from "next/link";
import { Plus, Trash2, Workflow as WorkflowIcon } from "lucide-react";
import { Topbar } from "@/components/layout/topbar";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CreateWorkflowDialog } from "@/components/workflow/create-workflow-dialog";
import { useWorkflowStore } from "@/lib/workflow-store";
import { PAYMENT_METHOD_LABELS } from "@/lib/types";
import { formatDateTime } from "@/lib/utils";

export default function WorkflowsPage() {
  const workflows = useWorkflowStore((s) => s.workflows);
  const deleteWorkflow = useWorkflowStore((s) => s.deleteWorkflow);
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <>
      <Topbar
        title="Workflows"
        description="Route payments per payment method — one trigger, then conditions and actions"
      />
      <div className="flex-1 overflow-y-auto p-8">
        <div className="mb-4 flex items-center justify-between">
          <span className="text-sm text-muted-foreground">{workflows.length} workflow(s)</span>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="h-3.5 w-3.5" /> Create workflow
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {workflows.map((workflow) => (
            <Card key={workflow.id} className="group relative">
              <CardContent className="flex flex-col gap-3">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent-foreground">
                      <WorkflowIcon className="h-4 w-4" />
                    </div>
                    <div>
                      <Link href={`/workflows/${workflow.id}`} className="text-sm font-semibold hover:underline">
                        {workflow.name}
                      </Link>
                      <div className="text-xs text-muted-foreground">{PAYMENT_METHOD_LABELS[workflow.paymentMethod]}</div>
                    </div>
                  </div>
                  <button
                    onClick={() => deleteWorkflow(workflow.id)}
                    className="text-muted-foreground opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                    title="Delete workflow"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <Badge tone={workflow.state === "published" ? "success" : "neutral"}>{workflow.state}</Badge>
                  <span>{workflow.nodes.length - 1} node(s)</span>
                </div>
                <span className="text-xs text-muted-foreground">Updated {formatDateTime(workflow.updatedAt)}</span>
              </CardContent>
            </Card>
          ))}
        </div>

        {workflows.length === 0 ? (
          <div className="mt-8 text-center text-sm text-muted-foreground">
            No workflows yet — create one to start routing payments.
          </div>
        ) : null}
      </div>

      {createOpen ? <CreateWorkflowDialog onClose={() => setCreateOpen(false)} /> : null}
    </>
  );
}
