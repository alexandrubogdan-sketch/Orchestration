"use client";

import { useEffect, useRef, useState } from "react";
import { GitBranch, Plus, Zap } from "lucide-react";
import {
  WORKFLOW_ACTION_LABELS,
  WORKFLOW_ACTION_TYPES,
  WORKFLOW_CONDITION_LABELS,
  WORKFLOW_CONDITION_PARAMETERS,
  type WorkflowActionType,
  type WorkflowConditionParameter,
} from "@/lib/types";

/**
 * The single entry point for extending a workflow — clicking "+" offers
 * exactly two categories (Conditions, Actions), matching the simplified
 * brief: "only node available from scratch is Payment Create, from
 * there there's a plus and we select conditions/actions." Real PayNext
 * also offers a Split node; deliberately left out of this first pass
 * (see frontend README known gaps).
 */
export function NodePicker({
  onPickCondition,
  onPickAction,
}: {
  onPickCondition: (parameter: WorkflowConditionParameter) => void;
  onPickAction: (type: WorkflowActionType) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickAway(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickAway);
    return () => document.removeEventListener("mousedown", onClickAway);
  }, [open]);

  return (
    <div ref={ref} className="relative inline-block">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-dashed border-border bg-surface text-muted-foreground shadow-sm hover:border-accent hover:text-accent"
        title="Add a condition or action"
      >
        <Plus className="h-4 w-4" />
      </button>

      {open ? (
        <div className="absolute left-1/2 top-11 z-20 w-64 -translate-x-1/2 rounded-xl border border-border bg-surface p-2 text-xs shadow-xl">
          <div className="flex items-center gap-1.5 px-2 py-1 font-semibold uppercase tracking-wide text-muted-foreground">
            <GitBranch className="h-3 w-3" /> Conditions
          </div>
          {WORKFLOW_CONDITION_PARAMETERS.map((parameter) => (
            <button
              key={parameter}
              onClick={() => {
                onPickCondition(parameter);
                setOpen(false);
              }}
              className="flex w-full items-center rounded-lg px-2 py-1.5 text-left hover:bg-neutral-bg"
            >
              {WORKFLOW_CONDITION_LABELS[parameter]}
            </button>
          ))}

          <div className="mt-1 flex items-center gap-1.5 border-t border-border px-2 py-1 pt-2 font-semibold uppercase tracking-wide text-muted-foreground">
            <Zap className="h-3 w-3" /> Actions
          </div>
          {WORKFLOW_ACTION_TYPES.map((type) => (
            <button
              key={type}
              onClick={() => {
                onPickAction(type);
                setOpen(false);
              }}
              className="flex w-full items-center rounded-lg px-2 py-1.5 text-left hover:bg-neutral-bg"
            >
              {WORKFLOW_ACTION_LABELS[type]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
