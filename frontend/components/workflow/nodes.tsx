"use client";

import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { CreditCard, Trash2, GitBranch, Zap } from "lucide-react";
import { Select } from "@/components/ui/input";
import { NodePicker } from "@/components/workflow/node-picker";
import { defaultActionFor, defaultConditionFor, useWorkflowStore } from "@/lib/workflow-store";
import {
  PAYMENT_METHOD_LABELS,
  PROCESSOR_LABELS,
  PROCESSORS,
  THREE_DS_LABELS,
  THREE_DS_MODES,
  WORKFLOW_ACTION_LABELS,
  WORKFLOW_CONDITION_LABELS,
  WORKFLOW_CONDITION_PARAMETERS,
  WORKFLOW_OPERATORS,
  type PaymentMethodType,
  type WorkflowAction,
  type WorkflowCondition,
  type WorkflowNode as WorkflowNodeType,
} from "@/lib/types";

const cardClass =
  "w-80 rounded-xl border border-border bg-surface shadow-md overflow-hidden text-xs";
const headerClass =
  "flex items-center gap-1.5 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide";

export type WorkflowNodeData = { workflowId: string; node: WorkflowNodeType };
export type AddNodeData = { workflowId: string };

export function TriggerNodeView({ data }: NodeProps<Node<WorkflowNodeData>>) {
  const paymentMethod = data.node.paymentMethod as PaymentMethodType;
  return (
    <div className={cardClass}>
      <div className={`${headerClass} bg-accent/10 text-accent`}>
        <CreditCard className="h-3.5 w-3.5" />
        Payment Create
      </div>
      <div className="flex flex-col gap-1 p-3">
        <span className="text-muted">Payment method</span>
        <span className="text-sm font-medium">{PAYMENT_METHOD_LABELS[paymentMethod]}</span>
        <span className="text-[11px] text-muted">
          Every payment for this method starts here — this trigger can&apos;t be removed.
        </span>
      </div>
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

export function ConditionNodeView({ data }: NodeProps<Node<WorkflowNodeData>>) {
  const { workflowId, node } = data;
  const condition = node.condition as WorkflowCondition;
  const updateCondition = useWorkflowStore((s) => s.updateCondition);
  const removeNode = useWorkflowStore((s) => s.removeNode);

  return (
    <div className={cardClass}>
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <div className={`${headerClass} bg-info-bg text-info`}>
        <GitBranch className="h-3.5 w-3.5" />
        Condition
        <button
          onClick={() => removeNode(workflowId, node.id)}
          className="ml-auto text-muted hover:text-danger"
          title="Remove condition"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex flex-col gap-2 p-3">
        <label className="flex flex-col gap-1">
          <span className="text-muted">Parameter</span>
          <Select
            className="h-7 px-1.5 text-[11px]"
            value={condition.parameter}
            onChange={(e) =>
              updateCondition(workflowId, node.id, { parameter: e.target.value as never })
            }
          >
            {WORKFLOW_CONDITION_PARAMETERS.map((p) => (
              <option key={p} value={p}>
                {WORKFLOW_CONDITION_LABELS[p]}
              </option>
            ))}
          </Select>
        </label>

        {condition.parameter === "metadata" ? (
          <label className="flex flex-col gap-1">
            <span className="text-muted">Metadata key (dot notation)</span>
            <input
              className="h-7 rounded-lg border border-border px-1.5 text-[11px] outline-none focus:border-accent"
              value={condition.metadataKey ?? ""}
              placeholder="workflow.experiment_variant"
              onChange={(e) => updateCondition(workflowId, node.id, { metadataKey: e.target.value })}
            />
          </label>
        ) : null}

        <div className="flex items-center gap-1">
          <Select
            className="h-7 px-1.5 text-[11px]"
            value={condition.operator}
            onChange={(e) => updateCondition(workflowId, node.id, { operator: e.target.value as never })}
          >
            {WORKFLOW_OPERATORS.map((op) => (
              <option key={op} value={op}>
                {op.replace(/_/g, " ")}
              </option>
            ))}
          </Select>
          <input
            className="h-7 flex-1 rounded-lg border border-border px-1.5 text-[11px] outline-none focus:border-accent"
            value={condition.value}
            placeholder="value, e.g. US or USD"
            onChange={(e) => updateCondition(workflowId, node.id, { value: e.target.value })}
          />
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

export function ActionNodeView({ data }: NodeProps<Node<WorkflowNodeData>>) {
  const { workflowId, node } = data;
  const action = node.action as WorkflowAction;
  const updateAction = useWorkflowStore((s) => s.updateAction);
  const removeNode = useWorkflowStore((s) => s.removeNode);

  return (
    <div className={cardClass}>
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <div className={`${headerClass} bg-success-bg text-success`}>
        <Zap className="h-3.5 w-3.5" />
        {WORKFLOW_ACTION_LABELS[action.type]}
        <button
          onClick={() => removeNode(workflowId, node.id)}
          className="ml-auto text-muted hover:text-danger"
          title="Remove action"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex flex-col gap-2 p-3">
        {action.type === "authorize_payment" ? (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-muted">Processor</span>
              <Select
                className="h-7 px-1.5 text-[11px]"
                value={action.processor}
                onChange={(e) => updateAction(workflowId, node.id, { processor: e.target.value as never })}
              >
                {PROCESSORS.map((p) => (
                  <option key={p} value={p}>
                    {PROCESSOR_LABELS[p]}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted">Fallback processor</span>
              <Select
                className="h-7 px-1.5 text-[11px]"
                value={action.fallbackProcessor ?? "none"}
                onChange={(e) =>
                  updateAction(workflowId, node.id, { fallbackProcessor: e.target.value as never })
                }
              >
                <option value="none">None</option>
                {PROCESSORS.map((p) => (
                  <option key={p} value={p}>
                    {PROCESSOR_LABELS[p]}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted">3D Secure</span>
              <Select
                className="h-7 px-1.5 text-[11px]"
                value={action.threeDsMode}
                onChange={(e) =>
                  updateAction(workflowId, node.id, { threeDsMode: e.target.value as never })
                }
              >
                {THREE_DS_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {THREE_DS_LABELS[mode]}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex items-center gap-2 text-[11px]">
              <input
                type="checkbox"
                checked={action.useCitProcessor ?? false}
                onChange={(e) => updateAction(workflowId, node.id, { useCitProcessor: e.target.checked })}
              />
              Use CIT processor for MITs
            </label>
          </>
        ) : null}

        {action.type === "set_metadata" ? (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-muted">Key</span>
              <input
                className="h-7 rounded-lg border border-border px-1.5 text-[11px] outline-none focus:border-accent"
                value={action.metadataKey ?? ""}
                onChange={(e) => updateAction(workflowId, node.id, { metadataKey: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted">Value</span>
              <input
                className="h-7 rounded-lg border border-border px-1.5 text-[11px] outline-none focus:border-accent"
                value={action.metadataValue ?? ""}
                onChange={(e) => updateAction(workflowId, node.id, { metadataValue: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted">Destination</span>
              <Select
                className="h-7 px-1.5 text-[11px]"
                value={action.metadataDestination}
                onChange={(e) =>
                  updateAction(workflowId, node.id, { metadataDestination: e.target.value as never })
                }
              >
                <option value="payment">Payment</option>
                <option value="customer">Customer</option>
                <option value="both">Both</option>
              </Select>
            </label>
          </>
        ) : null}

        {action.type === "delay" ? (
          <label className="flex flex-col gap-1">
            <span className="text-muted">Delay (seconds)</span>
            <input
              type="number"
              min={0}
              className="h-7 rounded-lg border border-border px-1.5 text-[11px] outline-none focus:border-accent"
              value={action.delaySeconds ?? 0}
              onChange={(e) =>
                updateAction(workflowId, node.id, { delaySeconds: Number(e.target.value) })
              }
            />
          </label>
        ) : null}

        {action.type === "settle_payment" || action.type === "block_payment" ? (
          <span className="text-muted">No configuration needed.</span>
        ) : null}
      </div>
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

export function AddNodeView({ data }: NodeProps<Node<AddNodeData>>) {
  const { workflowId } = data;
  const addNode = useWorkflowStore((s) => s.addNode);

  return (
    <div className="flex w-80 justify-center">
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <NodePicker
        onPickCondition={(parameter) =>
          addNode(workflowId, { kind: "condition", condition: defaultConditionFor() && { ...defaultConditionFor(), parameter } })
        }
        onPickAction={(type) => addNode(workflowId, { kind: "action", action: defaultActionFor(type) })}
      />
    </div>
  );
}

export const NODE_TYPES = {
  trigger: TriggerNodeView,
  condition: ConditionNodeView,
  action: ActionNodeView,
  addNode: AddNodeView,
};
