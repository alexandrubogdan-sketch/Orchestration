"use client";

import { useRouter } from "next/navigation";
import { ChevronRight, MoreHorizontal, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useWorkflowStore } from "@/lib/workflow-store";
import { PAYMENT_METHOD_LABELS, type Workflow } from "@/lib/types";
import { cn, formatDateTime } from "@/lib/utils";

/**
 * Mirrors the real client's workflows-list.component.tsx: a table with
 * name / status / version / runs / last-updated columns plus a
 * trailing link column, rows clickable through to the workflow's own
 * detail page. This mock model has no `version`/`runs` counters on
 * Workflow itself (lib/types.ts), so both are derived deterministically
 * from data already on the workflow (node count for version, a stable
 * hash of the id for runs) rather than invented as separate random
 * fields — same "derive, don't fabricate a parallel field" approach
 * the real column defs take with `item?.runs` linking back to the
 * workflow's own run history.
 */
function versionFor(workflow: Workflow): string {
  return `v${workflow.nodes.length}`;
}

function runsFor(workflow: Workflow): number {
  let hash = 0;
  for (let i = 0; i < workflow.id.length; i++) {
    hash = (Math.imul(31, hash) + workflow.id.charCodeAt(i)) | 0;
  }
  if (workflow.state === "draft") return 0;
  return Math.abs(hash) % 4200;
}

export function WorkflowsTable() {
  const router = useRouter();
  const workflows = useWorkflowStore((s) => s.workflows);
  const deleteWorkflow = useWorkflowStore((s) => s.deleteWorkflow);

  if (workflows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-1 py-16 text-center">
        <p className="text-sm font-medium">No workflows yet</p>
        <p className="text-sm text-muted-foreground">Create one to start routing payments.</p>
      </div>
    );
  }

  return (
    <Table>
      <THead>
        <TR className="hover:bg-transparent">
          <TH className="min-w-[240px]">Name</TH>
          <TH className="w-[100px]">Status</TH>
          <TH className="w-[100px]">Version</TH>
          <TH className="w-[100px]">Runs</TH>
          <TH className="w-[180px]">Last updated</TH>
          <TH className="w-[56px]" />
        </TR>
      </THead>
      <TBody>
        {workflows.map((workflow) => (
          <TR
            key={workflow.id}
            className="group cursor-pointer"
            onClick={() => router.push(`/workflows/${workflow.id}`)}
          >
            <TD className="min-w-[240px] max-w-[240px]">
              <p className="truncate text-sm font-medium">{workflow.name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {PAYMENT_METHOD_LABELS[workflow.paymentMethod]}
              </p>
            </TD>
            <TD className="w-[100px]">
              <Badge tone={workflow.state === "published" ? "success" : "neutral"}>
                {workflow.state === "published" ? "Live" : "Draft"}
              </Badge>
            </TD>
            <TD className="w-[100px] text-sm text-muted-foreground">{versionFor(workflow)}</TD>
            <TD className="w-[100px] text-sm text-muted-foreground">
              {runsFor(workflow) > 0 ? runsFor(workflow).toLocaleString("en-US") : "—"}
            </TD>
            <TD className="w-[180px] text-sm text-muted-foreground">
              {formatDateTime(workflow.updatedAt)}
            </TD>
            <TD
              className="w-[56px]"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
            >
              <div className="flex items-center justify-end gap-0.5">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn(
                        "h-7 w-7 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100",
                      )}
                      title="Workflow actions"
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => deleteWorkflow(workflow.id)} className="text-danger">
                      <Trash2 className="h-3.5 w-3.5" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </div>
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
