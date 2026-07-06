import type { Edge, Node } from "@xyflow/react";
import type { Workflow } from "./types";

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
 */

const COLUMN_X = 60;
const ROW_HEIGHT = 190;

export function buildWorkflowGraph(workflow: Workflow): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  workflow.nodes.forEach((node, index) => {
    nodes.push({
      id: node.id,
      type: node.kind,
      position: { x: COLUMN_X, y: index * ROW_HEIGHT },
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
  if (lastNode) {
    const addNodeId = `${workflow.id}-add`;
    nodes.push({
      id: addNodeId,
      type: "addNode",
      position: { x: COLUMN_X, y: workflow.nodes.length * ROW_HEIGHT },
      data: { workflowId: workflow.id },
    });
    edges.push({ id: `${lastNode.id}-${addNodeId}`, source: lastNode.id, target: addNodeId });
  }

  return { nodes, edges };
}
