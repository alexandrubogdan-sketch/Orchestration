import type { Workflow } from "./types";

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
