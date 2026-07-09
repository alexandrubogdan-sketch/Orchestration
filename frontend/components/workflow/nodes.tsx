"use client";

import { useState } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import {
  Ban,
  ClockPlus,
  Copy,
  CreditCard,
  FileCog,
  GitBranch,
  Hash,
  Pencil,
  Play,
  Plus,
  ShieldCheck,
  Split as SplitIcon,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AddHandleComponent } from "@/components/workflow/add-handle";
import { ActionModal } from "@/components/workflow/modals/action-modal";
import { ConditionBlockModal } from "@/components/workflow/modals/condition-block-modal";
import { SplitModal } from "@/components/workflow/modals/split-modal";
import { useWorkflowStore, type NewNodeSeed } from "@/lib/workflow-store";
import {
  PAYMENT_METHOD_LABELS,
  PROCESSOR_LABELS,
  THREE_DS_LABELS,
  WORKFLOW_ACTION_LABELS,
  WORKFLOW_CONDITION_LABELS,
  type PaymentMethodType,
  type WorkflowAction,
  type WorkflowNode as WorkflowNodeType,
} from "@/lib/types";

/**
 * Node cards rebuilt to match the real client's canvas 1:1
 * (components/workflow/element/canvas/element/node in
 * AlphaPayments-client): a compact card — icon + title header, a "⋯"
 * popover for Configure/Duplicate/Delete — with config living behind
 * a modal instead of inline form fields, plus hover "+" handles
 * (AddHandleComponent) to insert the next node without leaving the
 * canvas. Condition and Split nodes render their branches as small
 * sub-blocks inside the same card, each with its own outgoing handle,
 * matching split-node-content.component.tsx / condition-node-content.
 * component.tsx exactly.
 *
 * Keep CARD_WIDTH/BLOCK_WIDTH in sync with lib/workflow-graph.ts,
 * which lays the graph out against these same numbers.
 */
const CARD_WIDTH = 232;
const BLOCK_WIDTH = 168;

export type WorkflowNodeData = { workflowId: string; node: WorkflowNodeType };

function useEdges(workflowId: string) {
  return useWorkflowStore((s) => s.workflows.find((w) => w.id === workflowId)?.edges ?? []);
}

function isConnected(edges: { source: string; sourceHandle?: string; target: string }[], nodeId: string, handleId?: string) {
  return edges.some((e) => e.source === nodeId && (e.sourceHandle ?? undefined) === (handleId ?? undefined));
}

const cardClass = (selected: boolean) =>
  cn(
    "overflow-hidden rounded-lg border bg-card text-xs shadow-sm transition-shadow",
    "hover:shadow-md",
    selected
      ? "border-primary ring-2 ring-primary ring-offset-2 ring-offset-background shadow-lg"
      : "border-border",
  );

const headerClass = "flex items-center gap-2 px-3 py-2 border-b border-border";

