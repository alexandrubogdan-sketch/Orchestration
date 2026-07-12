"use client";

import { useState, type MouseEvent } from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useWorkflowStore } from "@/lib/workflow-store";

export type WorkflowEdgeData = { workflowId: string; highlighted?: boolean; dimmed?: boolean };

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
 *
 * Clicking the connection itself (anywhere along the wide invisible hit
 * path below) no longer deletes it — that was the bug: a plain click
 * used to remove the edge outright, with no way to just select it.
 * Deletion is now only ever triggered by the small hover "×" button.
 * A plain click instead bubbles up to canvas.tsx's onEdgeClick, which
 * highlights this edge plus everything reachable downstream from it
 * (highlighted/dimmed flags below, computed there and threaded through
 * this edge's `data`).
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
    // Keeps this click from also reaching canvas.tsx's onEdgeClick (which
    // would otherwise briefly re-select an edge that's about to disappear).
    event.stopPropagation();
    if (workflowId) removeEdge(workflowId, id);
  }

  // BUG FIX: `highlighted` used to hardcode stroke: "#f8fafc" — a
  // near-white slate tone that only reads against a dark canvas. In
  // light mode (canvas.tsx's --background is #f7f8fa, effectively the
  // same color) a "highlighted" downstream path became less visible
  // than the unhighlighted default, which is exactly backwards and is
  // what looked like the rest of the workflow "disappearing" on click.
  // var(--primary) is this app's indigo accent, defined distinctly from
  // both the light (#f7f8fa) and dark (#0b0c0f) canvas backgrounds in
  // globals.css, so the highlighted path now reads clearly in both
  // themes and is visually distinct from the plain gray default edge
  // color (var(--muted-foreground), set in canvas.tsx's
  // defaultEdgeOptions) rather than nearly matching it.
  const pathStyle = {
    ...style,
    ...(highlighted ? { stroke: "var(--primary)", strokeWidth: 2.5 } : null),
    ...(dimmed ? { opacity: 0.2 } : null),
  };

  return (
    <>
      <BaseEdge id={id} path={edgePath} style={pathStyle} markerEnd={markerEnd} />

      {/* Wider invisible stroke so hovering anywhere near the visible
          line (not just its exact 1-2px path) reveals the delete button,
          and clicking anywhere along it selects the connection (handled
          by canvas.tsx's onEdgeClick, which fires from this element
          bubbling up — no onClick handler here anymore). */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={16}
        // React Flow's own stylesheet sets `pointer-events: none` on
        // edge paths by default (edges aren't interactive unless opted
        // in) — a stylesheet rule beats a bare className, so this has
        // to be an inline style to actually win and make the wide hit
        // area hoverable/clickable.
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
