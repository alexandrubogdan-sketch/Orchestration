"use client";

import { useRouter } from "next/navigation";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { getMockWorkflowRuns } from "@/lib/mock-data";
import type { WorkflowRunStatus } from "@/lib/types";
import { formatDateTime } from "@/lib/utils";

/**
 * "Runs" tab on the workflow detail page — mirrors the real client's
 * WorkflowRunsComponent (module/workflow (singular) — element/runs/
 * workflow-runs.component.tsx), a table of individual executions of
 * this workflow's node chain: run id, status, the payment that
 * triggered it, when it started, and how long it took. Data comes from
 * lib/mock-data.ts#getMockWorkflowRuns, seeded from the workflow's own
 * id like every other mock table in this app (see that file's doc
 * comment). Column/badge usage mirrors workflows-table.tsx (the list
 * page's table) to stay visually consistent across the Workflows
 * section.
 */

const STATUS_TONES: Record<WorkflowRunStatus, BadgeTone> = {
  succeeded: "success",
  failed: "danger",
  in_progress: "info",
};

const STATUS_LABELS: Record<WorkflowRunStatus, string> = {
  succeeded: "Succeeded",
  failed: "Failed",
  in_progress: "In progress",
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function WorkflowRunsTable({ workflowId }: { workflowId: string }) {
  const router = useRouter();
  const runs = getMockWorkflowRuns(workflowId);

  if (runs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-1 py-16 text-center">
        <p className="text-sm font-medium">No runs yet</p>
        <p className="text-sm text-muted-foreground">
          Runs will appear here once a payment triggers this workflow.
        </p>
      </div>
    );
  }

  return (
    <Table>
      <THead>
        <TR className="hover:bg-transparent">
          <TH className="min-w-[160px]">Run ID</TH>
          <TH className="w-[120px]">Status</TH>
          <TH className="min-w-[160px]">Triggered by</TH>
          <TH className="w-[180px]">Started at</TH>
          <TH className="w-[100px]">Duration</TH>
        </TR>
      </THead>
      <TBody>
        {runs.map((run) => (
          <TR
            key={run.id}
            className="cursor-pointer"
            onClick={() => router.push(`/payments/${run.paymentId}`)}
          >
            <TD className="min-w-[160px] font-mono text-xs text-foreground">{run.id}</TD>
            <TD className="w-[120px]">
              <Badge tone={STATUS_TONES[run.status]}>{STATUS_LABELS[run.status]}</Badge>
            </TD>
            <TD className="min-w-[160px] font-mono text-xs text-muted-foreground">{run.paymentId}</TD>
            <TD className="w-[180px] text-sm text-muted-foreground">{formatDateTime(run.startedAt)}</TD>
            <TD className="w-[100px] text-sm text-muted-foreground">{formatDuration(run.durationMs)}</TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
