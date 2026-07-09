"use client";

import {
  Ban,
  ClockPlus,
  CreditCard,
  GitBranch,
  GripVertical,
  Hash,
  ShieldCheck,
  Split as SplitIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { WORKFLOW_ACTION_LABELS, WORKFLOW_ACTION_TYPES, type WorkflowActionType } from "@/lib/types";
import type { NewNodeSeed } from "@/lib/workflow-store";

/** Dragging payload carried on `dataTransfer` — a JSON-encoded
 *  NewNodeSeed, read back out in canvas.tsx's onDrop. Matches the
 *  real client's native HTML5 drag-and-drop sidebar palette
 *  (canvas/element/sidebar/draggable-node) rather than a click-driven
 *  picker. */
export const WORKFLOW_DRAG_MIME = "application/x-workflow-node";

const ACTION_ICONS: Record<WorkflowActionType, React.ReactNode> = {
  authorize_payment: <ShieldCheck className="h-3.5 w-3.5 text-success" />,
  settle_payment: <CreditCard className="h-3.5 w-3.5 text-success" />,
  block_payment: <Ban className="h-3.5 w-3.5 text-danger" />,
  set_metadata: <Hash className="h-3.5 w-3.5 text-foreground" />,
  delay: <ClockPlus className="h-3.5 w-3.5 text-foreground" />,
};

function DraggableNodeCard({ title, icon, seed }: { title: string; icon: React.ReactNode; seed: NewNodeSeed }) {
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(WORKFLOW_DRAG_MIME, JSON.stringify(seed));
        e.dataTransfer.effectAllowed = "move";
      }}
      className={cn(
        "flex cursor-grab items-center gap-2 rounded-md border border-border bg-card px-2 py-2 text-xs shadow-sm transition-colors",
        "hover:bg-neutral-bg active:cursor-grabbing",
      )}
    >
      {icon}
      <span className="flex-1 font-medium">{title}</span>
      <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
    </div>
  );
}

/**
 * Left-hand node palette — the real client's canvas-sidebar.component.
 * tsx: drag any card onto the canvas to drop an unconnected node at
 * that position (wire it up afterward with the hover "+" handles or
 * by drawing a connection). Hidden entirely in narrower viewports,
 * same breakpoint behavior as the real client's `max-sm:hidden`.
 */
export function CanvasSidebarComponent() {
  return (
    <div className="hidden h-full w-52 shrink-0 flex-col gap-4 overflow-y-auto border-r border-border bg-muted/50 p-2.5 sm:flex">
      <div className="flex flex-col gap-2">
        <p className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Utilities</p>
        <DraggableNodeCard title="Condition" icon={<GitBranch className="h-3.5 w-3.5 text-info" />} seed={{ kind: "condition" }} />
        <DraggableNodeCard title="Split" icon={<SplitIcon className="h-3.5 w-3.5 text-info" />} seed={{ kind: "split" }} />
      </div>

      <div className="flex flex-col gap-2">
        <p className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Actions</p>
        {WORKFLOW_ACTION_TYPES.map((type) => (
          <DraggableNodeCard
            key={type}
            title={WORKFLOW_ACTION_LABELS[type]}
            icon={ACTION_ICONS[type]}
            seed={{ kind: "action", actionType: type }}
          />
        ))}
      </div>
    </div>
  );
}
