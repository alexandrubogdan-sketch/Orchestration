import ELK from "elkjs/lib/elk.bundled.js";
import type { Edge, Node } from "@xyflow/react";
import type { Workflow, WorkflowNode } from "./types";

/**
 * Converts a workflow's real node graph (`nodes[]` + `edges[]`) into a
 * React Flow graph — matching the real client's own canvas exactly: a
 * Condition node's blocks and a Split node's branches can each route
 * to a different downstream node (via `edge.sourceHandle`), not just
 * a single linear chain. This replaces the earlier "array order
 * implies a chain, plus a trailing addNode placeholder" model — there
 * is no addNode node type anymore; extending the canvas happens via
 * each node's own hover "+" handles (components/workflow/add-handle.tsx)
 * or by dragging a card in from the sidebar palette
 * (components/workflow/canvas-sidebar.tsx), exactly like the real
 * client.
 *
 * Positions are computed with elkjs's layered algorithm (same library
 * the real client's own workflow-layout.service.ts wraps dagre with —
 * elk's layered algorithm is the direct equivalent) rather than a
 * hardcoded grid, since the graph can now genuinely branch and merge.
 */

const elk = new ELK();

// Base card width, matching the real client's compact ~224px cards
// (see components/workflow/nodes.tsx's CARD_WIDTH) rather than this
// demo's old full-width 320px inline-config cards.
const CARD_WIDTH = 232;
// Condition/Split cards grow wider as blocks/branches are added — same
// per-block sizing the real client uses (190-195px per block + gap),
// scaled down slightly to match CARD_WIDTH's own proportions.
const BLOCK_WIDTH = 168;
const BLOCK_GAP = 8;
const CARD_PADDING_X = 24;

function widthForNode(node: WorkflowNode): number {
  const blockCount = node.conditions?.length ?? node.splits?.length ?? 0;
  if (blockCount === 0) return CARD_WIDTH;
  const blocksWidth = blockCount * BLOCK_WIDTH + (blockCount - 1) * BLOCK_GAP + CARD_PADDING_X;
  return Math.max(CARD_WIDTH, blocksWidth);
}

function heightForNode(node: WorkflowNode): number {
  switch (node.kind) {
    case "trigger":
      return 92;
    case "condition":
      return 118;
    case "split":
      return 108;
    case "action":
      switch (node.action?.type) {
        case "authorize_payment":
          return 150;
        case "set_metadata":
          return 130;
        case "delay":
          return 96;
        default:
          // settle_payment / block_payment — header only, no content,
          // matching the real client's payment-capture/payment-decline
          // cards (getNodeBaseSizes: height 41-ish once scaled to our
          // header size).
          return 52;
      }
  }
}

const ELK_LAYOUT_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "DOWN",
  "elk.layered.spacing.nodeNodeBetweenLayers": "70",
  "elk.spacing.nodeNode": "60",
};

export async function buildWorkflowGraph(
  workflow: Workflow,
): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const nodes: Node[] = workflow.nodes.map((node) => ({
    id: node.id,
    type: node.kind,
    position: { x: 0, y: 0 },
    data: { workflowId: workflow.id, node },
  }));

  const edges: Edge[] = workflow.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    sourceHandle: edge.sourceHandle,
    target: edge.target,
    // The real client's CanvasEdgeComponent draws its path with
    // `getBezierPath` (a true bezier curve), not an orthogonal
    // smoothstep — "default" is React Flow's built-in bezier edge
    // type, which renders the same rounded/curved line instead of the
    // squared-off right-angle look "smoothstep" produced.
    type: "default",
    animated: true,
  }));

  const elkGraph = {
    id: "root",
    layoutOptions: ELK_LAYOUT_OPTIONS,
    children: workflow.nodes.map((node) => ({
      id: node.id,
      width: widthForNode(node),
      height: heightForNode(node),
    })),
    edges: workflow.edges.map((edge) => ({
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
