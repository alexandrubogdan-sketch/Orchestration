import { create } from "zustand";
import type {
  PaymentMethodType,
  Workflow,
  WorkflowAction,
  WorkflowCondition,
  WorkflowNode,
  WorkflowState,
} from "./types";
import { defaultWorkflows } from "./mock-data";

function randomId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

interface WorkflowStoreState {
  workflows: Workflow[];
  /** Bumped per-workflow by requestRelayout — WorkflowCanvas watches this
   *  to know when to discard manually-dragged node positions and re-run
   *  the ELK auto-layout from scratch ("Rearrange" button). */
  relayoutRequests: Record<string, number>;

  createWorkflow: (paymentMethod: PaymentMethodType, name: string) => string;
  deleteWorkflow: (workflowId: string) => void;
  renameWorkflow: (workflowId: string, name: string) => void;
  togglePublish: (workflowId: string) => void;
  /** Explicit draft/published set, for the toolbar's "Save as Draft" /
   *  "Publish" buttons — separate from togglePublish so each button has
   *  an unambiguous outcome regardless of current state. */
  setWorkflowState: (workflowId: string, state: WorkflowState) => void;
  requestRelayout: (workflowId: string) => void;

  /** Appends a new node to the end of the chain (after the current last node). */
  addNode: (workflowId: string, node: Omit<WorkflowNode, "id">) => void;
  updateCondition: (workflowId: string, nodeId: string, patch: Partial<WorkflowCondition>) => void;
  updateAction: (workflowId: string, nodeId: string, patch: Partial<WorkflowAction>) => void;
  removeNode: (workflowId: string, nodeId: string) => void;

  reset: () => void;
}

function mapWorkflows(
  workflows: Workflow[],
  workflowId: string,
  fn: (workflow: Workflow) => Workflow,
): Workflow[] {
  return workflows.map((w) => (w.id === workflowId ? fn(w) : w));
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

  addNode: (workflowId, node) =>
    set((state) => ({
      workflows: mapWorkflows(state.workflows, workflowId, (w) => ({
        ...w,
        nodes: [...w.nodes, { ...node, id: randomId("node") }],
        updatedAt: new Date().toISOString(),
      })),
    })),

  updateCondition: (workflowId, nodeId, patch) =>
    set((state) => ({
      workflows: mapWorkflows(state.workflows, workflowId, (w) => ({
        ...w,
        nodes: w.nodes.map((n) =>
          n.id === nodeId && n.condition ? { ...n, condition: { ...n.condition, ...patch } } : n,
        ),
        updatedAt: new Date().toISOString(),
      })),
    })),

  updateAction: (workflowId, nodeId, patch) =>
    set((state) => ({
      workflows: mapWorkflows(state.workflows, workflowId, (w) => ({
        ...w,
        nodes: w.nodes.map((n) =>
          n.id === nodeId && n.action ? { ...n, action: { ...n.action, ...patch } } : n,
        ),
        updatedAt: new Date().toISOString(),
      })),
    })),

  removeNode: (workflowId, nodeId) =>
    set((state) => ({
      workflows: mapWorkflows(state.workflows, workflowId, (w) => ({
        ...w,
        // The trigger node (nodes[0]) can never be removed — every
        // workflow starts from exactly one payment-method trigger,
        // matching PayNext's "each trigger is tied to a payment method"
        // rule (docs.paynext.com/guides/platform/workflows).
        nodes: w.nodes.filter((n, i) => i === 0 || n.id !== nodeId),
        updatedAt: new Date().toISOString(),
      })),
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
