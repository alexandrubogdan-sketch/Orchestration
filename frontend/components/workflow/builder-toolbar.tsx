"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PAYMENT_METHOD_LABELS } from "@/lib/types";
import { useWorkflowStore } from "@/lib/workflow-store";

export function BuilderToolbar({ workflowId }: { workflowId: string }) {
  const workflow = useWorkflowStore((s) => s.workflows.find((w) => w.id === workflowId));
  const setWorkflowState = useWorkflowStore((s) => s.setWorkflowState);
  const [jsonOpen, setJsonOpen] = useState(false);
  // Every edit already commits straight to the store (no separate
  // draft/dirty buffer), so "Save" here means "confirm the current state
  // as a draft/published snapshot" — this brief checkmark is the feedback
  // loop that mental model needs, since there's no unsaved-changes badge
  // to watch instead.
  const [savedLabel, setSavedLabel] = useState<string | null>(null);
  const savedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (savedTimeoutRef.current) clearTimeout(savedTimeoutRef.current);
    };
  }, []);

  if (!workflow) return null;

  function saveAs(label: string, state: "draft" | "published") {
    setWorkflowState(workflow!.id, state);
    setSavedLabel(label);
    if (savedTimeoutRef.current) clearTimeout(savedTimeoutRef.current);
    savedTimeoutRef.current = setTimeout(() => setSavedLabel(null), 1800);
  }

  return (
    <>
      <div className="flex items-center gap-3 border-b border-border bg-surface px-6 py-3">
        <Link href="/workflows" className="text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div>
          <div className="text-sm font-semibold">{workflow.name}</div>
          <div className="text-xs text-muted-foreground">{PAYMENT_METHOD_LABELS[workflow.paymentMethod]}</div>
        </div>
        <Badge tone={workflow.state === "published" ? "success" : "neutral"}>{workflow.state}</Badge>

        {savedLabel ? (
          <span className="flex items-center gap-1 text-xs font-medium text-success">
            <Check className="h-3.5 w-3.5" /> {savedLabel}
          </span>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => saveAs("Saved as draft", "draft")}>
            Save as draft
          </Button>
          <Button size="sm" onClick={() => saveAs("Published", "published")}>
            Publish
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setJsonOpen(true)}>
            <Download className="h-3.5 w-3.5" /> Export config
          </Button>
        </div>
      </div>
      {jsonOpen ? <ExportPanel json={JSON.stringify(workflow, null, 2)} onClose={() => setJsonOpen(false)} /> : null}
    </>
  );
}

function ExportPanel({ json, onClose }: { json: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-8">
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-surface shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold">Workflow configuration (JSON)</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <pre className="flex-1 overflow-auto bg-neutral-bg p-5 font-mono text-xs leading-relaxed">
          {json}
        </pre>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(json)}>
            Copy to clipboard
          </Button>
          <Button size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
