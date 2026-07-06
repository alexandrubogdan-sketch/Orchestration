"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  applyNodeChanges,
  useEdgesState,
  useNodesState,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useWorkflowStore } from "@/lib/workflow-store";
import { buildWorkflowGraph } from "@/lib/workflow-graph";
import { NODE_TYPES } from "@/components/workflow/nodes";

export function WorkflowCanvas({ workflowId }: { workflowId: string }) {
  const workflow = useWorkflowStore((s) => s.workflows.find((w) => w.id === workflowId));

  const [nodes, setNodes, onNodesChangeInternal] = useNodesState<Node>([]);
  const [edges, setEdges] = useEdgesState<import("@xyflow/react").Edge>([]);
  const positionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());

  const rebuilt = useMemo(
    () => (workflow ? buildWorkflowGraph(workflow) : { nodes: [], edges: [] }),
    [workflow],
  );

  // Rebuild whenever the chain changes (node added/removed/edited), but
  // keep any position the user has already dragged a node to — same
  // rationale as the original preset/rule/split/step canvas this
  // replaces: a rebuild on every keystroke shouldn't snap the view back.
  useEffect(() => {
    const nextNodes = rebuilt.nodes.map((node) => {
      const savedPosition = positionsRef.current.get(node.id);
      return savedPosition ? { ...node, position: savedPosition } : node;
    });
    setNodes(nextNodes);
    setEdges(rebuilt.edges);
  }, [rebuilt, setNodes, setEdges]);

  if (!workflow) {
    return <div className="flex flex-1 items-center justify-center text-sm text-muted">Workflow not found.</div>;
  }

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
