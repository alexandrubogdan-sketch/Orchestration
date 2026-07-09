"use client";

import { useState } from "react";
import { Handle, Position, type HandleType } from "@xyflow/react";
import { Ban, ClockPlus, CreditCard, GitBranch, Hash, Plus, ShieldCheck, Split as SplitIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { NewNodeSeed } from "@/lib/workflow-store";
import { WORKFLOW_ACTION_LABELS, WORKFLOW_ACTION_TYPES } from "@/lib/types";

const ACTION_ICONS: Record<string, React.ReactNode> = {
  authorize_payment: <ShieldCheck className="h-3.5 w-3.5 text-success" />,
  settle_payment: <CreditCard className="h-3.5 w-3.5 text-success" />,
  block_payment: <Ban className="h-3.5 w-3.5 text-danger" />,
  set_metadata: <Hash className="h-3.5 w-3.5 text-foreground" />,
  delay: <ClockPlus className="h-3.5 w-3.5 text-foreground" />,
};

/**
 * Hover "+" insert affordance on a node's handle — the real client's
 * signature interaction for extending the canvas without dragging
 * from the sidebar (canvas-node/element/add-handle). Only rendered
 * when `showButton` is true (i.e. this handle has no outgoing/incoming
 * connection yet — see nodes.tsx's isEdgeConnected checks), so a
 * handle that's already wired just shows the plain connector dot.
 */
export function AddHandleComponent({
  type,
  position,
  id,
  isConnectable,
  showButton,
  onInsert,
  style,
}: {
  type: HandleType;
  position: Position;
  id?: string;
  isConnectable: boolean;
  showButton: boolean;
  onInsert: (seed: NewNodeSeed) => void;
  style?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const vertical = position === Position.Top || position === Position.Bottom;

  return (
    <Handle
      type={type}
      position={position}
      id={id}
      isConnectable={isConnectable}
      style={style}
      className={cn(
        "!h-2.5 !w-2.5 !rounded-full !border-2 !border-background",
        type === "source" ? "!bg-primary" : "!bg-muted-foreground/60",
      )}
    >
      {showButton ? (
        <div
          className={cn(
            "pointer-events-none absolute flex items-center",
            vertical ? "left-1/2 top-1/2 -translate-x-1/2 flex-col" : "left-1/2 top-1/2 -translate-y-1/2",
          )}
        >
          <div className={cn("bg-border", vertical ? "h-6 w-px" : "h-px w-6")} />

          <DropdownMenu open={open} onOpenChange={setOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="nodrag nopan pointer-events-auto flex h-6 w-6 items-center justify-center rounded-full border border-border bg-surface text-muted-foreground shadow-sm transition-colors hover:border-accent-foreground hover:text-accent-foreground"
                title="Insert a node here"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center" className="w-56">
              <DropdownMenuLabel>Add a node</DropdownMenuLabel>
              <DropdownMenuItem
                onClick={() => onInsert({ kind: "condition" })}
                className="gap-2"
              >
                <GitBranch className="h-3.5 w-3.5 text-info" /> Condition
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onInsert({ kind: "split" })} className="gap-2">
                <SplitIcon className="h-3.5 w-3.5 text-info" /> Split
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Actions</DropdownMenuLabel>
              {WORKFLOW_ACTION_TYPES.map((actionType) => (
                <DropdownMenuItem
                  key={actionType}
                  onClick={() => onInsert({ kind: "action", actionType })}
                  className="gap-2"
                >
                  {ACTION_ICONS[actionType]} {WORKFLOW_ACTION_LABELS[actionType]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}
    </Handle>
  );
}
