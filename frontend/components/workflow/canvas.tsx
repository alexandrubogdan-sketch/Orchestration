"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { AlignCenterHorizontal, Maximize2, Minimize2 } from "lucide-react";
import {
  Background,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { cn } from "@/lib/utils";
import { useWorkflowStore } from "@/lib/workflow-store";
import { buildWorkflowGraph } from "@/lib/workflow-graph";
import { NODE_TYPES } from "@/components/workflow/nodes";
import { CanvasSidebarComponent, WORKFLOW_DRAG_MIME } from "@/components/workflow/canvas-sidebar";
import { Button } from "@/components/ui/button";
import type { Workflow } from "@/lib/types";
import type { NewNodeSeed } from "@/lib/workflow-store";

/**
 * Two-pane canvas — a fixed-width node palette on the left
 * (CanvasSidebarComponent) plus the React Flow graph, with a
 * MiniMap and a maximize/minimize toggle in the top-right Panel next
 * to the "Rearrange" (auto-layout) button, matching the real client's
 * workflow-canvas.component.tsx chrome. Dropping a sidebar card onto
 * the canvas adds a floating, unconnected node at the drop position
 * (screenToFlowPosition), exactly like the real client's onDrop.
 */
function WorkflowCanvasInner({ workflow }: { workflow: Workflow }) {
  const [nodes, setNodes, onNodesChangeInternal] = useNodesState<Node>([]);
  const [edges, setEdges] = useEdgesState<import("@xyflow/react").Edge>([]);
  const positionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const { fitView, screenToFlowPosition } = useReactFlow();
  const { theme } = useTheme();
  const [isMaximized, setIsMaximized] = useState(false);
  const addFloatingNode = useWorkflowStore((s) => s.addFloatingNode);
  // Tracks which workflow id we've already fit the view for, so ELK
  // relayouts triggered by editing a node don't yank the user's pan/zoom —
  // we only auto-fit the very first time a given workflow is laid out (or
  // right after an explicit "Rearrange").
  const fitDoneForWorkflowRef = useRef<string | null>(null);
  // "Rearrange" button bumps this via requestRelayout — when it
  // changes, drop every manually-dragged position so the next layout
  // pass is a clean ELK auto-layout instead of respecting drags.
  const relayoutTick = useWorkflowStore((s) => s.relayoutRequests[workflow.id] ?? 0);
  const prevRelayoutTickRef = useRef(relayoutTick);

  // Rebuild whenever the graph changes (node/edge added/removed/edited),
  // but keep any position the user has already dragged a node to.
  //
  // buildWorkflowGraph is async (it awaits elkjs layout), so this can no
  // longer be a synchronous useMemo — it's computed in an effect with an
  // `ignore` guard so a stale in-flight layout can't clobber state after a
  // newer workflow/edit supersedes it or after unmount.
  useEffect(() => {
    let ignore = false;
    const rearranged = relayoutTick !== prevRelayoutTickRef.current;
    if (rearranged) {
      prevRelayoutTickRef.current = relayoutTick;
      positionsRef.current.clear();
      fitDoneForWorkflowRef.current = null;
    }

    async function runLayout() {
      const { nodes: builtNodes, edges: builtEdges } = await buildWorkflowGraph(workflow);
      if (ignore) return;

      const nextNodes = builtNodes.map((node) => {
        const savedPosition = positionsRef.current.get(node.id);
        return savedPosition ? { ...node, position: savedPosition } : node;
      });
      setNodes(nextNodes);
      setEdges(builtEdges);

      if (fitDoneForWorkflowRef.current !== workflow.id) {
        fitDoneForWorkflowRef.current = workflow.id;
        requestAnimationFrame(() => fitView());
      }
    }

    void runLayout();

    return () => {
      ignore = true;
    };
  }, [workflow, setNodes, setEdges, fitView, relayoutTick]);

  const requestRelayout = useWorkflowStore((s) => s.requestRelayout);

  return (
    <div
      onDrop={(event) => {
        event.preventDefault();
        const raw = event.dataTransfer.getData(WORKFLOW_DRAG_MIME);
        if (!raw) return;
        const seed = JSON.parse(raw) as NewNodeSeed;
        const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
        const newId = addFloatingNode(workflow.id, seed);
        positionsRef.current.set(newId, position);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      className={cn(
        "flex h-[calc(100vh-200px)] w-full overflow-hidden rounded-xl border border-border",
        isMaximized && "fixed inset-0 z-50 h-screen rounded-none bg-background",
      )}
    >
      <CanvasSidebarComponent />

      <div className="relative flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={(changes) => {
            onNodesChangeInternal(changes);
            for (const change of changes) {
              if (change.type === "position" && change.position) {
                positionsRef.current.set(change.id, change.position);
              }
            }
            setNodes((current) => applyNodeChanges(changes, current));
          }}
          fitView
          proOptions={{ hideAttribution: true }}
          defaultEdgeOptions={{ style: { stroke: "#c7cbd1" } }}
        >
          <Background gap={20} color="#e5e7eb" />
          <Controls showInteractive={false} />
          {nodes.length > 0 ? (
            <MiniMap pannable className="max-sm:hidden" nodeColor={theme === "dark" ? "#e5e7eb" : "#424242"} />
          ) : null}

          <Panel position="top-right">
            <div className="flex items-center gap-2">
              {nodes.length > 0 ? (
                <Button
                  size="icon"
                  variant="outline"
                  className="h-8 w-8 -rotate-90"
                  onClick={() => requestRelayout(workflow.id)}
                  title="Rearrange — reset dragged nodes back to the automatic layout"
                >
                  <AlignCenterHorizontal className="h-3.5 w-3.5" />
                </Button>
              ) : null}
              <Button
                size="icon"
                variant="outline"
                className="h-8 w-8"
                onClick={() => setIsMaximized((v) => !v)}
                title={isMaximized ? "Exit fullscreen" : "Fullscreen"}
              >
                {isMaximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
              </Button>
            </div>
          </Panel>
        </ReactFlow>
      </div>
    </div>
  );
}

export function WorkflowCanvas({ workflowId }: { workflowId: string }) {
  const workflow = useWorkflowStore((s) => s.workflows.find((w) => w.id === workflowId));

  if (!workflow) {
    return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Workflow not found.</div>;
  }

  return (
    <ReactFlowProvider>
      <WorkflowCanvasInner workflow={workflow} />
    </ReactFlowProvider>
  );
}
