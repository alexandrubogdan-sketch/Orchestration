import { create } from "zustand";
import type {
  PaymentMethodType,
  Workflow,
  WorkflowAction,
  WorkflowCondition,
  WorkflowConditionBlock,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeKind,
  WorkflowSplitBranch,
  WorkflowState,
} from "./types";
import { defaultWorkflows } from "./mock-data";

function randomId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

export type NewNodeSeed =
  | { kind: "condition" }
  | { kind: "split" }
  | { kind: "action"; actionType: WorkflowAction["type"] };

interface WorkflowStoreState {
  workflows: Workflow[];

  relayoutRequests: Record<string, number>;

  createWorkflow: (paymentMethod: PaymentMethodType, name: string) => string;
  deleteWorkflow: (workflowId: string) => void;
  renameWorkflow: (workflowId: string, name: string) => void;
  togglePublish: (workflowId: string) => void;

  setWorkflowState: (workflowId: string, state: WorkflowState) => void;
  requestRelayout: (workflowId: string) => void;

  insertNode: (workflowId: string, anchorNodeId: string, handleId: string | undefined, seed: NewNodeSeed) => void;

  addFloatingNode: (workflowId: string, seed: NewNodeSeed) => string;
  duplicateNode: (workflowId: string, nodeId: string) => void;
  removeNode: (workflowId: string, nodeId: string) => void;

  removeEdge: (workflowId: string, edgeId: string) => void;

  connectNodes: (workflowId: string, source: string, sourceHandle: string | undefined, target: string) => void;

  updateAction: (workflowId: string, nodeId: string, patch: Partial<WorkflowAction>) => void;

  addConditionBlock: (workflowId: string, nodeId: string) => void;
  updateConditionBlock: (
    workflowId: string,
    nodeId: string,
    blockId: string,
    patch: { title?: string; condition?: Partial<WorkflowCondition> },
  ) => void;
  removeConditionBlock: (workflowId: string, nodeId: string, blockId: string) => void;

  addSplitBranch: (workflowId: string, nodeId: string) => void;
  updateSplitBranch: (workflowId: string, nodeId: string, branchId: string, patch: Partial<WorkflowSplitBranch>) => void;

  setSplitBranches: (workflowId: string, nodeId: string, branches: WorkflowSplitBranch[]) => void;
  removeSplitBranch: (workflowId: string, nodeId: string, branchId: string) => void;

  reset: () => void;
}

function mapWorkflows(
  workflows: Workflow[],
  workflowId: string,
  fn: (workflow: Workflow) => Workflow,
): Workflow[] {
  return workflows.map((w) => (w.id === workflowId ? fn(w) : w));
}

function mapNode(workflow: Workflow, nodeId: string, fn: (node: WorkflowNode) => WorkflowNode): Workflow {
  return {
    ...workflow,
    nodes: workflow.nodes.map((n) => (n.id === nodeId ? fn(n) : n)),
    updatedAt: new Date().toISOString(),
  };
}

function nodeKindFor(seed: NewNodeSeed): WorkflowNodeKind {
  return seed.kind;
}

function buildNode(seed: NewNodeSeed): Omit<WorkflowNode, "id"> {
  switch (seed.kind) {
    case "condition":
      return {
        kind: "condition",
        conditions: [
          { id: randomId("block"), title: "New condition", condition: defaultConditionFor() },
        ],
      };
    case "split":
      return {
        kind: "split",
        splits: [
          { id: randomId("branch"), label: "Branch A", value: 50 },
          { id: randomId("branch"), label: "Branch B", value: 50 },
        ],
      };
    case "action":
      return { kind: "action", action: defaultActionFor(seed.actionType) };
  }
}

