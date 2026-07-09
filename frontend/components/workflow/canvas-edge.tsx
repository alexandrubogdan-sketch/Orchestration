"use client";

import { useState } from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useWorkflowStore } from "@/lib/workflow-store";

export type WorkflowEdgeData = { workflowId: string };

/**
 * Custom edge for connections between two already-placed nodes — per the
 * user's explicit spec: no button at all by default, and only a "×" to
 * delete the connection appears on hover (matching lib/workflow-graph.ts's
 * "default" bezier curve for the path itself). Reconnecting afterward
 * goes through the same hover "+" add-handle every node already has on
 * its dangling handles (components/workflow/add-handle.tsx) — no separate
 * insert-into-edge affordance here, unlike the real client's always-on
 * "+" (see canvas-edge.component.tsx), since the user asked for a single
 * hover-gated "×" instead.
 */
export function CanvasEdgeView({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  data,
}: EdgeProps) {
  const [hovered, setHovered] = useState(false);
  const removeEdge = useWorkflowStore((s) => s.removeEdge);
  const workflowId = (data as WorkflowEdgeData | undefined)?.workflowId;

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  function handleDelete() {
    if (workflowId) removeEdge(workflowId, id);
  }

  return (
    <>
      <BaseEdge id={id} path={edgePath} style={style} markerEnd={markerEnd} />

      {/* Wider invisible stroke so hovering anywhere near the visible
          line (not just its exact 1-2px path) reveals the delete button —
          the visible line alone is too thin a target to hover reliably. */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={16}
        className="cursor-pointer"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={handleDelete}
      />

      {hovered && workflowId ? (
        <EdgeLabelRenderer>
          <button
            type="button"
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onClick={handleDelete}
            title="Delete connection"
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all",
            }}
            className={cn(
              "nodrag nopan flex h-5 w-5 items-center justify-center rounded-full",
              "border border-border bg-destructive text-destructive-foreground shadow-sm",
              "transition-colors hover:bg-destructive/90",
            )}
          >
            <X className="h-3 w-3" />
          </button>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
