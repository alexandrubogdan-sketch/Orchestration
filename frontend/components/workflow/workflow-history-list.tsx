"use client";

import { CheckCircle2, FilePlus, FileText, PencilLine, RotateCcw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { getMockWorkflowHistory } from "@/lib/mock-data";
import type { WorkflowHistoryEventType } from "@/lib/types";
import { formatDateTime, getInitials } from "@/lib/utils";

/**
 * "History" tab on the workflow detail page — mirrors the real
 * client's WorkflowHistoryComponent (module/workflow (singular) —
 * element/history/workflow-history.component.tsx), which renders a
 * TableComponent of workflow_versions rows (version/status/author/
 * date_published — see workflow-history.service.ts's
 * workflowHistoryColumns). This is a simpler reverse-chronological
 * list/table rather than a full data-grid, per this task's brief, but
 * keeps the same fields: a version label, a human-readable change
 * description, the actor, and a timestamp. Data comes from
 * lib/mock-data.ts#getMockWorkflowHistory.
 */

const EVENT_ICONS: Record<WorkflowHistoryEventType, typeof CheckCircle2> = {
  published: CheckCircle2,
  draft_saved: FileText,
  node_added: FilePlus,
  node_removed: Trash2,
  node_edited: PencilLine,
  reverted: RotateCcw,
};

const EVENT_TONES: Record<WorkflowHistoryEventType, "success" | "neutral" | "info" | "danger" | "warning"> = {
  published: "success",
  draft_saved: "neutral",
  node_added: "info",
  node_removed: "danger",
  node_edited: "info",
  reverted: "warning",
};

export function WorkflowHistoryList({ workflowId }: { workflowId: string }) {
  const events = getMockWorkflowHistory(workflowId);

  if (events.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-1 py-16 text-center">
        <p className="text-sm font-medium">No history yet</p>
        <p className="text-sm text-muted-foreground">
          Changes to this workflow will show up here.
        </p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border">
      {events.map((event) => {
        const Icon = EVENT_ICONS[event.type];
        return (
          <li key={event.id} className="flex items-start gap-3 px-4 py-3">
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neutral-bg text-muted-foreground">
              <Icon className="h-3.5 w-3.5" />
            </span>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium">{event.detail}</p>
                <Badge tone={EVENT_TONES[event.type]}>{event.versionLabel}</Badge>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {getInitials(event.actorName)} · {event.actorName} · {formatDateTime(event.occurredAt)}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
