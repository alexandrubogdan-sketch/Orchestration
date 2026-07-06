"use client";

import { useEffect, useRef } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useWorkflowStore } from "@/lib/workflow-store";
import { buildWorkflowGraph } from "@/lib/workflow-graph";
import { NODE_TYPES } from "@/components/workflow/nodes";
import type { Workflow } from "@/lib/types";

function WorkflowCanvasInner({ workflow }: { workflow: Workflow }) {
  const [nodes, setNodes, onNodesChangeInternal] = useNodesState<Node>([]);
  const [edges, setEdges] = useEdgesState<import("@xyflow/react").Edge>([]);
  const positionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const { fitView } = useReactFlow();
  // Tracks which workflow id we've already fit the view for, so ELK
  // relayouts triggered by editing a node don't yank the user's pan/zoom —
  // we only auto-fit the very first time a given workflow is laid out.
  const fitDoneForWorkflowRef = useRef<string | null>(null);

  // Rebuild whenever the chain changes (node added/removed/edited), but
  // keep any position the user has already dragged a node to — same
  // rationale as the original preset/rule/split/step canvas this
  // replaces: a rebuild on every keystroke shouldn't snap the view back.
  //
  // buildWorkflowGraph is async (it awaits elkjs layout), so this can no
  // longer be a synchronous useMemo — it's computed in an effect with an
  // `ignore` guard so a stale in-flight layout can't clobber state after a
  // newer workflow/edit supersedes it or after unmount.
  useEffect(() => {
    let ignore = false;

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
  }, [workflow, setNodes, setEdges, fitView]);

  return (
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
    </ReactFlow>
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
