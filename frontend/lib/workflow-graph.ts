import ELK from "elkjs/lib/elk.bundled.js";
import type { Edge, Node } from "@xyflow/react";
import type { Workflow, WorkflowNode } from "./types";

const elk = new ELK();

const CARD_WIDTH = 232;

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

function sourcePortX(index: number, total: number, width: number): number {
  if (total <= 1) return width / 2;
  const contentWidth = total * BLOCK_WIDTH + (total - 1) * BLOCK_GAP;
  const leftPad = (width - contentWidth) / 2;
  return leftPad + index * (BLOCK_WIDTH + BLOCK_GAP) + BLOCK_WIDTH / 2;
}

export function buildEdges(workflow: Workflow): Edge[] {
  return workflow.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    sourceHandle: edge.sourceHandle,
    target: edge.target,

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
