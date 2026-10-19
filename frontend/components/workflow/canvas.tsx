"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { buildEdges, buildWorkflowGraph } from "@/lib/workflow-graph";
import { NODE_TYPES } from "@/components/workflow/nodes";
import { CanvasEdgeView } from "@/components/workflow/canvas-edge";
import { CanvasSidebarComponent, WORKFLOW_DRAG_MIME } from "@/components/workflow/canvas-sidebar";
import { Button } from "@/components/ui/button";
import type { Workflow } from "@/lib/types";
import type { NewNodeSeed } from "@/lib/workflow-store";

const EDGE_TYPES = { workflowEdge: CanvasEdgeView };

function WorkflowCanvasInner({ workflow }: { workflow: Workflow }) {
  const [nodes, setNodes, onNodesChangeInternal] = useNodesState<Node>([]);
  const [edges, setEdges] = useEdgesState<import("@xyflow/react").Edge>([]);

  const positionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const { fitView, screenToFlowPosition } = useReactFlow();
  const { theme } = useTheme();
  const [isMaximized, setIsMaximized] = useState(false);
  const addFloatingNode = useWorkflowStore((s) => s.addFloatingNode);
  const connectNodes = useWorkflowStore((s) => s.connectNodes);

  const fitDoneForWorkflowRef = useRef<string | null>(null);

  const bootstrappedWorkflowIdRef = useRef<string | null>(null);

  const layoutGenerationRef = useRef(0);

  const [focusedEdgeId, setFocusedEdgeId] = useState<string | null>(null);

  const highlighted = useMemo(() => {
    const clicked = focusedEdgeId ? workflow.edges.find((e) => e.id === focusedEdgeId) : undefined;
    if (!clicked) return null;
    const nodeIds = new Set<string>([clicked.source, clicked.target]);
    const edgeIds = new Set<string>([clicked.id]);
    const queue = [clicked.target];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const edge of workflow.edges) {
        if (edge.source !== current || edgeIds.has(edge.id)) continue;
        edgeIds.add(edge.id);
        if (!nodeIds.has(edge.target)) {
          nodeIds.add(edge.target);
          queue.push(edge.target);
        }
      }
    }
    return { nodeIds, edgeIds };
  }, [focusedEdgeId, workflow.edges]);

  const runElkLayout = useCallback(
    async (options?: { forceReset?: boolean }) => {
      const generation = ++layoutGenerationRef.current;

      if (options?.forceReset) {
        positionsRef.current.clear();
        fitDoneForWorkflowRef.current = null;
      }

      let built: { nodes: Node[]; edges: import("@xyflow/react").Edge[] };
      try {
        built = await buildWorkflowGraph(workflow);
      } catch (error) {
        console.error("Workflow auto-layout failed:", error);
        return;
      }
      if (generation !== layoutGenerationRef.current) return;

      positionsRef.current = new Map(built.nodes.map((node) => [node.id, node.position]));
      bootstrappedWorkflowIdRef.current = workflow.id;
      setNodes(built.nodes);
      setEdges(built.edges);

      if (fitDoneForWorkflowRef.current !== workflow.id) {
        fitDoneForWorkflowRef.current = workflow.id;
        requestAnimationFrame(() => fitView());
      }
    },
    [workflow, setNodes, setEdges, fitView],
  );

  const syncGraphWithoutLayout = useCallback(() => {
    const validIds = new Set(workflow.nodes.map((n) => n.id));
    for (const id of Array.from(positionsRef.current.keys())) {
      if (!validIds.has(id)) positionsRef.current.delete(id);
    }

    const nextNodes: Node[] = workflow.nodes.map((node) => {
      const cached = positionsRef.current.get(node.id);
      if (cached) {
        return { id: node.id, type: node.kind, position: cached, data: { workflowId: workflow.id, node } };
      }
      const incoming = workflow.edges.find((e) => e.target === node.id);
      const anchorPos = incoming ? positionsRef.current.get(incoming.source) : undefined;
      const fallback = anchorPos
        ? { x: anchorPos.x, y: anchorPos.y + 170 }
        : { x: 40, y: 40 + positionsRef.current.size * 24 };
      positionsRef.current.set(node.id, fallback);
      return { id: node.id, type: node.kind, position: fallback, data: { workflowId: workflow.id, node } };
    });

    setNodes(nextNodes);
    setEdges(buildEdges(workflow));
  }, [workflow, setNodes, setEdges]);

  useEffect(() => {
    if (bootstrappedWorkflowIdRef.current !== workflow.id) {
      void runElkLayout();
    } else {
      syncGraphWithoutLayout();
    }
  }, [workflow, runElkLayout, syncGraphWithoutLayout]);

  const displayNodes = useMemo(() => {
    if (!highlighted) return nodes;
    return nodes.map((node) =>
      highlighted.nodeIds.has(node.id) ? node : { ...node, className: cn(node.className, "opacity-30") },
    );
  }, [nodes, highlighted]);

  const displayEdges = useMemo(() => {
    if (!highlighted) return edges;
    return edges.map((edge) => ({
      ...edge,
      data: { ...edge.data, highlighted: highlighted.edgeIds.has(edge.id), dimmed: !highlighted.edgeIds.has(edge.id) },
    }));
  }, [edges, highlighted]);

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
          nodes={displayNodes}
          edges={displayEdges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodesChange={(changes) => {
            onNodesChangeInternal(changes);
            for (const change of changes) {
              if (change.type === "position" && change.position) {
                positionsRef.current.set(change.id, change.position);
              }
            }
            setNodes((current) => applyNodeChanges(changes, current));
          }}
          onConnect={(connection) => {
            if (!connection.source || !connection.target) return;
            connectNodes(workflow.id, connection.source, connection.sourceHandle ?? undefined, connection.target);
          }}
          onEdgeClick={(event, edge) => {
            event.stopPropagation();
            setFocusedEdgeId((current) => (current === edge.id ? null : edge.id));
          }}
          onPaneClick={() => setFocusedEdgeId(null)}
          fitView
          proOptions={{ hideAttribution: true }}
          defaultEdgeOptions={{ style: { stroke: "var(--muted-foreground)" } }}
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
                  onClick={() => void runElkLayout({ forceReset: true })}
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
