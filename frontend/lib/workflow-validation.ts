import type { Workflow } from "./types";

/**
 * A workflow is only "complete" once every path it can take ends in a
 * terminal action — Settle payment or Block payment. Those two action
 * types are the only node kind with zero outgoing slots (see nodes.tsx's
 * ActionNodeView, which renders no source handle at all for them, so
 * there's no way to continue the canvas past one), so checking that every
 * *other* slot across the graph already has an outgoing edge is enough:
 * any node/branch left unconnected is an unfinished path that doesn't end
 * in Settle/Block.
 *
 * Used by builder-toolbar.tsx to block "Save as draft"/"Publish" with an
 * error instead of silently persisting a dead-ended workflow.
 */
export function isWorkflowComplete(workflow: Workflow): boolean {
  const isConnected = (nodeId: string, handleId?: string) =>
    workflow.edges.some((e) => e.source === nodeId && (e.sourceHandle ?? undefined) === (handleId ?? undefined));

  return workflow.nodes.every((node) => {
    switch (node.kind) {
      case "trigger":
        return isConnected(node.id);
      case "condition":
        return (node.conditions ?? []).every((block) => isConnected(node.id, block.id));
      case "split":
        return (node.splits ?? []).every((branch) => isConnected(node.id, branch.id));
      case "action":
        if (!node.action) return true;
        if (node.action.type === "settle_payment" || node.action.type === "block_payment") return true;
        return isConnected(node.id);
      default:
        return true;
    }
  });
}

export const WORKFLOW_INCOMPLETE_MESSAGE =
  "This workflow is incomplete — every path must end in Settle payment or Block payment.";