export const useWorkflowStore = create<WorkflowStoreState>((set) => ({
  workflows: defaultWorkflows(),
  relayoutRequests: {},

  createWorkflow: (paymentMethod, name) => {
    const id = randomId("workflow");
    set((state) => ({
      workflows: [
        ...state.workflows,
        {
          id,
          name,
          paymentMethod,
          state: "draft",
          updatedAt: new Date().toISOString(),
          nodes: [{ id: randomId("node"), kind: "trigger", paymentMethod }],
          edges: [],
        },
      ],
    }));
    return id;
  },

  deleteWorkflow: (workflowId) =>
    set((state) => ({ workflows: state.workflows.filter((w) => w.id !== workflowId) })),

  renameWorkflow: (workflowId, name) =>
    set((state) => ({
      workflows: mapWorkflows(state.workflows, workflowId, (w) => ({ ...w, name })),
    })),

  togglePublish: (workflowId) =>
    set((state) => ({
      workflows: mapWorkflows(state.workflows, workflowId, (w) => ({
        ...w,
        state: w.state === "published" ? "draft" : "published",
        updatedAt: new Date().toISOString(),
      })),
    })),

  setWorkflowState: (workflowId, nextState) =>
    set((state) => ({
      workflows: mapWorkflows(state.workflows, workflowId, (w) => ({
        ...w,
        state: nextState,
        updatedAt: new Date().toISOString(),
      })),
    })),

  requestRelayout: (workflowId) =>
    set((state) => ({
      relayoutRequests: {
        ...state.relayoutRequests,
        [workflowId]: (state.relayoutRequests[workflowId] ?? 0) + 1,
      },
    })),

  insertNode: (workflowId, anchorNodeId, handleId, seed) =>
    set((state) => ({
      workflows: mapWorkflows(state.workflows, workflowId, (w) => {
        const newNodeId = randomId("node");
        const newNode: WorkflowNode = { id: newNodeId, ...buildNode(seed) };
        const newEdge: WorkflowEdge = {
          id: randomId("edge"),
          source: anchorNodeId,
          sourceHandle: handleId,
          target: newNodeId,
        };
        return {
          ...w,
          nodes: [...w.nodes, newNode],
          edges: [...w.edges, newEdge],
          updatedAt: new Date().toISOString(),
        };
      }),
    })),

  addFloatingNode: (workflowId, seed) => {
    const newNodeId = randomId("node");
    set((state) => ({
      workflows: mapWorkflows(state.workflows, workflowId, (w) => ({
        ...w,
        nodes: [...w.nodes, { id: newNodeId, ...buildNode(seed) }],
        updatedAt: new Date().toISOString(),
      })),
    }));
    return newNodeId;
  },

  duplicateNode: (workflowId, nodeId) =>
    set((state) => ({
      workflows: mapWorkflows(state.workflows, workflowId, (w) => {
        const node = w.nodes.find((n) => n.id === nodeId);
        if (!node || node.kind === "trigger") return w;

        const newNodeId = randomId("node");
        const cloned: WorkflowNode = structuredClone(node);
        cloned.id = newNodeId;

        if (cloned.conditions) {
          cloned.conditions = cloned.conditions.map((block) => ({ ...block, id: randomId("block") }));
        }
        if (cloned.splits) {
          cloned.splits = cloned.splits.map((branch) => ({ ...branch, id: randomId("branch") }));
        }

        return { ...w, nodes: [...w.nodes, cloned], updatedAt: new Date().toISOString() };
      }),
    })),

  removeNode: (workflowId, nodeId) =>
    set((state) => ({
      workflows: mapWorkflows(state.workflows, workflowId, (w) => ({
        ...w,

        nodes: w.nodes.filter((n, i) => i === 0 || n.id !== nodeId),
        edges: w.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
        updatedAt: new Date().toISOString(),
      })),
    })),

  removeEdge: (workflowId, edgeId) =>
    set((state) => ({
      workflows: mapWorkflows(state.workflows, workflowId, (w) => ({
        ...w,
        edges: w.edges.filter((e) => e.id !== edgeId),
        updatedAt: new Date().toISOString(),
      })),
    })),

  connectNodes: (workflowId, source, sourceHandle, target) =>
    set((state) => ({
      workflows: mapWorkflows(state.workflows, workflowId, (w) => {
        if (source === target) return w;
        const withoutStaleEdge = w.edges.filter(
          (e) => !(e.source === source && (e.sourceHandle ?? undefined) === (sourceHandle ?? undefined)),
        );
        return {
          ...w,
          edges: [...withoutStaleEdge, { id: randomId("edge"), source, sourceHandle, target }],
          updatedAt: new Date().toISOString(),
        };
      }),
    })),

  updateAction: (workflowId, nodeId, patch) =>
    set((state) => ({
      workflows: mapWorkflows(state.workflows, workflowId, (w) =>
        mapNode(w, nodeId, (n) => (n.action ? { ...n, action: { ...n.action, ...patch } } : n)),
      ),
    })),

  addConditionBlock: (workflowId, nodeId) =>
    set((state) => ({
      workflows: mapWorkflows(state.workflows, workflowId, (w) =>
        mapNode(w, nodeId, (n) => ({
          ...n,
          conditions: [
            ...(n.conditions ?? []),
            { id: randomId("block"), title: "New condition", condition: defaultConditionFor() },
          ],
        })),
      ),
    })),

  updateConditionBlock: (workflowId, nodeId, blockId, patch) =>
    set((state) => ({
      workflows: mapWorkflows(state.workflows, workflowId, (w) =>
        mapNode(w, nodeId, (n) => ({
          ...n,
          conditions: n.conditions?.map((block) =>
            block.id === blockId
              ? {
                  ...block,
                  ...(patch.title !== undefined ? { title: patch.title } : {}),
                  condition: patch.condition ? { ...block.condition, ...patch.condition } : block.condition,
                }
              : block,
          ),
        })),
      ),
    })),

  removeConditionBlock: (workflowId, nodeId, blockId) =>
    set((state) => ({
      workflows: mapWorkflows(state.workflows, workflowId, (w) => {
        const withoutBlock = mapNode(w, nodeId, (n) => ({
          ...n,
          conditions: n.conditions?.filter((block) => block.id !== blockId),
        }));

        return { ...withoutBlock, edges: withoutBlock.edges.filter((e) => e.sourceHandle !== blockId) };
      }),
    })),

  addSplitBranch: (workflowId, nodeId) =>
    set((state) => ({
      workflows: mapWorkflows(state.workflows, workflowId, (w) =>
        mapNode(w, nodeId, (n) => {
          const existing = n.splits ?? [];
          const branchLetter = String.fromCharCode(65 + existing.length);
          const evenShare = Math.floor(100 / (existing.length + 1));
          const rebalanced = existing.map((branch) => ({ ...branch, value: evenShare }));
          const remainder = 100 - evenShare * (existing.length + 1);
          return {
            ...n,
            splits: [
              ...rebalanced,
              { id: randomId("branch"), label: `Branch ${branchLetter}`, value: evenShare + remainder },
            ],
          };
        }),
      ),
    })),

  updateSplitBranch: (workflowId, nodeId, branchId, patch) =>
    set((state) => ({
      workflows: mapWorkflows(state.workflows, workflowId, (w) =>
        mapNode(w, nodeId, (n) => ({
          ...n,
          splits: n.splits?.map((branch) => (branch.id === branchId ? { ...branch, ...patch } : branch)),
        })),
      ),
    })),

  setSplitBranches: (workflowId, nodeId, branches) =>
    set((state) => ({
      workflows: mapWorkflows(state.workflows, workflowId, (w) => mapNode(w, nodeId, (n) => ({ ...n, splits: branches }))),
    })),

  removeSplitBranch: (workflowId, nodeId, branchId) =>
    set((state) => ({
      workflows: mapWorkflows(state.workflows, workflowId, (w) => {
        const withoutBranch = mapNode(w, nodeId, (n) => {
          const remaining = (n.splits ?? []).filter((branch) => branch.id !== branchId);
          if (remaining.length === 0) return { ...n, splits: remaining };

          const evenShare = Math.floor(100 / remaining.length);
          const remainder = 100 - evenShare * remaining.length;
          return {
            ...n,
            splits: remaining.map((branch, i) => ({
              ...branch,
              value: i === remaining.length - 1 ? evenShare + remainder : evenShare,
            })),
          };
        });
        return { ...withoutBranch, edges: withoutBranch.edges.filter((e) => e.sourceHandle !== branchId) };
      }),
    })),

  reset: () => set({ workflows: defaultWorkflows() }),
}));

export function defaultConditionFor(): WorkflowCondition {
  return { parameter: "currency", operator: "equals", value: "" };
}

export function defaultActionFor(type: WorkflowAction["type"]): WorkflowAction {
  switch (type) {
    case "authorize_payment":
      return {
        type,
        processor: "stripe",
        fallbackProcessor: "none",
        threeDsMode: "no_3ds",
        useCitProcessor: false,
      };
    case "settle_payment":
      return { type };
    case "block_payment":
      return { type };
    case "set_metadata":
      return { type, metadataKey: "", metadataValue: "", metadataDestination: "payment" };
    case "delay":
      return { type, delaySeconds: 60 };
  }
}

export { nodeKindFor };
export type { WorkflowConditionBlock, WorkflowSplitBranch };
