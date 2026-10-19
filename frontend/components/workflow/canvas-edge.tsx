"use client";

import { useState, type MouseEvent } from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useWorkflowStore } from "@/lib/workflow-store";

export type WorkflowEdgeData = { workflowId: string; highlighted?: boolean; dimmed?: boolean };

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
  const edgeData = data as WorkflowEdgeData | undefined;
  const workflowId = edgeData?.workflowId;
  const highlighted = edgeData?.highlighted ?? false;
  const dimmed = edgeData?.dimmed ?? false;

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  function handleDelete(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (workflowId) removeEdge(workflowId, id);
  }

  const pathStyle = {
    ...style,
    ...(highlighted
      ? {
          stroke: "var(--edge-highlight)",
          strokeWidth: 2.5,
          filter: "drop-shadow(0 0 4px var(--edge-highlight-glow))",
        }
      : null),
    ...(dimmed ? { opacity: 0.2 } : null),
  };

  return (
    <>
      <BaseEdge id={id} path={edgePath} style={pathStyle} markerEnd={markerEnd} />

      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={16}

        style={{ pointerEvents: "stroke", cursor: "pointer" }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
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
