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

/**
 * A Condition/Split card renders one real Handle per block/branch, laid
 * out left-to-right in a fixed visual order (nodes.tsx). Left as a single
 * unlabeled port per node (the old behavior), elk has no idea "EU issuers"
 * exits from the left half of the card and "Rest of world" from the right
 * half — it collapses every outgoing edge from a node onto one point, so
 * its own crossing-minimization pass can't tell that swapping two sibling
 * nodes below would actually uncross the lines. Declaring one elk port per
 * handle, positioned at that handle's real x offset, fixes that: elk can
 * now see which child is wired to the left port vs. the right port and
 * reorder siblings within a layer to avoid the crossing, exactly like the
 * real client's own dagre layout keeps handle identity per edge.
 */
function sourceHandleIds(node: WorkflowNode): (string | undefined)[] {
  if (node.kind === "condition") return (node.conditions ?? []).map((b) => b.id);
  if (node.kind === "split") return (node.splits ?? []).map((b) => b.id);
  if (node.kind === "trigger") return [undefined];
  if (node.kind === "action" && node.action?.type !== "settle_payment" && node.action?.type !== "block_payment") {
    return [undefined];
  }
  return [];
}

function sourcePortId(nodeId: string, handleId?: string): string {
  return handleId ? `${nodeId}__src__${handleId}` : `${nodeId}__src`;
}

function targetPortId(nodeId: string): string {
  return `${nodeId}__tgt`;
}

/** x offset (from the node's left edge) of a block/branch's own handle —
 *  mirrors nodes.tsx's block layout (BLOCK_WIDTH-wide cards, BLOCK_GAP
 *  apart, centered as a group inside the card) closely enough for elk's
 *  ordering purposes; a plain trigger/action node has just the one
 *  centered handle. */
function sourcePortX(index: number, total: number, width: number): number {
  if (total <= 1) return width / 2;
  const contentWidth = total * BLOCK_WIDTH + (total - 1) * BLOCK_GAP;
  const leftPad = (width - contentWidth) / 2;
  return leftPad + index * (BLOCK_WIDTH + BLOCK_GAP) + BLOCK_WIDTH / 2;
}

/** Shared by the elk-laid-out path below and canvas.tsx's own
 *  no-relayout sync path, so both ever describe "workflowEdge" the same
 *  way in exactly one place. */
export function buildEdges(workflow: Workflow): Edge[] {
  return workflow.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    sourceHandle: edge.sourceHandle,
    target: edge.target,
    // "workflowEdge" (components/workflow/canvas-edge.tsx) draws the
    // same bezier curve React Flow's built-in "default" type would
    // (via getBezierPath, matching the real client's
    // CanvasEdgeComponent) but adds a hover-only "×" to delete the
    // connection.
    type: "workflowEdge",
    animated: true,
    data: { workflowId: workflow.id },
  }));
}

export async function buildWorkflowGraph(
  workflow: Workflow,
): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const nodes: Node[] = workflow.nodes.map((node) => ({
    id: node.id,
    type: node.kind,
    position: { x: 0, y: 0 },
    data: { workflowId: workflow.id, node },
  }));

  const edges: Edge[] = buildEdges(workflow);

  const elkGraph = {
    id: "root",
    layoutOptions: ELK_LAYOUT_OPTIONS,
    children: workflow.nodes.map((node) => {
      const width = widthForNode(node);
      const height = heightForNode(node);
      const handleIds = sourceHandleIds(node);
      return {
        id: node.id,
        width,
        height,
        // FIXED_POS pins every port at the exact offset we hand it —
        // matching nodes.tsx's real handle positions is what lets elk's
        // crossing minimization reorder sibling nodes correctly (see the
        // doc comment above sourceHandleIds).
        layoutOptions: { "elk.portConstraints": "FIXED_POS" },
        ports: [
          { id: targetPortId(node.id), x: width / 2, y: 0, width: 1, height: 1, layoutOptions: { "elk.port.side": "NORTH" } },
          ...handleIds.map((handleId, i) => ({
            id: sourcePortId(node.id, handleId),
            x: sourcePortX(i, handleIds.length, width),
            y: height,
            width: 1,
            height: 1,
            layoutOptions: { "elk.port.side": "SOUTH" },
          })),
        ],
      };
    }),
    edges: workflow.edges.map((edge) => ({
      id: edge.id,
      sources: [sourcePortId(edge.source, edge.sourceHandle)],
      targets: [targetPortId(edge.target)],
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
