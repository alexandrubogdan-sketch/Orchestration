import ELK from "elkjs/lib/elk.bundled.js";
import type { Edge, Node } from "@xyflow/react";
import type { Workflow, WorkflowNodeKind } from "./types";

/**
 * Converts a workflow's node chain into a React Flow graph: one column,
 * top to bottom — trigger, then each condition/action node in order,
 * then a trailing "add node" placeholder. This is a deliberate
 * simplification of PayNext's actual canvas (arbitrary placement,
 * branching, AND/OR condition groups, a Split node) down to a single
 * linear chain — see the frontend README's "Known gaps" section.
 *
 * Edges are entirely derived from the node order, not user-drawn —
 * there is nothing to connect by hand; the "+" placeholder is the only
 * way to extend the chain, which keeps the canvas and the underlying
 * `workflows[].nodes` array always in sync.
 *
 * Positions are computed with elkjs's layered algorithm rather than a
 * hardcoded column/row grid. It's overkill for a single vertical chain
 * today, but it's the same approach reactflow.dev's auto-layout example
 * uses, keeps spacing consistent as node heights vary by kind, and gives
 * us a real layout engine to build on if branching/Split nodes land later.
 */

const elk = new ELK();

// Must stay in sync with the rendered node width (`w-80` = 320px) in
// components/workflow/nodes.tsx.
const NODE_WIDTH = 320;

// ELK needs concrete dimensions up front — it doesn't measure the DOM.
// These are rough estimates per node kind, tall enough to avoid visible
// overlap for the common case (trigger is short; condition/action cards
// carry a couple of form fields and run taller).
const NODE_HEIGHT_BY_KIND: Record<WorkflowNodeKind, number> = {
  trigger: 120,
  condition: 190,
  action: 220,
};
const ADD_NODE_HEIGHT = 56;

const ELK_LAYOUT_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "DOWN",
  "elk.layered.spacing.nodeNodeBetweenLayers": "80",
  "elk.spacing.nodeNode": "80",
};

export async function buildWorkflowGraph(
  workflow: Workflow,
): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  workflow.nodes.forEach((node, index) => {
    nodes.push({
      id: node.id,
      type: node.kind,
      position: { x: 0, y: 0 },
      data: { workflowId: workflow.id, node },
    });
    if (index > 0) {
      edges.push({
        id: `${workflow.nodes[index - 1]!.id}-${node.id}`,
        source: workflow.nodes[index - 1]!.id,
        target: node.id,
      });
    }
  });

  const lastNode = workflow.nodes[workflow.nodes.length - 1];
  let addNodeId: string | undefined;
  if (lastNode) {
    addNodeId = `${workflow.id}-add`;
    nodes.push({
      id: addNodeId,
      type: "addNode",
      position: { x: 0, y: 0 },
      data: { workflowId: workflow.id },
    });
    edges.push({ id: `${lastNode.id}-${addNodeId}`, source: lastNode.id, target: addNodeId });
  }

  const heightById = new Map<string, number>();
  workflow.nodes.forEach((node) => heightById.set(node.id, NODE_HEIGHT_BY_KIND[node.kind]));
  if (addNodeId) heightById.set(addNodeId, ADD_NODE_HEIGHT);

  const elkGraph = {
    id: "root",
    layoutOptions: ELK_LAYOUT_OPTIONS,
    children: nodes.map((node) => ({
      id: node.id,
      width: NODE_WIDTH,
      height: heightById.get(node.id) ?? NODE_HEIGHT_BY_KIND.action,
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    })),
  };

  const layout = await elk.layout(elkGraph);
  const positionById = new Map<string, { x: number; y: number }>();
  for (const child of layout.children ?? []) {
    if (typeof child.x === "number" && typeof child.y === "number") {
      positionById.set(child.id, { x: child.x, y: child.y });
    }
  }

  const laidOutNodes = nodes.map((node) => {
    const position = positionById.get(node.id);
    return position ? { ...node, position } : node;
  });

  return { nodes: laidOutNodes, edges };
}