function NodeMenu({
  onDuplicate,
  onDelete,
  onConfigure,
  configureLabel = "Configure",
}: {
  onDuplicate?: () => void;
  onDelete?: () => void;
  onConfigure?: () => void;
  configureLabel?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="ml-auto rounded-md p-0.5 text-muted-foreground hover:bg-neutral-bg hover:text-foreground">
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor">
            <circle cx="8" cy="3" r="1.4" />
            <circle cx="8" cy="8" r="1.4" />
            <circle cx="8" cy="13" r="1.4" />
          </svg>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {onConfigure ? (
          <DropdownMenuItem onClick={onConfigure} className="gap-2">
            <FileCog className="h-3.5 w-3.5" /> {configureLabel}
          </DropdownMenuItem>
        ) : null}
        {onDuplicate ? (
          <DropdownMenuItem onClick={onDuplicate} className="gap-2">
            <Copy className="h-3.5 w-3.5" /> Duplicate
          </DropdownMenuItem>
        ) : null}
        {onDelete ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onDelete} className="gap-2 text-danger focus:text-danger">
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TriggerNodeView({ data, selected }: NodeProps<Node<WorkflowNodeData>>) {
  const { workflowId, node } = data;
  const edges = useEdges(workflowId);
  const paymentMethod = node.paymentMethod as PaymentMethodType;
  const insertNode = useWorkflowStore((s) => s.insertNode);

  return (
    <div className={cardClass(selected)} style={{ width: CARD_WIDTH }}>
      <div className={cn(headerClass, "bg-primary/5")}>
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Play className="h-3 w-3" />
        </span>
        <span className="text-[11px] font-semibold">Payment Create</span>
        <span className="ml-auto rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-primary">
          Start
        </span>
      </div>
      <div className="flex flex-col gap-0.5 p-2.5">
        <span className="text-muted-foreground">Payment method</span>
        <span className="text-[13px] font-medium text-foreground">{PAYMENT_METHOD_LABELS[paymentMethod]}</span>
      </div>
      <AddHandleComponent
        type="source"
        position={Position.Bottom}
        isConnectable
        showButton={!isConnected(edges, node.id)}
        onInsert={(seed: NewNodeSeed) => insertNode(workflowId, node.id, undefined, seed)}
      />
    </div>
  );
}

export function ConditionNodeView({ data, selected }: NodeProps<Node<WorkflowNodeData>>) {
  const { workflowId, node } = data;
  const edges = useEdges(workflowId);
  const insertNode = useWorkflowStore((s) => s.insertNode);
  const addConditionBlock = useWorkflowStore((s) => s.addConditionBlock);
  const removeConditionBlock = useWorkflowStore((s) => s.removeConditionBlock);
  const updateConditionBlock = useWorkflowStore((s) => s.updateConditionBlock);
  const duplicateNode = useWorkflowStore((s) => s.duplicateNode);
  const removeNode = useWorkflowStore((s) => s.removeNode);
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);

  const blocks = node.conditions ?? [];
  const width = Math.max(CARD_WIDTH, blocks.length * BLOCK_WIDTH + (blocks.length - 1) * 8 + 24);
  const editingBlock = blocks.find((b) => b.id === editingBlockId);

  return (
    <div className={cardClass(selected)} style={{ width }}>
      <Handle type="target" position={Position.Top} className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-background !bg-muted-foreground/60" />
      <div className={cn(headerClass, "bg-info-bg/40")}>
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-info-bg text-info">
          <GitBranch className="h-3 w-3" />
        </span>
        <span className="text-[11px] font-semibold">Condition</span>
        <NodeMenu onDuplicate={() => duplicateNode(workflowId, node.id)} onDelete={() => removeNode(workflowId, node.id)} />
      </div>

      <div className="flex items-start gap-2 p-2.5">
        {blocks.map((block, i) => (
          <div key={block.id} className="flex items-center gap-1.5">
            <div
              className="relative flex flex-col gap-1 rounded-md border border-border bg-neutral-bg px-2 py-1.5"
              style={{ width: BLOCK_WIDTH }}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="truncate text-[11px] font-medium">{block.title}</span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="rounded p-0.5 text-muted-foreground hover:bg-card hover:text-foreground">
                      <Pencil className="h-3 w-3" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-36">
                    <DropdownMenuItem onClick={() => setEditingBlockId(block.id)} className="gap-2">
                      <Pencil className="h-3.5 w-3.5" /> Edit
                    </DropdownMenuItem>
                    {blocks.length > 1 ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={() => removeConditionBlock(workflowId, node.id, block.id)}
                          className="gap-2 text-danger focus:text-danger"
                        >
                          <Trash2 className="h-3.5 w-3.5" /> Delete
                        </DropdownMenuItem>
                      </>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <span className="truncate text-[10px] text-muted-foreground">
                {WORKFLOW_CONDITION_LABELS[block.condition.parameter]} {block.condition.operator.replace(/_/g, " ")}{" "}
                {block.condition.value || "—"}
              </span>

              <AddHandleComponent
                type="source"
                position={Position.Bottom}
                id={block.id}
                isConnectable
                showButton={!isConnected(edges, node.id, block.id)}
                onInsert={(seed: NewNodeSeed) => insertNode(workflowId, node.id, block.id, seed)}
                style={{ position: "absolute", left: "50%", bottom: -5, transform: "translateX(-50%)" }}
              />
            </div>

            {i === blocks.length - 1 ? (
              <button
                type="button"
                onClick={() => addConditionBlock(workflowId, node.id)}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground hover:border-accent-foreground hover:text-accent-foreground"
                title="Add another condition block"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        ))}
      </div>

      {editingBlock ? (
        <ConditionBlockModal
          block={editingBlock}
          onSave={(patch) => updateConditionBlock(workflowId, node.id, editingBlock.id, patch)}
          onClose={() => setEditingBlockId(null)}
        />
      ) : null}
    </div>
  );
}

export function SplitNodeView({ data, selected }: NodeProps<Node<WorkflowNodeData>>) {
  const { workflowId, node } = data;
  const edges = useEdges(workflowId);
  const insertNode = useWorkflowStore((s) => s.insertNode);
  const setSplitBranches = useWorkflowStore((s) => s.setSplitBranches);
  const duplicateNode = useWorkflowStore((s) => s.duplicateNode);
  const removeNode = useWorkflowStore((s) => s.removeNode);
  const [configuring, setConfiguring] = useState(false);

  const branches = node.splits ?? [];
  const width = Math.max(CARD_WIDTH, branches.length * BLOCK_WIDTH + (branches.length - 1) * 8 + 24);

  return (
    <div className={cardClass(selected)} style={{ width }}>
      <Handle type="target" position={Position.Top} className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-background !bg-muted-foreground/60" />
      <div className={cn(headerClass, "bg-info-bg/40")}>
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-info-bg text-info">
          <SplitIcon className="h-3 w-3" />
        </span>
        <span className="text-[11px] font-semibold">Split</span>
        <NodeMenu
          onConfigure={() => setConfiguring(true)}
          onDuplicate={() => duplicateNode(workflowId, node.id)}
          onDelete={() => removeNode(workflowId, node.id)}
        />
      </div>

      <div className="flex gap-2 p-2.5">
        {branches.map((branch) => (
          <div
            key={branch.id}
            className="relative flex flex-col gap-1 rounded-md border border-border bg-neutral-bg px-2 py-1.5"
            style={{ width: BLOCK_WIDTH }}
          >
            <div className="flex items-center justify-between gap-1">
              <span className="truncate text-[11px] font-medium">{branch.label}</span>
              <span className="text-[11px] font-semibold text-info">{branch.value}%</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
              <div className="h-full rounded-full bg-info" style={{ width: `${branch.value}%` }} />
            </div>

            <AddHandleComponent
              type="source"
              position={Position.Bottom}
              id={branch.id}
              isConnectable
              showButton={!isConnected(edges, node.id, branch.id)}
              onInsert={(seed: NewNodeSeed) => insertNode(workflowId, node.id, branch.id, seed)}
              style={{ position: "absolute", left: "50%", bottom: -5, transform: "translateX(-50%)" }}
            />
          </div>
        ))}
      </div>

      {configuring ? (
        <SplitModal
          branches={branches}
          onSave={(next) => setSplitBranches(workflowId, node.id, next)}
          onClose={() => setConfiguring(false)}
        />
      ) : null}
    </div>
  );
}

const ACTION_ICON: Record<WorkflowAction["type"], React.ReactNode> = {
  authorize_payment: <ShieldCheck className="h-3 w-3" />,
  settle_payment: <CreditCard className="h-3 w-3" />,
  block_payment: <Ban className="h-3 w-3" />,
  set_metadata: <Hash className="h-3 w-3" />,
  delay: <ClockPlus className="h-3 w-3" />,
};

const ACTION_TONE: Record<WorkflowAction["type"], "success" | "danger" | "neutral"> = {
  authorize_payment: "success",
  settle_payment: "success",
  block_payment: "danger",
  set_metadata: "neutral",
  delay: "neutral",
};

function actionSummary(action: WorkflowAction): string | null {
  switch (action.type) {
    case "authorize_payment":
      return `${PROCESSOR_LABELS[action.processor ?? "stripe"]} · ${THREE_DS_LABELS[action.threeDsMode ?? "no_3ds"]}`;
    case "set_metadata":
      return action.metadataKey ? `${action.metadataKey} = ${action.metadataValue || "—"}` : "No key set yet";
    case "delay":
      return `${action.delaySeconds ?? 0}s`;
    default:
      return null;
  }
}

export function ActionNodeView({ data, selected }: NodeProps<Node<WorkflowNodeData>>) {
  const { workflowId, node } = data;
  const edges = useEdges(workflowId);
  const action = node.action as WorkflowAction;
  const insertNode = useWorkflowStore((s) => s.insertNode);
  const updateAction = useWorkflowStore((s) => s.updateAction);
  const duplicateNode = useWorkflowStore((s) => s.duplicateNode);
  const removeNode = useWorkflowStore((s) => s.removeNode);
  const [configuring, setConfiguring] = useState(false);

  const tone = ACTION_TONE[action.type];
  const summary = actionSummary(action);

  return (
    <div className={cardClass(selected)} style={{ width: CARD_WIDTH }}>
      <Handle type="target" position={Position.Top} className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-background !bg-muted-foreground/60" />
      <div
        className={cn(
          headerClass,
          tone === "success" && "bg-success-bg/40",
          tone === "danger" && "bg-danger-bg/40",
          tone === "neutral" && "bg-neutral-bg",
        )}
      >
        <span
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded-md",
            tone === "success" && "bg-success-bg text-success",
            tone === "danger" && "bg-danger-bg text-danger",
            tone === "neutral" && "bg-border text-foreground",
          )}
        >
          {ACTION_ICON[action.type]}
        </span>
        <span className="truncate text-[11px] font-semibold">{WORKFLOW_ACTION_LABELS[action.type]}</span>
        <NodeMenu
          onConfigure={() => setConfiguring(true)}
          onDuplicate={() => duplicateNode(workflowId, node.id)}
          onDelete={() => removeNode(workflowId, node.id)}
        />
      </div>

      {summary ? <div className="px-2.5 py-2 text-[11px] text-muted-foreground">{summary}</div> : null}

      <AddHandleComponent
        type="source"
        position={Position.Bottom}
        isConnectable
        showButton={!isConnected(edges, node.id)}
        onInsert={(seed: NewNodeSeed) => insertNode(workflowId, node.id, undefined, seed)}
      />

      {configuring ? (
        <ActionModal
          action={action}
          onSave={(patch) => updateAction(workflowId, node.id, patch)}
          onClose={() => setConfiguring(false)}
        />
      ) : null}
    </div>
  );
}

export const NODE_TYPES = {
  trigger: TriggerNodeView,
  condition: ConditionNodeView,
  split: SplitNodeView,
  action: ActionNodeView,
};
