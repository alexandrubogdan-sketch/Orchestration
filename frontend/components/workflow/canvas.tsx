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

// Defined once at module scope (not inline in the JSX below) — React
// Flow re-runs internal setup whenever the nodeTypes/edgeTypes object
// identity changes, so this must stay stable across renders.
const EDGE_TYPES = { workflowEdge: CanvasEdgeView };

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
  // Every node's last-known position, keyed by id — the single source
  // of truth for "where does this node sit," seeded once by an ELK pass
  // and otherwise left completely alone. Per explicit spec: only the
  // "Rearrange" button may move existing nodes. Deleting a node,
  // deleting an edge, editing a condition/action/branch, etc. must
  // reuse whatever's already in here rather than re-running layout.
  const positionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const { fitView, screenToFlowPosition } = useReactFlow();
  const { theme } = useTheme();
  const [isMaximized, setIsMaximized] = useState(false);
  const addFloatingNode = useWorkflowStore((s) => s.addFloatingNode);
  const connectNodes = useWorkflowStore((s) => s.connectNodes);
  // Tracks which workflow id we've already fit the view for, so ELK
  // relayouts triggered by editing a node don't yank the user's pan/zoom —
  // we only auto-fit the very first time a given workflow is laid out (or
  // right after an explicit "Rearrange").
  const fitDoneForWorkflowRef = useRef<string | null>(null);
  // Tracks which workflow id positionsRef currently holds ELK-seeded
  // positions for — set back to something else (by "Rearrange") to
  // force the next effect run through a full ELK pass again.
  const bootstrappedWorkflowIdRef = useRef<string | null>(null);
  // Every runElkLayout() call stamps its own ticket here before awaiting
  // elk — if a newer call starts before an older one resolves, the
  // older one's result is discarded instead of clobbering a newer one.
  const layoutGenerationRef = useRef(0);
  // Which connection the user clicked, if any — drives the downstream
  // path highlight below. Cleared on pane click, re-click of the same
  // edge, or (implicitly, since the lookup below just comes up empty)
  // if the edge it pointed at no longer exists (deleted).
  const [focusedEdgeId, setFocusedEdgeId] = useState<string | null>(null);

  // Everything reachable "moving down" from the clicked edge — its own
  // source/target plus every node/edge you'd hit by following outgoing
  // edges from there, branch after branch, all the way to whatever the
  // path terminates in. Nothing above the clicked edge is included, per
  // spec ("highlight the whole way moving down").
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

  // Full ELK auto-layout pass — the ONLY two things allowed to trigger
  // this: the very first time a given workflow is opened (positionsRef
  // has nothing for it yet) and an explicit "Rearrange" click. Every
  // other store change goes through syncGraphWithoutLayout below
  // instead, which never moves an existing node.
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
        // elk can in principle reject on a malformed/disconnected
        // graph shape — surface it instead of silently doing nothing,
        // which is what made "Rearrange" look like it "sometimes
        // doesn't work."
        console.error("Workflow auto-layout failed:", error);
        return;
      }
      if (generation !== layoutGenerationRef.current) return; // superseded by a newer call

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

  // Lightweight sync — rebuilds the node/edge arrays straight from the
  // workflow's current data with zero relayout: any node already in
  // positionsRef keeps that exact spot; a brand-new node (no cached
  // position yet — just inserted via a hover "+", duplicated, etc.)
  // gets placed just below whatever node it's wired to, or stacked at a
  // fallback spot if it isn't wired to anything yet. Dropping a card in
  // from the sidebar is handled separately in onDrop below (it already
  // knows its exact drop position).
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

  // Dim everything except the focused connection's downstream path,
  // rather than mutating the real nodes/edges state — that state is the
  // ELK/sync source of truth and must stay untouched by a purely visual
  // selection.
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
            // Manually dragging a connection from one handle straight
            // to another existing node's target handle — distinct from
            // the hover "+" (which always creates a brand-new node).
            // Without this, React Flow shows the drag line but drops it
            // on release since nothing ever commits it to the store.
            if (!connection.source || !connection.target) return;
            connectNodes(workflow.id, connection.source, connection.sourceHandle ?? undefined, connection.target);
          }}
          onEdgeClick={(event, edge) => {
            // Click a connection to trace it: highlights this edge plus
            // every node/edge reachable downstream, dims the rest. Re-
            // clicking the same connection (or clicking empty canvas,
            // via onPaneClick below) clears it.
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
